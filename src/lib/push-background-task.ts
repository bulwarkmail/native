import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules } from 'react-native';
import { jmapClient } from '../api/jmap-client';
import { getEmails, getMailboxes, queryEmails } from '../api/email';
import {
  generateEmailAvatarColor,
  getEmailInitials,
  getFaviconDomain,
  getFaviconUrl,
} from './avatar-utils';
import {
  deviceClientIdKey,
  lastNotifiedKey,
  migrateLegacyPushKeys,
  readPushAccountIds,
} from './push-notifications';

// Mirrors STORAGE_KEY in `stores/settings-store.ts`. The headless task can't
// import the Zustand store (would pull in React) so we read AsyncStorage
// directly. Keep this in sync if the store key ever changes.
const SETTINGS_STORAGE_KEY = 'webmail:settings:v1';
// Mirrors the persist name in `stores/account-store.ts`. We use it to find
// the user's active account at the end of the headless task so we can leave
// the jmapClient singleton in a state consistent with what the UI expects
// when the app resumes.
const ACCOUNT_REGISTRY_KEY = 'account-registry';

interface PushPersistedSettings {
  emailNotificationsEnabled?: boolean;
}

async function emailNotificationsAllowed(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return true; // first launch: default to on
    const parsed = JSON.parse(raw) as PushPersistedSettings;
    return parsed.emailNotificationsEnabled !== false;
  } catch {
    return true;
  }
}

interface ShowNotificationOptions {
  notificationId: string;
  title: string;
  body: string;
  initials: string;
  bgColorHex: string;
  iconUrl?: string;
  emailId: string;
  threadId: string;
  subject?: string;
  accountId: string;
}

interface BulwarkFcmNative {
  showNotification(opts: ShowNotificationOptions): Promise<void>;
}

// The relay forwards each JMAP push to FCM tagged with the deviceClientId it
// received the push on (the URL slot from createPushSubscription). The exact
// key the relay uses isn't part of any client-controlled contract, so rather
// than guessing a field name we scan all string values in the data payload
// and look for one that matches a deviceClientId we've registered locally.
// Returns null if nothing matches (e.g. legacy relay payload format) so the
// caller falls back to iterating every known account.
async function identifyAccountFromFcmData(
  data: unknown,
  accountIds: string[],
): Promise<string | null> {
  if (!data || typeof data !== 'object') return null;

  const reverseMap = new Map<string, string>();
  for (const accountId of accountIds) {
    const dcid = await AsyncStorage.getItem(deviceClientIdKey(accountId));
    if (dcid) reverseMap.set(dcid, accountId);
  }
  if (reverseMap.size === 0) return null;

  for (const value of Object.values(data as Record<string, unknown>)) {
    if (typeof value === 'string') {
      const match = reverseMap.get(value);
      if (match) return match;
    }
  }
  return null;
}

// Read the persisted active account directly from AsyncStorage (Zustand's
// persist middleware stores the JSON-serialised state under its `name`).
async function readActiveAccountId(): Promise<string | null> {
  try {
    const raw = await AsyncStorage.getItem(ACCOUNT_REGISTRY_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { state?: { activeAccountId?: string | null } };
    return parsed.state?.activeAccountId ?? null;
  } catch {
    return null;
  }
}

// Fired by BulwarkPushTaskService when a data FCM message arrives. Runs in a
// short-lived headless JS runtime - keep it fast, catch all errors, and always
// resolve so the native service can release its wake lock.
export async function pushBackgroundTask(data: unknown): Promise<void> {
  let activeAccountId: string | null = null;
  try {
    if (!(await emailNotificationsAllowed())) return;

    await migrateLegacyPushKeys();

    const accountIds = await readPushAccountIds();
    if (accountIds.length === 0) return;

    activeAccountId = await readActiveAccountId();

    const matched = await identifyAccountFromFcmData(data, accountIds);
    const accountsToCheck = matched ? [matched] : accountIds;

    for (const accountId of accountsToCheck) {
      try {
        await processAccountForPush(accountId);
      } catch (err) {
        console.warn(
          '[push] background check failed for account',
          accountId,
          err instanceof Error ? err.message : err,
        );
      }
    }
  } catch (error) {
    console.warn(
      '[push] background task failed:',
      error instanceof Error ? error.message : error,
    );
  } finally {
    // Leave the singleton bound to the user's active account so the UI sees
    // a consistent jmapClient state when the app resumes. Without this, the
    // last account processed above would remain loaded and the UI's cached
    // email-store data would not match what the next JMAP request returns.
    if (activeAccountId) {
      await jmapClient.loadAccount(activeAccountId).catch(() => undefined);
    }
  }
}

async function processAccountForPush(accountId: string): Promise<void> {
  const loaded = await jmapClient.loadAccount(accountId);
  if (!loaded) return;

  const mailboxes = await getMailboxes();
  const inbox = mailboxes.find((m) => m.role === 'inbox');
  if (!inbox) return;

  const { ids } = await queryEmails(inbox.id, {
    filter: { notKeyword: '$seen' },
    limit: 1,
  });
  if (ids.length === 0) return;

  const emailId = ids[0];
  const lastKey = lastNotifiedKey(accountId);
  const previouslyNotified = await AsyncStorage.getItem(lastKey);
  if (previouslyNotified === emailId) return;

  const [email] = await getEmails([emailId]);
  if (!email) return;

  const from = email.from?.[0];
  const name = from?.name ?? '';
  const address = from?.email ?? '';
  const title = name || address || 'New mail';
  const body = email.subject || '(no subject)';
  const initials = getEmailInitials(name, address);
  const bgColorHex = hslToHex(generateEmailAvatarColor(name, address));
  const faviconDomain = getFaviconDomain(address);
  const iconUrl = faviconDomain ? getFaviconUrl(faviconDomain) : undefined;

  const native = NativeModules.BulwarkFcm as BulwarkFcmNative | undefined;
  if (!native?.showNotification) return;

  await native.showNotification({
    notificationId: `mail:${emailId}`,
    title,
    body,
    initials,
    bgColorHex,
    iconUrl,
    emailId,
    threadId: email.threadId,
    subject: email.subject ?? undefined,
    accountId,
  });

  await AsyncStorage.setItem(lastKey, emailId);
}

function hslToHex(hsl: string): string {
  const match = hsl.match(/hsl\(\s*(\d+)\s*,\s*(\d+)%\s*,\s*(\d+)%\s*\)/);
  if (!match) return '#2563eb';
  const h = Number(match[1]);
  const s = Number(match[2]) / 100;
  const l = Number(match[3]) / 100;
  const a = s * Math.min(l, 1 - l);
  const component = (n: number): string => {
    const k = (n + h / 30) % 12;
    const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(255 * c).toString(16).padStart(2, '0');
  };
  return `#${component(0)}${component(8)}${component(4)}`;
}
