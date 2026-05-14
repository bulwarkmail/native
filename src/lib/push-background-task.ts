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

const PUSH_ACCOUNT_ID_KEY = 'push:accountId:v1';
const LAST_NOTIFIED_EMAIL_ID_KEY = 'push:lastNotifiedEmailId:v1';
// Mirrors STORAGE_KEY in `stores/settings-store.ts`. The headless task can't
// import the Zustand store (would pull in React) so we read AsyncStorage
// directly. Keep this in sync if the store key ever changes.
const SETTINGS_STORAGE_KEY = 'webmail:settings:v1';

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

// Fired by BulwarkPushTaskService when a data FCM message arrives. Runs in a
// short-lived headless JS runtime - keep it fast, catch all errors, and always
// resolve so the native service can release its wake lock.
export async function pushBackgroundTask(_data: unknown): Promise<void> {
  try {
    if (!(await emailNotificationsAllowed())) return;

    const accountId = await AsyncStorage.getItem(PUSH_ACCOUNT_ID_KEY);
    if (!accountId) return;

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
    const previouslyNotified = await AsyncStorage.getItem(LAST_NOTIFIED_EMAIL_ID_KEY);
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

    await AsyncStorage.setItem(LAST_NOTIFIED_EMAIL_ID_KEY, emailId);
  } catch (error) {
    console.warn(
      '[push] background task failed:',
      error instanceof Error ? error.message : error,
    );
  }
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
