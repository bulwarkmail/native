import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules } from 'react-native';
import { jmapClient, type StoredCredentials } from '../api/jmap-client';
import { CAPABILITIES } from '../api/types';
import type { Email, JMAPMethodCall, JMAPSession, Mailbox } from '../api/types';
import { detectDeviceLocale, isSupportedLocale, translate, type LocaleCode } from '../i18n';
import { secureFetch } from './client-cert';
import { refreshOAuthAccessToken, type OAuthTokens } from './oauth';
import {
  generateEmailAvatarColor,
  getEmailInitials,
  getFaviconDomain,
  getFaviconUrl,
} from './avatar-utils';
import {
  lastNotifiedKey,
  migrateLegacyPushKeys,
  notifiedIdsKey,
  readPushAccountIds,
  readPushJmapAccountIds,
} from './push-notifications';

// Mirrors STORAGE_KEY in `stores/settings-store.ts`. The headless task can't
// import the Zustand store (would pull in React) so we read AsyncStorage
// directly. Keep this in sync if the store key ever changes.
const SETTINGS_STORAGE_KEY = 'webmail:settings:v1';
// Mirrors STORAGE_KEY in `stores/locale-store.ts`, for the same reason.
const LOCALE_STORAGE_KEY = 'webmail:locale:v1';
// Mirrors the persist name in `stores/account-store.ts`. Used to map the
// relay's `accountLabel` (= username) back to a local account when the JMAP
// account id is not known yet.
const ACCOUNT_REGISTRY_KEY = 'account-registry';

// How many recently-notified ids to remember per account. Enough to cover a
// burst of deliveries without growing the AsyncStorage record unbounded.
const NOTIFIED_IDS_LIMIT = 200;
// Legacy state-change payloads carry no ids; look at this many newest unread
// inbox messages and notify the ones we have not shown yet.
const LEGACY_QUERY_LIMIT = 5;
const TOKEN_REFRESH_LEEWAY_MS = 60_000;

const EMAIL_PROPERTIES = [
  'id', 'threadId', 'mailboxIds', 'keywords', 'size', 'receivedAt', 'from', 'subject', 'preview',
];

interface PushPersistedSettings {
  emailNotificationsEnabled?: boolean;
  senderFavicons?: boolean;
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

// The "Sender Favicons" setting covers notification icons as well as the
// in-app avatars: with it off the tray shows initials, and the sender's domain
// and the device's IP never reach the icon service. Off when unreadable.
export async function senderFaviconsAllowed(): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return true; // first launch: the store's default is on
    const parsed = JSON.parse(raw) as PushPersistedSettings;
    return parsed.senderFavicons !== false;
  } catch {
    return false;
  }
}

/** The app's language: the in-app override, else the device's. */
export async function notificationLocale(): Promise<LocaleCode> {
  try {
    const raw = await AsyncStorage.getItem(LOCALE_STORAGE_KEY);
    const override = raw ? (JSON.parse(raw) as { override?: unknown }).override : null;
    if (typeof override === 'string' && isSupportedLocale(override)) return override;
  } catch { /* the device language it is */ }
  return detectDeviceLocale();
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
  // The JMAP account the message lives in - a group or shared mailbox's
  // account rather than the user's own - so a tap opens it there.
  jmapAccountId: string;
  // Android notification group: one per account so the tray bundles
  // several deliveries under a "+N more" summary instead of stacking them.
  groupKey: string;
  groupTitle: string;
}

interface BulwarkFcmNative {
  showNotification(opts: ShowNotificationOptions): Promise<void>;
}

/**
 * What the relay puts in the FCM data payload (repos/relay/src/fcm.ts). All
 * values are strings; `emailIds` and `changed` are JSON-encoded.
 */
export interface RelayPushData {
  kind: 'jmap-email-push' | 'jmap-state-change' | null;
  accountLabel: string | null;
  // JMAP primary account id the push was generated for.
  jmapAccountId: string | null;
  emailIds: string[];
  changed: Record<string, Record<string, string>> | null;
}

export function parseRelayPushData(data: unknown): RelayPushData {
  const out: RelayPushData = {
    kind: null,
    accountLabel: null,
    jmapAccountId: null,
    emailIds: [],
    changed: null,
  };
  if (!data || typeof data !== 'object') return out;
  const d = data as Record<string, unknown>;
  if (d.kind === 'jmap-email-push' || d.kind === 'jmap-state-change') out.kind = d.kind;
  if (typeof d.accountLabel === 'string' && d.accountLabel) out.accountLabel = d.accountLabel;
  if (typeof d.accountId === 'string' && d.accountId) out.jmapAccountId = d.accountId;
  if (typeof d.emailIds === 'string') {
    try {
      const parsed = JSON.parse(d.emailIds) as unknown;
      if (Array.isArray(parsed)) {
        out.emailIds = parsed.filter((id): id is string => typeof id === 'string' && id.length > 0);
      }
    } catch {
      // malformed - treat as no ids
    }
  } else if (Array.isArray(d.emailIds)) {
    out.emailIds = d.emailIds.filter((id): id is string => typeof id === 'string' && id.length > 0);
  }
  if (typeof d.changed === 'string') {
    try {
      const parsed = JSON.parse(d.changed) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.changed = parsed as Record<string, Record<string, string>>;
      }
    } catch {
      // ignore
    }
  } else if (d.changed && typeof d.changed === 'object') {
    out.changed = d.changed as Record<string, Record<string, string>>;
  }
  // Older relays only sent `changed`; the account id is its first key.
  if (!out.jmapAccountId && out.changed) {
    out.jmapAccountId = Object.keys(out.changed)[0] ?? null;
  }
  return out;
}

interface RegistryAccount {
  id: string;
  username?: string;
}

async function readAccountRegistry(): Promise<RegistryAccount[]> {
  try {
    const raw = await AsyncStorage.getItem(ACCOUNT_REGISTRY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { state?: { accounts?: RegistryAccount[] } };
    return Array.isArray(parsed.state?.accounts) ? parsed.state!.accounts! : [];
  } catch {
    return [];
  }
}

/**
 * Pick the local account(s) a relay payload belongs to. Primary key is the
 * JMAP account id recorded at setup; the relay's `accountLabel` (= username)
 * is a weaker fallback. When neither matches - a payload from a build that
 * predates the id map - every registered account is checked.
 */
export function matchAccountsForPush(
  payload: RelayPushData,
  pushAccountIds: string[],
  jmapAccountIds: Record<string, string>,
  registry: RegistryAccount[],
): string[] {
  if (payload.jmapAccountId) {
    const byJmapId = pushAccountIds.filter((id) => jmapAccountIds[id] === payload.jmapAccountId);
    if (byJmapId.length > 0) return byJmapId;
  }
  if (payload.accountLabel) {
    const label = payload.accountLabel.toLowerCase();
    const byLabel = pushAccountIds.filter((id) => {
      const entry = registry.find((a) => a.id === id);
      const username = entry?.username?.toLowerCase();
      return username === label || id.toLowerCase().startsWith(`${label}@`);
    });
    if (byLabel.length > 0) return byLabel;
  }
  return pushAccountIds;
}

async function readNotifiedIds(accountId: string): Promise<string[]> {
  try {
    const raw = await AsyncStorage.getItem(notifiedIdsKey(accountId));
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) return parsed.filter((s): s is string => typeof s === 'string');
    }
  } catch {
    // fall through
  }
  // Pre-ring builds stored a single id; honour it so the upgrade does not
  // re-notify the newest message.
  const legacy = await AsyncStorage.getItem(lastNotifiedKey(accountId));
  return legacy ? [legacy] : [];
}

async function rememberNotifiedIds(accountId: string, ids: string[]): Promise<void> {
  const current = await readNotifiedIds(accountId);
  const next = [...ids, ...current.filter((id) => !ids.includes(id))].slice(0, NOTIFIED_IDS_LIMIT);
  await AsyncStorage.setItem(notifiedIdsKey(accountId), JSON.stringify(next));
  if (ids.length > 0) await AsyncStorage.setItem(lastNotifiedKey(accountId), ids[0]);
}

// ─── Detached JMAP access ───────────────────────────────
// The headless task may run inside the live RN instance (app foregrounded a
// moment ago) where the UI is using the singleton jmapClient. Re-binding the
// singleton to another account mid-flight sends UI requests with the wrong
// credentials, so every request here goes through its own session fetched
// from the account's stored credentials - same pattern as api/unified-inbox.

interface DetachedSession {
  apiUrl: string;
  authHeader: string;
  jmapAccountId: string;
}

function authHeaderFor(creds: StoredCredentials): string {
  if (creds.accessToken) return `Bearer ${creds.accessToken}`;
  return `Basic ${btoa(`${creds.username}:${creds.password}`)}`;
}

function originOf(url: string): string | null {
  const m = url.match(/^(https?:\/\/[^/?#]+)/i);
  return m ? m[1] : null;
}

// Same intent as JMAPClient.rewriteSessionUrls: point the advertised apiUrl at
// the origin we actually connected to (servers often self-report unreachable
// container-internal hosts).
function rewriteApiUrl(session: JMAPSession, serverUrl: string): string {
  const serverOrigin = originOf(serverUrl);
  const apiOrigin = originOf(session.apiUrl);
  if (!apiOrigin || !serverOrigin || apiOrigin === serverOrigin) return session.apiUrl;
  return serverOrigin + session.apiUrl.slice(apiOrigin.length);
}

async function ensureFreshCredentials(
  accountId: string,
  creds: StoredCredentials,
): Promise<StoredCredentials> {
  if (
    !creds.accessToken || !creds.refreshToken || !creds.tokenEndpoint
    || !creds.clientId || creds.expiresAt == null
  ) {
    return creds;
  }
  if (creds.expiresAt - Date.now() > TOKEN_REFRESH_LEEWAY_MS) return creds;
  try {
    const tokens: OAuthTokens = {
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt,
      tokenEndpoint: creds.tokenEndpoint,
      clientId: creds.clientId,
    };
    const next = await refreshOAuthAccessToken(tokens);
    const updated: StoredCredentials = {
      ...creds,
      accessToken: next.accessToken,
      refreshToken: next.refreshToken ?? creds.refreshToken,
      expiresAt: next.expiresAt,
      tokenEndpoint: next.tokenEndpoint,
      clientId: next.clientId,
    };
    const current = await jmapClient.getStoredCredentials(accountId);
    if (!current || current.accessToken !== updated.accessToken) {
      await jmapClient.setStoredCredentials(accountId, updated);
    }
    return updated;
  } catch {
    return creds;
  }
}

async function openDetachedSession(accountId: string): Promise<DetachedSession | null> {
  let creds = await jmapClient.getStoredCredentials(accountId);
  if (!creds) return null;
  creds = await ensureFreshCredentials(accountId, creds);
  const baseUrl = creds.serverUrl.replace(/\/+$/, '');
  const authHeader = authHeaderFor(creds);
  const res = await secureFetch(`${baseUrl}/.well-known/jmap`, {
    headers: { Authorization: authHeader, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Session discovery failed: ${res.status}`);
  const session = (await res.json()) as JMAPSession;
  const jmapAccountId =
    session.primaryAccounts?.[CAPABILITIES.MAIL]
    || session.primaryAccounts?.[CAPABILITIES.CORE]
    || Object.keys(session.accounts ?? {})[0]
    || null;
  if (!jmapAccountId) return null;
  return { apiUrl: rewriteApiUrl(session, baseUrl), authHeader, jmapAccountId };
}

async function jmapPost(
  session: DetachedSession,
  methodCalls: JMAPMethodCall[],
): Promise<Array<[string, Record<string, any>, string]>> {
  const response = await secureFetch(session.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: session.authHeader },
    body: JSON.stringify({ using: [CAPABILITIES.CORE, CAPABILITIES.MAIL], methodCalls }),
  });
  if (!response.ok) throw new Error(`JMAP request failed: ${response.status}`);
  const body = await response.json();
  return body.methodResponses ?? [];
}

async function detachedGetEmails(
  session: DetachedSession,
  accountId: string,
  ids: string[],
): Promise<Email[]> {
  const responses = await jmapPost(session, [
    ['Email/get', { accountId, ids, properties: EMAIL_PROPERTIES }, '0'],
  ]);
  const [name, body] = responses[0] ?? [];
  if (name !== 'Email/get') return [];
  return (body.list as Email[]) ?? [];
}

async function detachedNewestUnreadInboxIds(
  session: DetachedSession,
  limit: number,
): Promise<string[]> {
  const accountId = session.jmapAccountId;
  const mailboxResponses = await jmapPost(session, [
    ['Mailbox/get', { accountId, properties: ['id', 'role'] }, '0'],
  ]);
  const [mbName, mbBody] = mailboxResponses[0] ?? [];
  if (mbName !== 'Mailbox/get') return [];
  const inbox = ((mbBody.list as Mailbox[]) ?? []).find((m) => m.role === 'inbox');
  if (!inbox) return [];
  const queryResponses = await jmapPost(session, [
    [
      'Email/query',
      {
        accountId,
        filter: { inMailbox: inbox.id, notKeyword: '$seen' },
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit,
      },
      '0',
    ],
  ]);
  const [qName, qBody] = queryResponses[0] ?? [];
  if (qName !== 'Email/query') return [];
  return (qBody.ids as string[]) ?? [];
}

// Fired by BulwarkPushTaskService when a data FCM message arrives. Runs in a
// short-lived headless JS runtime - keep it fast, catch all errors, and always
// resolve so the native service can release its wake lock. Never touches the
// singleton jmapClient's session (see "Detached JMAP access" above).
export async function pushBackgroundTask(data: unknown): Promise<void> {
  try {
    if (!(await emailNotificationsAllowed())) return;

    await migrateLegacyPushKeys();

    const accountIds = await readPushAccountIds();
    if (accountIds.length === 0) return;

    const registry = await readAccountRegistry();
    const payload = parseRelayPushData(data);
    const jmapAccountIds = await readPushJmapAccountIds();
    const accountsToCheck = matchAccountsForPush(payload, accountIds, jmapAccountIds, registry);

    for (const accountId of accountsToCheck) {
      try {
        await processAccountForPush(accountId, payload);
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
  }
}

/** Messages worth a notification: unread, not junk, not shown before. */
export function selectNotifiableEmails(emails: Email[], alreadyNotified: readonly string[]): Email[] {
  const seen = new Set(alreadyNotified);
  return emails.filter((email) => {
    if (!email?.id || seen.has(email.id)) return false;
    const keywords = email.keywords ?? {};
    if (keywords.$seen || keywords.$junk) return false;
    return true;
  });
}

async function processAccountForPush(accountId: string, payload: RelayPushData): Promise<void> {
  const session = await openDetachedSession(accountId);
  if (!session) return;

  const alreadyNotified = await readNotifiedIds(accountId);
  let candidates: Email[];
  let emailAccountId = session.jmapAccountId;

  if (payload.emailIds.length > 0) {
    // EmailPush (or a relay that forwards ids): fetch exactly the delivered
    // messages. The push may concern a shared account the user has access
    // to, in which case the ids live under that JMAP account.
    const fresh = payload.emailIds.filter((id) => !alreadyNotified.includes(id));
    if (fresh.length === 0) return;
    emailAccountId = payload.jmapAccountId ?? session.jmapAccountId;
    candidates = await detachedGetEmails(session, emailAccountId, fresh);
  } else {
    // Legacy `jmap-state-change` payload without ids: look at the newest
    // unread inbox messages and notify the ones not shown before. The ring
    // of notified ids (rather than a single "last" id) is what keeps a
    // message read elsewhere from surfacing the next older one.
    const ids = await detachedNewestUnreadInboxIds(session, LEGACY_QUERY_LIMIT);
    const fresh = ids.filter((id) => !alreadyNotified.includes(id));
    if (fresh.length === 0) return;
    candidates = await detachedGetEmails(session, session.jmapAccountId, fresh);
  }

  const toNotify = selectNotifiableEmails(candidates, alreadyNotified);
  if (toNotify.length === 0) return;

  const native = NativeModules.BulwarkFcm as BulwarkFcmNative | undefined;
  if (!native?.showNotification) return;

  const groupKey = `bulwark-mail:${accountId}`;
  const groupTitle = payload.accountLabel ?? accountId.split('@')[0] ?? accountId;
  const favicons = await senderFaviconsAllowed();
  const locale = await notificationLocale();

  // Oldest first so the newest ends up on top of the tray.
  const ordered = [...toNotify].sort(
    (a, b) => new Date(a.receivedAt ?? 0).getTime() - new Date(b.receivedAt ?? 0).getTime(),
  );
  for (const email of ordered) {
    const from = email.from?.[0];
    const name = from?.name ?? '';
    const address = from?.email ?? '';
    const title = name || address || 'New mail';
    const body = email.subject || translate(locale, 'email_viewer.no_subject', '(No Subject)');
    const initials = getEmailInitials(name, address);
    const bgColorHex = hslToHex(generateEmailAvatarColor(name, address));
    const faviconDomain = favicons ? getFaviconDomain(address) : null;
    const iconUrl = faviconDomain ? getFaviconUrl(faviconDomain) : undefined;

    await native.showNotification({
      notificationId: `mail:${email.id}`,
      title,
      body,
      initials,
      bgColorHex,
      iconUrl,
      emailId: email.id,
      threadId: email.threadId,
      subject: email.subject ?? undefined,
      accountId,
      jmapAccountId: emailAccountId,
      groupKey,
      groupTitle,
    });
  }

  await rememberNotifiedIds(accountId, ordered.map((e) => e.id).reverse());
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
