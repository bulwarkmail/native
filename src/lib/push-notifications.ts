import { NativeEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createPushSubscription,
  destroyPushSubscription,
  listPushSubscriptions,
  updatePushSubscription,
  verifyPushSubscription,
} from '../api/push';
import { getMailboxes, getSharedMailboxes } from '../api/email';
import { loadedMailboxes } from './mailbox-source';
import { jmapClient, JMAPClient } from '../api/jmap-client';
import { isJMAPSetError, JMAPMethodError, requireMethodResult } from '../api/jmap-result';
import { CAPABILITIES } from '../api/types';
import type { EmailPushConfig, JMAPAccountInfo, JMAPSession, Mailbox, PushSubscription } from '../api/types';
import { generateAccountId } from './account-utils';
import {
  EMPTY_NOTIFICATION_MUTES,
  isAccountMuted,
  isMailboxMuted,
  mailboxOverridesForAccount,
  type NotificationMutes,
} from './notification-mutes';
import { useSettingsStore } from '../stores/settings-store';
import { t } from '../stores/locale-store';
import {
  authorityOfType,
  DEVICE_SYNC_STORAGE_KEY,
  deviceSyncPushTypes,
  persistedAccounts,
} from '../device-sync/app/prefs';
import { CALENDAR_AUTHORITY, CONTACTS_AUTHORITY, type Authority } from '../device-sync/types';
import * as Notifications from 'expo-notifications';
import { credentialsKey } from '../api/jmap-client';
import { apnsEnvironment, removeIosPushAccount, writeIosPushAccount } from './ios-push-shared';
import {
  getUnifiedPushDistributors,
  getUnifiedPushEndpoint,
  isUnifiedPushSupported,
  registerUnifiedPush,
  unregisterUnifiedPush,
  UnifiedPushRegisterError,
  type UnifiedPushEndpoint,
} from './unified-push';

// Persist identifiers across launches so we reuse the same JMAP subscription
// after app restarts. Each account gets its own deviceClientId so the hosted
// relay can distinguish per-account pushes via the URL slot it forwards.
const RELAY_BASE_URL_KEY = 'push:relayBaseUrl:v1';
// Which transport carries pushes to this device: FCM (default) or a
// UnifiedPush distributor. Device-wide, like the relay URL.
const PUSH_TRANSPORT_KEY = 'push:transport:v1';
const PUSH_ACCOUNT_IDS_KEY = 'push:accountIds:v1';
// Local account id (username@host) → JMAP primary account id. The relay tags
// every forwarded push with the JMAP account id it came from, which is the
// only reliable key for routing a payload to the right local account.
const PUSH_JMAP_ACCOUNT_IDS_KEY = 'push:jmapAccountIds:v1';
const DEVICE_CLIENT_ID_PREFIX = 'push:deviceClientId:v2:';
const SUBSCRIPTION_ID_PREFIX = 'push:subscriptionId:v2:';
export const LAST_NOTIFIED_EMAIL_ID_PREFIX = 'push:lastNotifiedEmailId:v2:';
// Ring of recently notified message ids per account (replaces the single
// lastNotified id, which could not tell "already shown" from "older mail").
const NOTIFIED_IDS_PREFIX = 'push:notifiedIds:v1:';
const PROMPT_DISMISSED_PREFIX = 'push:promptDismissed:v1:';
// JMAP account ids the server refused in this account's emailPush map (see
// emailPushFallbacks). Left out of the map from then on, so a refusal isn't
// re-provoked on every launch.
const EMAIL_PUSH_REFUSED_PREFIX = 'push:emailPushRefused:v1:';
// When the recorded subscription expires, as the server last reported it. Lets
// the launch-time resync tell a subscription that lapsed (re-create it) from
// one that was revoked (leave push off). Forgotten when the server behind the
// account is replaced, which loses every subscription (forgetPushServerState).
const SUBSCRIPTION_EXPIRES_PREFIX = 'push:subscriptionExpires:v1:';
// Set when the user turned push off for the account - the settings toggle, or
// revoking this device here or from elsewhere. The launch-time resync leaves
// such an account alone until push is enabled for it again.
const OPTED_OUT_PREFIX = 'push:optedOut:v1:';

// Legacy single-account keys (pre-multi-account). Migrated lazily on the next
// setupPushNotifications / pushBackgroundTask call, then deleted.
const LEGACY_DEVICE_CLIENT_ID_KEY = 'push:deviceClientId:v1';
const LEGACY_SUBSCRIPTION_ID_KEY = 'push:subscriptionId:v1';
const LEGACY_PUSH_ACCOUNT_ID_KEY = 'push:accountId:v1';
const LEGACY_LAST_NOTIFIED_EMAIL_ID_KEY = 'push:lastNotifiedEmailId:v1';

export function deviceClientIdKey(accountId: string): string {
  return DEVICE_CLIENT_ID_PREFIX + accountId;
}

function subscriptionIdKey(accountId: string): string {
  return SUBSCRIPTION_ID_PREFIX + accountId;
}

export function lastNotifiedKey(accountId: string): string {
  return LAST_NOTIFIED_EMAIL_ID_PREFIX + accountId;
}

export function notifiedIdsKey(accountId: string): string {
  return NOTIFIED_IDS_PREFIX + accountId;
}

function promptDismissedKey(accountId: string): string {
  return PROMPT_DISMISSED_PREFIX + accountId;
}

function emailPushRefusedKey(accountId: string): string {
  return EMAIL_PUSH_REFUSED_PREFIX + accountId;
}

function subscriptionExpiresKey(accountId: string): string {
  return SUBSCRIPTION_EXPIRES_PREFIX + accountId;
}

function optedOutKey(accountId: string): string {
  return OPTED_OUT_PREFIX + accountId;
}

export async function readPushAccountIds(): Promise<string[]> {
  const raw = await AsyncStorage.getItem(PUSH_ACCOUNT_IDS_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string');
  } catch {
    return [];
  }
}

async function writePushAccountIds(ids: string[]): Promise<void> {
  const deduped = Array.from(new Set(ids));
  if (deduped.length === 0) {
    await AsyncStorage.removeItem(PUSH_ACCOUNT_IDS_KEY);
  } else {
    await AsyncStorage.setItem(PUSH_ACCOUNT_IDS_KEY, JSON.stringify(deduped));
  }
}

/** Local account id → JMAP primary account id, for every account with push. */
export async function readPushJmapAccountIds(): Promise<Record<string, string>> {
  const raw = await AsyncStorage.getItem(PUSH_JMAP_ACCOUNT_IDS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

async function writePushJmapAccountId(accountId: string, jmapAccountId: string | null): Promise<void> {
  const map = await readPushJmapAccountIds();
  if (jmapAccountId) map[accountId] = jmapAccountId;
  else delete map[accountId];
  if (Object.keys(map).length === 0) {
    await AsyncStorage.removeItem(PUSH_JMAP_ACCOUNT_IDS_KEY);
  } else {
    await AsyncStorage.setItem(PUSH_JMAP_ACCOUNT_IDS_KEY, JSON.stringify(map));
  }
}

// One-shot migration from the pre-multi-account schema. If the legacy
// PUSH_ACCOUNT_ID_KEY exists, treat that account as the only pre-existing
// setup: reuse the legacy deviceClientId and JMAP subscription id under
// the new per-account keys so the user doesn't lose push on upgrade.
export async function migrateLegacyPushKeys(): Promise<void> {
  const legacyAccountId = await AsyncStorage.getItem(LEGACY_PUSH_ACCOUNT_ID_KEY);
  if (!legacyAccountId) return;

  const legacyDcid = await AsyncStorage.getItem(LEGACY_DEVICE_CLIENT_ID_KEY);
  const legacySubId = await AsyncStorage.getItem(LEGACY_SUBSCRIPTION_ID_KEY);
  const legacyLastId = await AsyncStorage.getItem(LEGACY_LAST_NOTIFIED_EMAIL_ID_KEY);

  if (legacyDcid) {
    await AsyncStorage.setItem(deviceClientIdKey(legacyAccountId), legacyDcid);
  }
  if (legacySubId) {
    await AsyncStorage.setItem(subscriptionIdKey(legacyAccountId), legacySubId);
  }
  if (legacyLastId) {
    await AsyncStorage.setItem(lastNotifiedKey(legacyAccountId), legacyLastId);
  }

  const ids = await readPushAccountIds();
  if (!ids.includes(legacyAccountId)) {
    await writePushAccountIds([...ids, legacyAccountId]);
  }

  await AsyncStorage.multiRemove([
    LEGACY_PUSH_ACCOUNT_ID_KEY,
    LEGACY_DEVICE_CLIENT_ID_KEY,
    LEGACY_SUBSCRIPTION_ID_KEY,
    LEGACY_LAST_NOTIFIED_EMAIL_ID_KEY,
  ]);
}

// Hosted relay so users don't need to run their own Firebase project. The
// relay only ever sees FCM tokens + JMAP state-id hashes - no mail content.
// Power users can override this from the settings screen.
export const DEFAULT_RELAY_BASE_URL = 'https://notifications.relay.bulwarkmail.org';

/**
 * A relay must be reachable over TLS: the registration carries the FCM token
 * and the JMAP server posts push bodies to it. Plain http is only allowed for
 * loopback / the Android emulator host so a local relay can be developed
 * against.
 */
export function isValidRelayUrl(value: string): boolean {
  const trimmed = value.trim();
  const m = /^(https?):\/\/([^/?#:]+)(?::\d{1,5})?(?:[/?#].*)?$/i.exec(trimmed);
  if (!m) return false;
  if (m[1].toLowerCase() === 'https') return true;
  const host = m[2].toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '10.0.2.2';
}

// Only `EmailDelivery` state-changes when new mail is actually delivered.
// `Email` fires for any mutation (sending, drafting, moving, marking read,
// deleting) and `Mailbox` fires for mailbox edits - both produced spurious
// system notifications, so we keep them out of the push subscription.
// In-app sync uses the separate SSE channel and is unaffected.
export const PUSH_TYPES = ['EmailDelivery'] as const;

// The capability a server advertises for the data types of an authority.
const DEVICE_SYNC_CAPABILITIES: Record<Authority, string> = {
  [CONTACTS_AUTHORITY]: CAPABILITIES.CONTACTS,
  [CALENDAR_AUTHORITY]: CAPABILITIES.CALENDARS,
};

/**
 * The push types of one account's subscription: `EmailDelivery`, plus the
 * contact and calendar types while the account syncs them to the device
 * (#34, docs/device-sync.md "Triggers"): the native push router turns those
 * into device syncs, and a push carrying only them never notifies. Only the
 * types of a capability the account's session advertises: a server without
 * contacts or calendars may refuse the whole subscription over them.
 *
 * Read from the device sync store's persisted JSON rather than the store, so
 * code that runs without it (the push task) never creates it.
 */
export async function pushTypesFor(accountId: string, session: JMAPSession | null): Promise<string[]> {
  let extra: string[] = [];
  try {
    const capabilities = session?.capabilities ?? {};
    extra = deviceSyncPushTypes(persistedAccounts(await AsyncStorage.getItem(DEVICE_SYNC_STORAGE_KEY))[accountId])
      .filter((type) => {
        const authority = authorityOfType(type);
        return !!authority && DEVICE_SYNC_CAPABILITIES[authority] in capabilities;
      });
  } catch {
    extra = [];
  }
  return [...PUSH_TYPES, ...extra];
}

// draft-ietf-jmap-emailpush (Stalwart >= 0.16.16). `EmailDelivery` alone
// still fires for every ingested message - including spam the server files
// straight into Junk - because the server can't know which folders a client
// cares about. With `emailPush` the server evaluates a per-account filter
// against each new message before pushing and stays silent on a miss, so
// junk-filed mail never wakes the device. Older servers don't advertise the
// capability and get the plain EmailDelivery subscription as before.
export const EMAIL_PUSH_CAPABILITY = 'urn:ietf:params:jmap:emailpush';

// Only ids: the relay stays content-blind and the headless task dedupes on them.
const EMAIL_PUSH_PROPERTIES = ['id', 'threadId'];

// Maximum expires we ask the server for. Stalwart (and other JMAP servers)
// may clamp this down; whatever they return is what we get. Without this,
// the server picks its own (often short) default and the subscription
// silently expires between app updates - so push stops arriving until the
// user re-enables it from settings.
const SUBSCRIPTION_EXPIRES_DAYS = 90;
// When an existing subscription has less than this much lifetime left, push
// expires forward on the next app start. Stalwart (0.16 and 1.0) clamps every
// expiry to seven days, so there each start refreshes it.
const SUBSCRIPTION_REFRESH_THRESHOLD_DAYS = 7;
// A recorded subscription missing from the server was revoked only if it still
// had at least this long to live; closer to its expiry (or with the clock a
// little off) it may simply have lapsed, and is re-created.
const REVOKED_EXPIRY_MARGIN_MS = 24 * 60 * 60 * 1000;

function expiresFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

export function sameTypes(a: readonly string[] | null | undefined, b: readonly string[]): boolean {
  if (!a || a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((t, i) => t === sortedB[i]);
}

export function serverSupportsEmailPush(): boolean {
  try {
    return EMAIL_PUSH_CAPABILITY in (jmapClient.currentSession?.capabilities ?? {});
  } catch {
    return false;
  }
}

/**
 * Whether the session lists emailpush among the account's own capabilities.
 * Not jmapClient.hasAccountCapability: that falls back to the session-level
 * capability, which Stalwart advertises whatever the account.
 */
function accountListsEmailPush(accountId: string): boolean {
  const caps = jmapClient.currentSession?.accounts?.[accountId]?.accountCapabilities;
  return !!caps && EMAIL_PUSH_CAPABILITY in caps;
}

// RFC 9670. Stalwart 1.0 lists it in every account's accountCapabilities,
// 0.16 in none.
const PRINCIPALS_OWNER_CAPABILITY = 'urn:ietf:params:jmap:principals:owner';

/**
 * Whether the account capabilities name the accounts a subscription reaches:
 * Stalwart 1.0 lists emailpush on the user's own account and their groups
 * only. 0.16.16 to 0.16.23 list it on every account, ACL shares included, and
 * 0.16.6 to 0.16.15 on none, so there the app has to work it out.
 */
function emailPushCapabilityIsExact(): boolean {
  try {
    const caps = jmapClient.currentSession?.accounts?.[jmapClient.accountId]?.accountCapabilities;
    return !!caps && PRINCIPALS_OWNER_CAPABILITY in caps;
  } catch {
    return false;
  }
}

/**
 * The delivery filter we want on every account the subscription fans out to:
 * skip anything the spam filter tagged `$junk` and anything that lives only in
 * a Junk-role mailbox (Sieve `fileinto` doesn't set the keyword). The two are
 * ANDed so a stale mailbox id - the user deleted and recreated Junk - degrades
 * to keyword-only filtering rather than letting everything through.
 *
 * Only the primary account and the accounts that list emailpush in their
 * accountCapabilities go in the map. Stalwart fans a subscription out to the
 * user's own account and their groups only, and refuses the whole map as
 * `forbidden` when it names a mailbox shared by ACL. 1.0 lists emailpush on
 * exactly those accounts; 0.16.16 to 0.16.23 list it on every account, and
 * the setup narrows the map when the server refuses it.
 *
 * Muted accounts and folders (#78) are cut out of the same filter: a muted
 * folder joins Junk in the "not only in" list; a muted account only lets
 * through mail in the folders the user unmuted again, or nothing at all.
 *
 * `inboxOnly` (webmail #983, Settings > Notifications > Inbox only) lets
 * through only mail that lands in each account's Inbox; a muted Inbox, or an
 * account without one, then never pushes.
 */
export async function buildEmailPushConfig(
  mutes: NotificationMutes = EMPTY_NOTIFICATION_MUTES,
  inboxOnly = false,
): Promise<Record<string, EmailPushConfig>> {
  const primary = jmapClient.accountId;
  const junkByAccount = new Map<string, string[]>([[primary, []]]);
  const mailboxIdsByAccount = new Map<string, Set<string>>();
  const inboxByAccount = new Map<string, string>();
  // The mail store loads the same folders at the same moment (sign-in,
  // start): reuse its list rather than a second Mailbox/get of our own.
  const username = jmapClient.username;
  const serverUrl = jmapClient.serverUrl;
  const loaded = username && serverUrl ? await loadedMailboxes(generateAccountId(username, serverUrl)) : null;
  // With mutes a swallowed fetch failure would look like "no such folder"
  // and unmute everything, so let the real error surface; otherwise the
  // filter can still degrade to keyword-only on a transient miss.
  const hasMutes = mutes.accounts.length > 0 || Object.keys(mutes.mailboxes).length > 0;
  // In inbox-only mode a swallowed failure would read as "no Inbox" too.
  const all = loaded ?? (hasMutes || inboxOnly
    ? [...(await getMailboxes()), ...(await getSharedMailboxes())]
    : [
      ...(await getMailboxes().catch(() => [] as Mailbox[])),
      ...(await getSharedMailboxes().catch(() => [] as Mailbox[])),
    ]);
  for (const m of all) {
    const accountId = m.accountId || primary;
    if (accountId !== primary && !accountListsEmailPush(accountId)) continue;
    // Shared-account mailboxes carry a client-side "<account>:<id>" id;
    // the server only knows the original.
    const serverId = m.originalId ?? m.id;
    const ids = mailboxIdsByAccount.get(accountId) ?? new Set<string>();
    ids.add(serverId);
    mailboxIdsByAccount.set(accountId, ids);
    const junk = junkByAccount.get(accountId) ?? [];
    if (m.role === 'junk') junk.push(serverId);
    junkByAccount.set(accountId, junk);
    if (m.role === 'inbox') inboxByAccount.set(accountId, serverId);
  }

  const config: Record<string, EmailPushConfig> = {};
  for (const [accountId, junkIds] of junkByAccount) {
    // Settings for folders that no longer exist are left out.
    const existing = mailboxIdsByAccount.get(accountId) ?? new Set<string>();
    const overrides = mailboxOverridesForAccount(mutes, accountId);
    const conditions: Record<string, unknown>[] = [{ notKeyword: '$junk' }];
    if (inboxOnly) {
      const inboxId = inboxByAccount.get(accountId);
      // The own account always has an Inbox; missing it means the folder
      // list is incomplete, and silencing the account would be worse.
      if (!inboxId && accountId === primary) {
        throw new Error(`No Inbox found for account ${accountId}; cannot build an inbox-only push filter`);
      }
      conditions.push(inboxId && !isMailboxMuted(mutes, accountId, inboxId) ? { inMailbox: inboxId } : NEVER_MATCH);
    } else if (isAccountMuted(mutes, accountId)) {
      const allowed = overrides.unmuted
        .filter((id) => existing.has(id) && !junkIds.includes(id))
        .sort();
      if (allowed.length === 0) conditions.push(NEVER_MATCH);
      else if (allowed.length === 1) conditions.push({ inMailbox: allowed[0] });
      else conditions.push({ operator: 'OR', conditions: allowed.map((id) => ({ inMailbox: id })) });
    } else {
      const excluded = new Set([...junkIds, ...overrides.muted.filter((id) => existing.has(id))]);
      if (excluded.size > 0) conditions.push({ inMailboxOtherThan: [...excluded].sort() });
    }
    config[accountId] = {
      // Always the operator form: that's how the server echoes it back, so a
      // stored config compares equal to a freshly built one.
      filter: { operator: 'AND', conditions },
      properties: [...EMAIL_PUSH_PROPERTIES],
      urgency: 'high',
    };
  }
  return config;
}

// Contradicts the `notKeyword: '$junk'` every filter starts with, so the AND
// never matches: the account stays in the map but never pushes.
const NEVER_MATCH = { hasKeyword: '$junk' } as const;

function normalizeEmailPush(value: unknown): string {
  const sortKeys = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortKeys);
    if (v && typeof v === 'object') {
      return Object.keys(v as Record<string, unknown>).sort().reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = sortKeys((v as Record<string, unknown>)[k]);
        return acc;
      }, {});
    }
    return v;
  };
  return JSON.stringify(sortKeys(value ?? null));
}

export function sameEmailPush(
  a: Record<string, EmailPushConfig> | null | undefined,
  b: Record<string, EmailPushConfig>,
): boolean {
  if (!a) return false;
  return normalizeEmailPush(a) === normalizeEmailPush(b);
}

// Stalwart marks the accounts a user owns - their own and the groups they
// belong to - through the create flags of its per-account collection
// capabilities: true there, false on accounts shared with them by ACL.
const OWNERSHIP_FLAGS: ReadonlyArray<readonly [string, string]> = [
  [CAPABILITIES.CALENDARS, 'mayCreateCalendar'],
  [CAPABILITIES.CONTACTS, 'mayCreateAddressBook'],
  [CAPABILITIES.FILES, 'mayCreateTopLevelFileNode'],
];

function looksOwned(info: JMAPAccountInfo | undefined): boolean {
  if (!info) return false;
  if (info.isPersonal) return true;
  if (info.isReadOnly) return false;
  return OWNERSHIP_FLAGS.some(([urn, flag]) => {
    const capability = info.accountCapabilities?.[urn] as Record<string, unknown> | undefined;
    return capability?.[flag] === true;
  });
}

/**
 * The emailPush maps to try, widest first. Stalwart refuses the whole map as
 * `forbidden` when it names an account the user neither owns nor belongs to
 * as a group member - a mailbox shared by ACL - and only fans a subscription
 * out to owned accounts anyway, so dropping the others loses nothing. The
 * session lists both kinds as isPersonal:false, isReadOnly:false, so the
 * first fallback keeps the accounts that look owned (see OWNERSHIP_FLAGS) and
 * the last keeps only the primary account, which is always accepted.
 */
export function emailPushFallbacks(
  desired: Record<string, EmailPushConfig>,
  primaryAccountId: string,
  accounts: Record<string, JMAPAccountInfo> | undefined,
): Record<string, EmailPushConfig>[] {
  const keep = (predicate: (id: string) => boolean) =>
    Object.fromEntries(
      Object.entries(desired).filter(([id]) => id === primaryAccountId || predicate(id)),
    );
  const out = [desired];
  for (const next of [keep((id) => looksOwned(accounts?.[id])), keep(() => false)]) {
    // Only steps that actually drop an account are worth another round-trip.
    if (Object.keys(next).length < Object.keys(out[out.length - 1]).length) out.push(next);
  }
  return out;
}

/**
 * Run a subscription write that carries `emailPush`, narrowing the map along
 * emailPushFallbacks while the server refuses the subscription with a
 * `forbidden` SetError. Anything else - a refused method call (which can be
 * `forbidden` too), overQuota, a failed request - would fail the same way
 * with a narrower map, so it is thrown as is. Resolves to the write's result
 * and the map the server took.
 */
async function writeWithEmailPush<T>(
  emailPush: Record<string, EmailPushConfig> | null,
  write: (emailPush: Record<string, EmailPushConfig> | null) => Promise<T>,
): Promise<{ result: T; emailPush: Record<string, EmailPushConfig> | null }> {
  const attempts = emailPush
    ? emailPushFallbacks(emailPush, jmapClient.accountId, jmapClient.currentSession?.accounts)
    : [null];
  for (let i = 0; ; i++) {
    try {
      return { result: await write(attempts[i]), emailPush: attempts[i] };
    } catch (err) {
      const mapRefused = isJMAPSetError(err) && err.type === 'forbidden';
      if (!mapRefused || i === attempts.length - 1) throw err;
      logPhase('jmap', 'emailPush map refused, retrying with fewer accounts');
    }
  }
}

/**
 * Whether a refused subscription write may be about its types. A failed
 * request says nothing about them, and a SetError naming other properties
 * (the push URL, the emailPush map) or meaning the subscription limit or a
 * missing record would fail the same way with fewer types; retrying those
 * with the mail types alone would only drop device sync's on a write that
 * later goes through.
 */
function mayConcernTypes(err: unknown): boolean {
  if (!(err instanceof JMAPMethodError)) return false;
  if (!isJMAPSetError(err)) return true;
  if (err.type !== 'invalidProperties') return false;
  return !err.properties || err.properties.includes('types');
}

/**
 * Run a subscription write with the account's push types and, when the server
 * refuses it over them while they include device sync's, once more with the
 * mail types alone: mail push never depends on device sync (#34).
 */
async function writeWithPushTypes<T>(
  types: readonly string[],
  write: (types: readonly string[]) => Promise<T>,
): Promise<T> {
  try {
    return await write(types);
  } catch (err) {
    if (sameTypes(types, PUSH_TYPES) || !mayConcernTypes(err)) throw err;
    logPhase('jmap', 'push types refused, retrying with the mail types alone');
    return write(PUSH_TYPES);
  }
}

async function readRefusedEmailPushAccounts(accountId: string): Promise<string[]> {
  try {
    const parsed = JSON.parse((await AsyncStorage.getItem(emailPushRefusedKey(accountId))) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

/** Add the accounts the server dropped from `wanted` to reach `accepted`. */
async function rememberRefusedEmailPushAccounts(
  accountId: string,
  refusedBefore: string[],
  wanted: Record<string, EmailPushConfig> | null,
  accepted: Record<string, EmailPushConfig> | null,
): Promise<void> {
  if (!wanted || !accepted) return;
  const refusedNow = Object.keys(wanted).filter((id) => !(id in accepted));
  if (refusedNow.length === 0) return;
  await AsyncStorage.setItem(
    emailPushRefusedKey(accountId),
    JSON.stringify(Array.from(new Set([...refusedBefore, ...refusedNow]))),
  );
}

function withoutAccounts(
  config: Record<string, EmailPushConfig>,
  accountIds: string[],
): Record<string, EmailPushConfig> {
  return Object.fromEntries(Object.entries(config).filter(([id]) => !accountIds.includes(id)));
}

/**
 * Which of `accountIds` (accounts the user sees mailboxes in) background
 * notifications don't reach: mailboxes others share with the user by ACL.
 * Stalwart only fans a subscription out to the user's own account and their
 * groups, whatever the emailPush map says, on every version.
 *
 * 1.0 leaves emailpush out of exactly those accounts' capabilities, and that
 * settles it: a group without calendars, contacts or files looks unowned, and
 * a refusal remembered under 0.16 could only keep a group out. 0.16.16 to
 * 0.16.23 list emailpush everywhere (and 0.16.6 to 0.16.15 nowhere), so there
 * it is the accounts the server refused in the map, and the ones that don't
 * look owned.
 */
export async function mailAccountsWithoutPush(accountIds: Iterable<string>): Promise<string[]> {
  let primary: string;
  try {
    primary = jmapClient.accountId;
  } catch {
    return [];
  }
  const others = Array.from(new Set(accountIds)).filter((id) => id && id !== primary);
  if (others.length === 0) return [];
  if (emailPushCapabilityIsExact()) return others.filter((id) => !accountListsEmailPush(id));
  if (serverSupportsEmailPush()) {
    const withoutEmailPush = others.filter((id) => !accountListsEmailPush(id));
    if (withoutEmailPush.length > 0) return withoutEmailPush;
  }
  const username = jmapClient.username;
  const serverUrl = jmapClient.serverUrl;
  const refused = username && serverUrl
    ? await readRefusedEmailPushAccounts(generateAccountId(username, serverUrl))
    : [];
  const accounts = jmapClient.currentSession?.accounts;
  return others.filter((id) => refused.includes(id) || !looksOwned(accounts?.[id]));
}

type BulwarkFcmNative = {
  getToken(): Promise<string>;
  deleteToken(): Promise<void>;
};

function getNative(): BulwarkFcmNative | null {
  if (Platform.OS !== 'android') return null;
  return (NativeModules as Record<string, unknown>).BulwarkFcm as BulwarkFcmNative | undefined ?? null;
}

/** True on platforms that have a push transport wired up: FCM or UnifiedPush on Android, APNs on iOS. */
export function isPushSupported(): boolean {
  return Platform.OS === 'ios' || getNative() !== null || isUnifiedPushSupported();
}

export type PushTransport = 'fcm' | 'unifiedpush' | 'apns';

export async function getStoredPushTransport(): Promise<PushTransport | null> {
  const raw = await AsyncStorage.getItem(PUSH_TRANSPORT_KEY);
  return raw === 'fcm' || raw === 'unifiedpush' ? raw : null;
}

export async function setStoredPushTransport(transport: PushTransport | null): Promise<void> {
  if (!transport) {
    await AsyncStorage.removeItem(PUSH_TRANSPORT_KEY);
  } else {
    await AsyncStorage.setItem(PUSH_TRANSPORT_KEY, transport);
  }
}

export async function getEffectivePushTransport(): Promise<PushTransport> {
  // iOS has one way in: APNs, through the relay.
  if (Platform.OS === 'ios') return 'apns';
  return (await getStoredPushTransport()) ?? 'fcm';
}

export interface PushSetupParams {
  // Optional - falls back to the hosted relay if omitted.
  relayBaseUrl?: string;
  accountLabel?: string;
  // Destroy the recorded server-side subscription and create a brand-new one
  // instead of refreshing the existing record's expiry. Stalwart binds the set
  // of accounts a subscription fans out to at creation time, so a subscription
  // that outlives a permission change keeps pushing for mailboxes the user can
  // no longer read - recreating is the only client-side remedy (#841).
  forceRecreate?: boolean;
}

export interface PushSetupResult {
  subscriptionId: string;
  verified: boolean;
}

/** Which step of the enable flow failed - lets the UI say what went wrong. */
export type PushSetupPhase =
  | 'platform'
  | 'permission'
  | 'token'
  | 'distributor'
  | 'account'
  | 'relay'
  | 'jmap'
  | 'verify';

export class PushSetupError extends Error {
  readonly phase: PushSetupPhase;

  constructor(phase: PushSetupPhase, message: string) {
    super(message);
    this.name = 'PushSetupError';
    this.phase = phase;
  }
}

/**
 * Whether the server refused the push address itself. Stalwart checks the
 * URL when a subscription is created: 0.16.27 and 1.0 refuse plain http and
 * private or reserved IP addresses, and 1.0 also refuses any host that is not
 * a public domain name (localhost, .local, .lan, .internal, a single label).
 */
function isRefusedPushUrl(err: unknown): boolean {
  return isJMAPSetError(err) && err.type === 'invalidProperties' && !!err.properties?.includes('url');
}

// A subscription write the mail server refused or could not take. The
// refusals a user can do something about read as plain text; anything else
// keeps the error's own message.
function subscriptionError(err: unknown, relayBaseUrl: string): PushSetupError {
  if (isRefusedPushUrl(err)) {
    return new PushSetupError(
      'jmap',
      t(
        'settings.notifications.push.err_url_refused',
        'The mail server refuses to send notifications to the relay at {url}. It only accepts https addresses on a public domain name, not a private IP address or a local name such as localhost, .local or .lan. Use the hosted relay, or give your relay a public domain name.',
        { url: relayBaseUrl },
      ),
    );
  }
  const type = err instanceof JMAPMethodError ? err.type : undefined;
  if (type === 'forbidden') {
    return new PushSetupError(
      'jmap',
      t('settings.notifications.push.err_forbidden', "The mail server doesn't allow background notifications for this account."),
    );
  }
  if (type === 'overQuota') {
    // Stalwart allows 15 subscriptions per account by default, and a
    // replacement is created before the one it replaces is destroyed.
    return new PushSetupError(
      'jmap',
      t(
        'settings.notifications.push.err_over_quota',
        'This account has too many push registrations on the mail server (the limit is usually 15). Revoke devices you no longer use in the notification settings, then try again.',
      ),
    );
  }
  const detail = err instanceof Error ? err.message : String(err);
  return new PushSetupError(
    'jmap',
    t('settings.notifications.push.err_jmap_refused', 'The mail server refused the push subscription: {detail}', { detail }),
  );
}

function randomClientId(): string {
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function getOrCreateDeviceClientId(accountId: string): Promise<string> {
  const key = deviceClientIdKey(accountId);
  const existing = await AsyncStorage.getItem(key);
  if (existing) return existing;
  const next = randomClientId();
  await AsyncStorage.setItem(key, next);
  return next;
}

export async function getStoredRelayBaseUrl(): Promise<string | null> {
  return AsyncStorage.getItem(RELAY_BASE_URL_KEY);
}

export async function getEffectiveRelayBaseUrl(): Promise<string> {
  const stored = await AsyncStorage.getItem(RELAY_BASE_URL_KEY);
  return stored ?? DEFAULT_RELAY_BASE_URL;
}

export async function setStoredRelayBaseUrl(url: string | null): Promise<void> {
  if (!url) {
    await AsyncStorage.removeItem(RELAY_BASE_URL_KEY);
  } else {
    await AsyncStorage.setItem(RELAY_BASE_URL_KEY, url.replace(/\/+$/, ''));
  }
}

/** Whether this account has a JMAP subscription recorded on this device. */
export async function isPushEnabledForAccount(accountId: string): Promise<boolean> {
  await migrateLegacyPushKeys();
  return (await AsyncStorage.getItem(subscriptionIdKey(accountId))) !== null;
}

/**
 * Whether push works for the account right now: it is set up, and the
 * system still lets the app show notifications (they can be turned off in
 * the phone's settings while the app is in the background). A failed check
 * reads as off (webmail #1148).
 */
export async function isPushActiveForAccount(accountId: string): Promise<boolean> {
  try {
    if (!(await isPushEnabledForAccount(accountId))) return false;
    const permission = await Notifications.getPermissionsAsync();
    return permission.granted !== false;
  } catch {
    return false;
  }
}

/**
 * Whether Settings > Notifications should read the push state again when
 * the app comes back: not while an enable or disable runs, nor right after
 * one failed, which would wipe its message (webmail #1148).
 */
export function shouldRecheckPushState(status: 'idle' | 'busy' | 'enabled' | 'error'): boolean {
  return status !== 'busy' && status !== 'error';
}

export async function wasPushPromptDismissed(accountId: string): Promise<boolean> {
  return (await AsyncStorage.getItem(promptDismissedKey(accountId))) !== null;
}

export async function dismissPushPrompt(accountId: string): Promise<void> {
  await AsyncStorage.setItem(promptDismissedKey(accountId), String(Date.now()));
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (Platform.OS === 'ios') {
    const current = await Notifications.getPermissionsAsync();
    if (current.granted) return true;
    const asked = await Notifications.requestPermissionsAsync({
      ios: { allowAlert: true, allowBadge: true, allowSound: true },
    });
    return asked.granted;
  }
  if (Platform.OS !== 'android') return true;
  if (Platform.Version < 33) return true;
  const status = await PermissionsAndroid.request(
    'android.permission.POST_NOTIFICATIONS' as Parameters<typeof PermissionsAndroid.request>[0],
  );
  return status === PermissionsAndroid.RESULTS.GRANTED;
}

export async function getFcmToken(): Promise<string | null> {
  const native = getNative();
  if (!native) return null;
  try {
    return await native.getToken();
  } catch {
    return null;
  }
}

// Firebase rejects getToken() on devices without Google Play services (or
// with a broken Firebase configuration), and briefly right after a
// deleteToken(). Turn the raw native rejection into a phase-tagged error the
// settings pane can explain - and point de-Googled devices at UnifiedPush
// when a distributor is around to take over.
async function getFcmTokenOrThrow(native: BulwarkFcmNative): Promise<string> {
  let token: string | null = null;
  try {
    token = await native.getToken();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const distributors = await getUnifiedPushDistributors().catch(() => []);
    throw new PushSetupError(
      'token',
      distributors.length > 0
        ? t(
          'settings.notifications.push.err_fcm_token_up',
          'Firebase could not issue a device token ({detail}). Push over FCM needs Google Play services on this device. This device has a UnifiedPush distributor installed - switch the delivery method to UnifiedPush instead.',
          { detail },
        )
        : t(
          'settings.notifications.push.err_fcm_token',
          'Firebase could not issue a device token ({detail}). Push over FCM needs Google Play services on this device.',
          { detail },
        ),
    );
  }
  if (!token) {
    throw new PushSetupError('token', t('settings.notifications.push.err_fcm_empty', 'Firebase returned an empty device token.'));
  }
  return token;
}

// The APNs device token (hex). iOS hands it out once notifications are
// allowed; expo-notifications asks the OS for it.
async function getApnsTokenOrThrow(): Promise<string> {
  let token: string | null = null;
  try {
    const result = await Notifications.getDevicePushTokenAsync();
    token = typeof result.data === 'string' ? result.data : null;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PushSetupError(
      'token',
      t('settings.notifications.push.err_apns_token', 'iOS could not issue a push token ({detail}).', { detail }),
    );
  }
  if (!token) {
    throw new PushSetupError('token', t('settings.notifications.push.err_apns_empty', 'iOS returned an empty push token.'));
  }
  return token;
}

/**
 * The relay's VAPID public key, when it has one. Passed to the UnifiedPush
 * distributor at registration so distributors that pin the application server
 * accept the relay's pushes; registration proceeds without it (503 on relays
 * without configured VAPID keys - UnifiedPush delivery still works there).
 */
async function fetchRelayVapidPublicKey(relayBaseUrl: string): Promise<string | null> {
  try {
    const res = await fetch(buildRelayUrl(relayBaseUrl, '/api/push/vapid-public-key'));
    if (!res.ok) return null;
    const body = (await res.json()) as { publicKey?: unknown };
    return typeof body.publicKey === 'string' && body.publicKey ? body.publicKey : null;
  } catch {
    return null;
  }
}

/** Acquire a UnifiedPush endpoint, mapping failures onto setup phases. */
async function getUnifiedPushEndpointOrThrow(
  relayBaseUrl: string,
): Promise<UnifiedPushEndpoint> {
  const vapid = await fetchRelayVapidPublicKey(relayBaseUrl);
  try {
    return await registerUnifiedPush({ vapid });
  } catch (err) {
    if (err instanceof UnifiedPushRegisterError) {
      const phase = err.reason === 'failed' ? 'token' : 'distributor';
      throw new PushSetupError(phase, err.message);
    }
    throw new PushSetupError('token', err instanceof Error ? err.message : String(err));
  }
}

function buildRelayUrl(base: string, suffix: string): string {
  return base.replace(/\/+$/, '') + suffix;
}

async function readRelayError(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return `HTTP ${res.status}`;
    try {
      const body = JSON.parse(text) as { error?: unknown };
      if (typeof body.error === 'string') return `${body.error} (HTTP ${res.status})`;
    } catch {
      // not JSON
    }
    return `HTTP ${res.status}: ${text.slice(0, 200)}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

async function registerWithRelay(params: {
  relayBaseUrl: string;
  subscriptionId: string;
  fcmToken: string;
  accountLabel?: string;
}): Promise<void> {
  let res: Response;
  try {
    res = await fetch(buildRelayUrl(params.relayBaseUrl, '/api/push/register'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subscriptionId: params.subscriptionId,
        fcmToken: params.fcmToken,
        accountLabel: params.accountLabel,
      }),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PushSetupError(
      'relay',
      t('settings.notifications.push.err_relay_unreachable', 'Could not reach the push relay at {url} ({detail}).', {
        url: params.relayBaseUrl,
        detail,
      }),
    );
  }
  if (!res.ok) {
    throw new PushSetupError(
      'relay',
      t('settings.notifications.push.err_relay_rejected', 'The push relay rejected the registration: {detail}', {
        detail: await readRelayError(res),
      }),
    );
  }
}

async function registerWithRelayApns(params: {
  relayBaseUrl: string;
  subscriptionId: string;
  deviceToken: string;
  accountLabel?: string;
}): Promise<void> {
  let res: Response;
  try {
    res = await fetch(buildRelayUrl(params.relayBaseUrl, '/api/push/register/apns'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subscriptionId: params.subscriptionId,
        deviceToken: params.deviceToken,
        environment: apnsEnvironment(),
        accountLabel: params.accountLabel,
      }),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PushSetupError(
      'relay',
      t('settings.notifications.push.err_relay_unreachable', 'Could not reach the push relay at {url} ({detail}).', {
        url: params.relayBaseUrl,
        detail,
      }),
    );
  }
  if (res.status === 503) {
    throw new PushSetupError(
      'relay',
      t('settings.notifications.push.err_relay_no_apns', 'The push relay at {url} does not deliver to iPhones and iPads yet.', {
        url: params.relayBaseUrl,
      }),
    );
  }
  if (!res.ok) {
    throw new PushSetupError(
      'relay',
      t('settings.notifications.push.err_relay_rejected', 'The push relay rejected the registration: {detail}', {
        detail: await readRelayError(res),
      }),
    );
  }
}

/**
 * Tell the iOS notification extension how to reach an account: which stored
 * credentials to use and the JMAP API URL. Without it the extension shows the
 * relay's placeholder text.
 *
 * The extension finds the entry by the push's JMAP account id alone
 * (NotificationService.swift), and those ids repeat across servers. While
 * another login with push has the same id, neither gets an entry: the
 * placeholder says there is new mail, where one login's credentials would
 * fetch and show a message of the other's server. Run again for the login
 * that is left once the other is gone (the next resync does). The entry also
 * names the username, which the extension compares with the push's label: a
 * group account of another login can have this login's id.
 */
export async function shareAccountWithExtension(
  accountId: string,
  jmapAccountId: string | null,
  apiUrl: string | undefined = jmapClient.currentSession?.apiUrl,
  username: string | null | undefined = jmapClient.username,
): Promise<void> {
  if (Platform.OS !== 'ios' || !jmapAccountId) return;
  const byLocal = await readPushJmapAccountIds();
  if (Object.keys(byLocal).some((local) => local !== accountId && byLocal[local] === jmapAccountId)) {
    await removeIosPushAccount(jmapAccountId).catch(() => undefined);
    return;
  }
  if (!apiUrl) return;
  await writeIosPushAccount(jmapAccountId, {
    credentialsKey: credentialsKey(accountId),
    apiUrl,
    ...(username ? { label: username } : {}),
  }).catch(() => undefined);
}

/**
 * Whether a local account (username@host) is the login a relay label names.
 * The label is the username the account registered with the relay.
 */
export function accountMatchesPushLabel(localAccountId: string, label: string, username?: string): boolean {
  const wanted = label.toLowerCase();
  return username?.toLowerCase() === wanted || localAccountId.toLowerCase().startsWith(`${wanted}@`);
}

async function registerWithRelayUnifiedPush(params: {
  relayBaseUrl: string;
  subscriptionId: string;
  endpoint: UnifiedPushEndpoint;
  accountLabel?: string;
}): Promise<void> {
  const { endpoint } = params;
  let res: Response;
  try {
    res = await fetch(buildRelayUrl(params.relayBaseUrl, '/api/push/register/unifiedpush'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        subscriptionId: params.subscriptionId,
        endpoint: endpoint.url,
        keys:
          endpoint.p256dh && endpoint.auth
            ? { p256dh: endpoint.p256dh, auth: endpoint.auth }
            : null,
        accountLabel: params.accountLabel,
      }),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PushSetupError(
      'relay',
      t('settings.notifications.push.err_relay_unreachable', 'Could not reach the push relay at {url} ({detail}).', {
        url: params.relayBaseUrl,
        detail,
      }),
    );
  }
  if (!res.ok) {
    throw new PushSetupError(
      'relay',
      t('settings.notifications.push.err_relay_rejected', 'The push relay rejected the registration: {detail}', {
        detail: await readRelayError(res),
      }),
    );
  }
}

/** The relay's view of a subscription - see relayStatusFor. */
export type PushRelayStatus = 'active' | 'inactive' | 'unknown';

/**
 * Ask the relay what it knows about a subscription. `inactive` means the relay
 * recognises the record and it is provably dead - it has never forwarded a push
 * and isn't freshly registered. `unknown` covers everything we cannot vouch for:
 * the relay doesn't recognise the id, an older relay without this endpoint, or a
 * network blip. Callers must treat `unknown` as "leave it alone", never as dead.
 */
async function relayStatusFor(
  relayBaseUrl: string,
  subscriptionId: string,
): Promise<PushRelayStatus> {
  if (!relayBaseUrl || !subscriptionId) return 'unknown';
  try {
    const res = await fetch(
      buildRelayUrl(relayBaseUrl, `/api/push/active/${encodeURIComponent(subscriptionId)}`),
    );
    if (!res.ok) return 'unknown';
    const body = (await res.json()) as { active?: unknown };
    if (body.active === true) return 'active';
    if (body.active === false) return 'inactive';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Returns true ONLY when the relay positively reports a subscription inactive,
 * so we never reap anything we can't confirm is dead. This is what lets setup
 * clear its own abandoned attempts - and dead siblings left by reinstalls that
 * regenerated the deviceClientId - without disturbing another live device or
 * the PWA that shares the account.
 */
async function relayReportsDead(
  relayBaseUrl: string,
  subscriptionId: string,
): Promise<boolean> {
  return (await relayStatusFor(relayBaseUrl, subscriptionId)) === 'inactive';
}

async function pollVerificationCode(
  relayBaseUrl: string,
  subscriptionId: string,
): Promise<string> {
  // Stalwart per-account rate-limits PushVerification posts (default 60s).
  // If there are leftover unverified subscriptions on the account, our new
  // one queues up behind them - so we wait long enough to clear at least one
  // verify window even in the unlucky case.
  const timeoutAt = Date.now() + 75_000;
  let delay = 400;
  let lastRelayError: string | null = null;
  while (Date.now() < timeoutAt) {
    try {
      const res = await fetch(
        buildRelayUrl(relayBaseUrl, `/api/push/verify/${encodeURIComponent(subscriptionId)}`),
      );
      if (res.ok) {
        const body = (await res.json()) as { verificationCode?: string | null };
        if (body.verificationCode) return body.verificationCode;
        lastRelayError = null;
      } else {
        lastRelayError = await readRelayError(res);
      }
    } catch (err) {
      lastRelayError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 2000);
  }
  throw new PushSetupError(
    'verify',
    lastRelayError
      ? t(
        'settings.notifications.push.err_verify_relay',
        'The relay never received the verification code from the mail server (last relay response: {detail}).',
        { detail: lastRelayError },
      )
      : t(
        'settings.notifications.push.err_verify_timeout',
        'The mail server did not send a verification code to the relay within 75 s. Check that the server can reach the relay URL.',
      ),
  );
}

// Coalesce concurrent setup attempts per account. App.tsx re-runs its push
// effect as auth state settles during startup and again on every FCM token
// refresh; because a failing attempt blocks for up to 75s polling for the
// verification code, those re-fires overlap. Without this guard each
// overlapping run mints its OWN deviceClientId and JMAP subscription, and the
// resulting swarm starves Stalwart's one-PushVerification-per-60s slot so none
// of them ever verifies (the symptom is a perpetual "Timed out waiting for
// PushVerification"). Callers share the first in-flight run instead.
const inFlightSetups = new Map<string, Promise<PushSetupResult>>();

/**
 * Full setup flow: ask permission, fetch the device's FCM token, register
 * with the relay, create a JMAP PushSubscription, poll for the verification
 * code, and finalise the subscription. Concurrent calls for the same account
 * are coalesced onto a single in-flight run.
 */
export function setupPushNotifications(
  params: PushSetupParams,
): Promise<PushSetupResult> {
  const key = `${jmapClient.username ?? ''}@${jmapClient.serverUrl ?? ''}`;
  const existing = inFlightSetups.get(key);
  if (existing) return existing;
  const rollback: SetupRollback = {};
  const run = setupPushNotificationsInner(params, rollback)
    .catch(async (err: unknown) => {
      await rollback.relayMove?.().catch(() => undefined);
      throw err;
    })
    .finally(() => {
      inFlightSetups.delete(key);
    });
  inFlightSetups.set(key, run);
  return run;
}

function logPhase(phase: string, detail?: string): void {
  console.log(`[push] ${phase}${detail ? `: ${detail}` : ''}`);
}

// What a failed setup run has to undo, set by the run as it goes.
interface SetupRollback {
  relayMove?: () => Promise<void>;
}

async function setupPushNotificationsInner(
  params: PushSetupParams,
  rollback: SetupRollback,
): Promise<PushSetupResult> {
  const transport = await getEffectivePushTransport();
  const native = getNative();
  if (transport === 'fcm' && !native) {
    throw new PushSetupError('platform', t('settings.notifications.push.err_android_only', 'Push notifications are only available on Android.'));
  }
  if (transport === 'apns' && Platform.OS !== 'ios') {
    throw new PushSetupError('platform', 'APNs is only available on iOS.');
  }
  if (transport === 'unifiedpush' && !isUnifiedPushSupported()) {
    throw new PushSetupError('platform', t('settings.notifications.push.err_up_android_only', 'UnifiedPush is only available on Android.'));
  }

  const relayBaseUrl = (params.relayBaseUrl ?? DEFAULT_RELAY_BASE_URL).replace(/\/+$/, '');
  if (!relayBaseUrl) throw new PushSetupError('relay', 'relayBaseUrl is required');
  if (!isValidRelayUrl(relayBaseUrl)) {
    throw new PushSetupError('relay', t('settings.notifications.push.err_relay_https', 'The relay URL must use https://.'));
  }

  logPhase('permission');
  const granted = await requestNotificationPermission();
  if (!granted) {
    throw new PushSetupError('permission', t('settings.notifications.push.err_permission', 'Notification permission was not granted.'));
  }

  logPhase('token', transport);
  let fcmToken: string | null = null;
  let upEndpoint: UnifiedPushEndpoint | null = null;
  let apnsToken: string | null = null;
  if (transport === 'unifiedpush') {
    upEndpoint = await getUnifiedPushEndpointOrThrow(relayBaseUrl);
  } else if (transport === 'apns') {
    apnsToken = await getApnsTokenOrThrow();
  } else {
    fcmToken = await getFcmTokenOrThrow(native!);
  }

  // setupPushNotifications operates on the currently-loaded jmapClient. We
  // need its username/serverUrl up-front so we can key per-account state.
  const username = jmapClient.username;
  const serverUrl = jmapClient.serverUrl;
  if (!username || !serverUrl) {
    throw new PushSetupError('account', t('settings.notifications.push.err_no_account', 'No account loaded - cannot set up push.'));
  }
  const accountId = generateAccountId(username, serverUrl);

  await migrateLegacyPushKeys();

  const deviceClientId = await getOrCreateDeviceClientId(accountId);
  // The relay a working registration goes through, put back should a move
  // to another relay fail.
  const previousRelayBaseUrl = await getStoredRelayBaseUrl();
  await setStoredRelayBaseUrl(relayBaseUrl);

  // Register this account's device-client-id with the relay. Multiple
  // accounts on the same device end up as separate registrations sharing
  // one FCM token / UnifiedPush endpoint - the relay forwards each push
  // individually and tags it with the JMAP account id so the headless task
  // can route it.
  logPhase('relay', relayBaseUrl);
  const registerWith = async (relay: string, endpoint: UnifiedPushEndpoint | null) => {
    if (apnsToken) {
      await registerWithRelayApns({
        relayBaseUrl: relay,
        subscriptionId: deviceClientId,
        deviceToken: apnsToken,
        accountLabel: params.accountLabel,
      });
    } else if (endpoint) {
      await registerWithRelayUnifiedPush({
        relayBaseUrl: relay,
        subscriptionId: deviceClientId,
        endpoint,
        accountLabel: params.accountLabel,
      });
    } else {
      await registerWithRelay({
        relayBaseUrl: relay,
        subscriptionId: deviceClientId,
        fcmToken: fcmToken!,
        accountLabel: params.accountLabel,
      });
    }
  };
  // Undo this run's relay steps once a move to another relay fails. The new
  // URL may be another name of the relay in use, so the record dropped from
  // it can be the working one; and a UnifiedPush distributor now holds the
  // new relay's VAPID key, which may make it turn away the previous relay's
  // pushes. Registering with the previous relay again puts both back; the
  // record itself only for an account that had a working subscription
  // through it.
  const restoreRelay = async (relay: string, hadSubscription: boolean) => {
    const endpoint = upEndpoint ? await getUnifiedPushEndpointOrThrow(relay) : null;
    if (hadSubscription) await registerWith(relay, endpoint);
  };
  // Until a subscription through the new relay is verified, whatever still
  // works goes through the relay used before, whichever step failed (the
  // server refused the address, the subscription limit, a verification that
  // never came): keep that one stored, since token refreshes, the settings,
  // the device list and the next launch all follow it, and drop the record
  // this run left on the new relay.
  let match: PushSubscription | undefined;
  if (previousRelayBaseUrl !== relayBaseUrl) {
    rollback.relayMove = async () => {
      await setStoredRelayBaseUrl(previousRelayBaseUrl);
      await deregisterFromRelay(relayBaseUrl, deviceClientId);
      if (previousRelayBaseUrl) await restoreRelay(previousRelayBaseUrl, !!match).catch(() => undefined);
    };
  }
  await registerWith(relayBaseUrl, upEndpoint);

  // Reuse the previous JMAP subscription when the server still has it, but
  // push the expiry forward so it doesn't time out before the next app start.
  // With forceRecreate we skip the reuse and replace it instead (#841). Either
  // way the old record keeps delivering until its replacement is verified, so
  // a replacement the server refuses never leaves the device without push.
  //
  // A failed listing ends the run here: taken for "the server has no
  // subscription", it would drop the key of a working registration.
  logPhase('jmap');
  let existingSubs: PushSubscription[];
  try {
    existingSubs = await listPushSubscriptions();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PushSetupError(
      'jmap',
      t('settings.notifications.push.err_jmap_list', 'Could not read the push registrations from the mail server: {detail}', { detail }),
    );
  }
  // A forced re-registration re-learns which accounts the server accepts in
  // the emailPush map.
  if (params.forceRecreate) await AsyncStorage.removeItem(emailPushRefusedKey(accountId));
  // On 1.0 the capabilities the map is built from already leave out every
  // account the server refuses; a list remembered under 0.16 could only keep
  // a group out.
  const refusedBefore = emailPushCapabilityIsExact() ? [] : await readRefusedEmailPushAccounts(accountId);
  const emailPush = serverSupportsEmailPush()
    ? withoutAccounts(
      await buildEmailPushConfig(useSettingsStore.getState().notificationMutes, useSettingsStore.getState().pushNotifyInboxOnly),
      refusedBefore,
    )
    : null;
  const subKey = subscriptionIdKey(accountId);
  const storedServerId = await AsyncStorage.getItem(subKey);
  const types = await pushTypesFor(accountId, jmapClient.currentSession);
  let jmapAccountId: string | null = null;
  try {
    jmapAccountId = jmapClient.accountId;
  } catch {
    jmapAccountId = null;
  }
  let replacedServerId: string | null = null;
  // Ours only if it was made for this device: Stalwart's ids are short and
  // sequential, so once the server is reinstalled at the same address the
  // recorded id can name another device's subscription.
  match = storedServerId
    ? existingSubs.find((s) => s.id === storedServerId && (!s.deviceClientId || s.deviceClientId === deviceClientId))
    : undefined;
  if (storedServerId) {
    if (match) {
      if (match.expires) await AsyncStorage.setItem(subscriptionExpiresKey(accountId), match.expires);
      if (!params.forceRecreate) {
        let refreshed: Awaited<ReturnType<typeof refreshSubscriptionExpires>>;
        try {
          refreshed = await refreshSubscriptionExpires(match, emailPush, types);
        } catch (err) {
          // Nothing the server said about the subscription (a failed request,
          // rate limiting, a refused method call): it keeps delivering, and
          // the next run tries again.
          throw subscriptionError(err, relayBaseUrl);
        }
        if (refreshed) {
          // The update's answer doesn't say what the server settled on, and
          // the expiry recorded above is from before it. Left there, it would
          // read as lapsed days before the server's copy is, which turns the
          // background extension off for an account without new mail.
          if (refreshed.updated) await recordServerExpiry(accountId, match.id, deviceClientId);
          await rememberRefusedEmailPushAccounts(accountId, refusedBefore, emailPush, refreshed.emailPush);
          await addPushAccountId(accountId);
          await writePushJmapAccountId(accountId, jmapAccountId);
          await shareAccountWithExtension(accountId, jmapAccountId);
          await AsyncStorage.removeItem(optedOutKey(accountId));
          logPhase('done', 'reused existing subscription');
          return { subscriptionId: storedServerId, verified: true };
        }
      }
      // The server refused the refresh with a SetError, or the caller asked
      // for a fresh record: create a replacement below and destroy this one
      // once it's verified.
      replacedServerId = storedServerId;
    } else {
      // The server no longer has it: it lapsed, or the server behind the
      // account was replaced. A revocation from another device is caught
      // before this by the launch-time resync (wasRevokedOnServer). Either
      // way it is re-created below.
      await AsyncStorage.removeItem(subKey);
    }
  }

  // Reap leftover Stalwart subscriptions that would otherwise starve the new
  // one's verification. Stalwart (0.16 and 1.0) emits only one
  // PushVerification per account per 60 s, to the newest unverified
  // subscription, and sends the next one when that window has passed: every
  // straggler created or touched just before ours delays it by a window, and
  // a swarm of them ends in the confusing "Timed out waiting for
  // PushVerification" error. We can't read a
  // subscription's verified state or URL over JMAP (Stalwart hides both), only
  // its deviceClientId, so we decide what's safe to remove like this:
  //   - same deviceClientId as ours: a previous attempt from THIS device,
  //     always safe to reap.
  //   - a different deviceClientId: could be another live device or the PWA on
  //     this account. Ask the relay whether it's still alive and only reap the
  //     ones it confirms are dead. Anything live - or anything the relay can't
  //     vouch for (a different relay, a non-Bulwark client, a network blip) -
  //     is left untouched.
  for (const s of existingSubs) {
    if (s.id === match?.id) continue;
    if (s.deviceClientId === deviceClientId) {
      await destroyPushSubscription(s.id).catch(() => undefined);
      continue;
    }
    if (await relayReportsDead(relayBaseUrl, s.deviceClientId)) {
      await destroyPushSubscription(s.id).catch(() => undefined);
    }
  }

  let serverAssignedId: string;
  let serverExpires: string | null;
  const create = () => writeWithPushTypes(types, (wanted) =>
    writeWithEmailPush(emailPush, (filter) =>
      createPushSubscription({
        deviceClientId,
        url: buildRelayUrl(relayBaseUrl, `/api/push/jmap/${encodeURIComponent(deviceClientId)}`),
        types: [...wanted],
        expires: expiresFromNow(SUBSCRIPTION_EXPIRES_DAYS),
        ...(filter ? { emailPush: filter } : {}),
      }),
    ),
  );
  try {
    let created: Awaited<ReturnType<typeof create>>;
    try {
      created = await create();
    } catch (err) {
      // Stalwart caps an account's subscriptions (15 by default) and counts
      // the one being replaced, so at the cap a forced re-register could never
      // create its replacement. The user asked for a new record: free the old
      // one's place and try once more. Should that fail too, push is off and
      // the error says why. Not when this run moves to another relay: Stalwart
      // counts the subscriptions before it looks at the URL, so a relay it
      // refuses would only show up after the working record is gone.
      const relayChanged = previousRelayBaseUrl !== relayBaseUrl;
      if (!params.forceRecreate || !replacedServerId || relayChanged || !isJMAPSetError(err) || err.type !== 'overQuota') throw err;
      logPhase('jmap', 'subscription limit reached, replacing the old record first');
      await destroyPushSubscription(replacedServerId);
      await AsyncStorage.removeItem(subKey);
      replacedServerId = null;
      created = await create();
    }
    serverAssignedId = created.result.id;
    serverExpires = created.result.expires;
    await rememberRefusedEmailPushAccounts(accountId, refusedBefore, emailPush, created.emailPush);
  } catch (err) {
    throw subscriptionError(err, relayBaseUrl);
  }

  logPhase('verify');
  const verificationCode = await pollVerificationCode(relayBaseUrl, deviceClientId);
  try {
    await verifyPushSubscription(serverAssignedId, verificationCode);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PushSetupError(
      'verify',
      t('settings.notifications.push.err_verify_rejected', 'The mail server rejected the verification code: {detail}', { detail }),
    );
  }
  rollback.relayMove = undefined;

  await AsyncStorage.setItem(subKey, serverAssignedId);
  if (serverExpires) await AsyncStorage.setItem(subscriptionExpiresKey(accountId), serverExpires);
  if (replacedServerId) {
    await destroyPushSubscription(replacedServerId).catch(() => undefined);
  }
  await addPushAccountId(accountId);
  await writePushJmapAccountId(accountId, jmapAccountId);
  await shareAccountWithExtension(accountId, jmapAccountId);
  await AsyncStorage.removeItem(optedOutKey(accountId));
  logPhase('done', 'subscription verified');

  return { subscriptionId: serverAssignedId, verified: true };
}

async function addPushAccountId(accountId: string): Promise<void> {
  const ids = await readPushAccountIds();
  if (!ids.includes(accountId)) {
    await writePushAccountIds([...ids, accountId]);
  }
}

// Push the subscription's expires forward when it's getting close to the
// server's ceiling, and re-sync `types` / the delivery filter when they drift
// from what this client wants (a subscription created by an older build still
// listens to `Email`/`Mailbox`; device sync was turned on or off; a Junk
// mailbox id can change under us). Returns false when the server refuses the
// update with a SetError, also with the mail types alone (the subscription is
// gone, or no narrower map is accepted), which the caller answers with a
// replacement; otherwise the emailPush map the update installed (null when it
// left the filter alone) and whether it wrote anything. Every other failure -
// the network, a timeout, rate limiting, a refused method call - says nothing
// about the subscription and is thrown.
async function refreshSubscriptionExpires(
  sub: {
    id: string;
    expires?: string | null;
    types?: string[] | null;
    emailPush?: Record<string, EmailPushConfig> | null;
  },
  // null when the server has no emailPush support - leave the property alone.
  desiredEmailPush: Record<string, EmailPushConfig> | null,
  types: readonly string[],
): Promise<false | { emailPush: Record<string, EmailPushConfig> | null; updated: boolean }> {
  const typesNeedUpdate = !sameTypes(sub.types, types);
  const emailPushNeedsUpdate =
    desiredEmailPush !== null && !sameEmailPush(sub.emailPush, desiredEmailPush);
  if (!typesNeedUpdate && !emailPushNeedsUpdate && sub.expires) {
    const remainingMs = new Date(sub.expires).getTime() - Date.now();
    const thresholdMs = SUBSCRIPTION_REFRESH_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
    if (Number.isFinite(remainingMs) && remainingMs > thresholdMs) {
      // Plenty of life left - skip the update round-trip.
      return { emailPush: null, updated: false };
    }
  }
  try {
    return await writeWithPushTypes(types, async (wanted) => {
      const patch: { expires?: string; types?: string[] } = {
        expires: expiresFromNow(SUBSCRIPTION_EXPIRES_DAYS),
      };
      if (!sameTypes(sub.types, wanted)) patch.types = [...wanted];
      const { emailPush } = await writeWithEmailPush(
        emailPushNeedsUpdate ? desiredEmailPush : null,
        (filter) => updatePushSubscription(sub.id, filter ? { ...patch, emailPush: filter } : patch),
      );
      return { emailPush, updated: true };
    });
  } catch (err) {
    if (isJMAPSetError(err)) return false;
    throw err;
  }
}

/**
 * Record the expiry the server holds for the account's subscription, read
 * back after an update. Best effort: without an answer the recorded one
 * stays, and the background extension asks the server itself.
 */
async function recordServerExpiry(accountId: string, subscriptionId: string, deviceClientId: string): Promise<void> {
  try {
    const current = (await listPushSubscriptions()).find(
      (s) => s.id === subscriptionId && (!s.deviceClientId || s.deviceClientId === deviceClientId),
    );
    if (current?.expires) await AsyncStorage.setItem(subscriptionExpiresKey(accountId), current.expires);
  } catch {
    // The next run reads it again.
  }
}

async function deregisterFromRelay(
  relayBaseUrl: string,
  deviceClientId: string,
): Promise<void> {
  await fetch(
    buildRelayUrl(relayBaseUrl, `/api/push/register/${encodeURIComponent(deviceClientId)}`),
    { method: 'DELETE' },
  ).catch(() => undefined);
}

async function clearAccountPushKeys(accountId: string): Promise<void> {
  if (Platform.OS === 'ios') {
    const jmapAccountId = (await readPushJmapAccountIds())[accountId];
    if (jmapAccountId) await removeIosPushAccount(jmapAccountId);
  }
  await AsyncStorage.multiRemove([
    subscriptionIdKey(accountId),
    deviceClientIdKey(accountId),
    lastNotifiedKey(accountId),
    notifiedIdsKey(accountId),
    emailPushRefusedKey(accountId),
    subscriptionExpiresKey(accountId),
  ]);
  await writePushJmapAccountId(accountId, null);
}

/**
 * Forget what push learned from the account's server: the ring of notified
 * message ids (a different server hands the same short ids to new mail, which
 * would then never notify), the accounts it refused in the emailPush map, and
 * the recorded subscription's expiry. A replaced server holds none of the old
 * subscriptions, which must not count as revoked: without the expiry the next
 * resync re-creates it (see lib/server-change).
 */
export async function forgetPushServerState(accountId: string): Promise<void> {
  await AsyncStorage.multiRemove([
    lastNotifiedKey(accountId),
    notifiedIdsKey(accountId),
    emailPushRefusedKey(accountId),
    subscriptionExpiresKey(accountId),
  ]);
}

/**
 * Forget the recorded subscription's expiry alone, for an account whose
 * server may have been replaced unseen (lib/server-change): the next resync
 * then re-creates a subscription the server lacks instead of taking it for
 * revoked.
 */
export async function forgetPushSubscriptionExpiry(accountId: string): Promise<void> {
  await AsyncStorage.removeItem(subscriptionExpiresKey(accountId));
}

// Stalwart (0.16 and 1.0) keeps a subscription for seven days from its last
// refresh, and only the app's start refreshes it. Someone who reads new mail
// from the notifications without opening the app would lose push after a
// week, so a push handled in the background extends the subscription too,
// at most about once a day: once less than this much of it is left.
const BACKGROUND_EXTEND_BELOW_MS = 6 * 24 * 60 * 60 * 1000;

/** Whether a subscription expiring then is due for a background extension. */
export function pushSubscriptionNeedsExtension(expires: string | null | undefined): boolean {
  const at = Date.parse(expires ?? '');
  return !Number.isFinite(at) || at - Date.now() < BACKGROUND_EXTEND_BELOW_MS;
}

/**
 * The account's subscription when a background push may have to extend it:
 * it is recorded, and its recorded expiry is less than six days away, has
 * passed or is unknown. Only the first is certain: the record can be older
 * than the server's copy (a refresh whose answer never came back), so the
 * caller reads the server's expiry before it extends anything. A push arriving
 * at all says some subscription still delivers. Carries this device's client
 * id, so the caller can make sure a server that reused the id hands back our
 * own subscription.
 */
export async function pushSubscriptionDueForExtension(
  accountId: string,
): Promise<{ id: string; deviceClientId: string | null } | null> {
  if (await AsyncStorage.getItem(optedOutKey(accountId))) return null;
  const id = await AsyncStorage.getItem(subscriptionIdKey(accountId));
  if (!id) return null;
  if (!pushSubscriptionNeedsExtension(await AsyncStorage.getItem(subscriptionExpiresKey(accountId)))) return null;
  return { id, deviceClientId: await AsyncStorage.getItem(deviceClientIdKey(accountId)) };
}

/** The expiry to ask for when extending a subscription; servers clamp it. */
export function wantedPushSubscriptionExpires(): string {
  return expiresFromNow(SUBSCRIPTION_EXPIRES_DAYS);
}

/** Record the expiry the server reported for the account's subscription. */
export async function recordPushSubscriptionExpires(accountId: string, expires: string): Promise<void> {
  await AsyncStorage.setItem(subscriptionExpiresKey(accountId), expires);
}

/**
 * Tear down push for a single account. Destroys every JMAP subscription the
 * server holds for this device and tells the relay to drop its mapping.
 * Other accounts' push setups are untouched. The account the jmapClient
 * serves goes through it; another signed-in account (removed from the
 * account list while a different one is open) through a client of its own,
 * never the singleton: subscription ids repeat across accounts ("b" in every
 * Stalwart account), so a destroy by id there could end the open account's
 * own push.
 *
 * The FCM token is deliberately left alive: the relay mapping is gone so
 * nothing gets forwarded, and deleting the token makes the next getToken()
 * fail for a while (native #45 "Disable then Enable" race). Only the
 * logout-all path (`teardownPushNotifications`) kills the token.
 */
export async function teardownPushNotificationsForAccount(
  accountId: string,
): Promise<void> {
  await migrateLegacyPushKeys();

  const storedSubId = await AsyncStorage.getItem(subscriptionIdKey(accountId));
  const storedDcid = await AsyncStorage.getItem(deviceClientIdKey(accountId));
  const relayBaseUrl = await getStoredRelayBaseUrl();

  // Destroy every subscription the server holds for this device, not just the
  // id we happen to have recorded - a destroy that lost its round-trip or a
  // failed enable can leave a registration this client no longer tracks (#841).
  // The recorded id alone is trusted only when the server can't be asked: on
  // a server reinstalled at the same address it can name another device's.
  const server = await pushSubscriptionsOf(accountId);
  const idsToDestroy = new Set<string>();
  const existing = server && storedDcid ? await server.list().catch(() => null) : null;
  if (existing) {
    for (const s of existing) {
      const recordedWithoutDevice = s.id === storedSubId && !s.deviceClientId;
      if (s.deviceClientId === storedDcid || recordedWithoutDevice) idsToDestroy.add(s.id);
    }
  } else if (storedSubId) {
    idsToDestroy.add(storedSubId);
  }
  for (const id of idsToDestroy) {
    await server?.destroy(id).catch(() => undefined);
  }
  if (relayBaseUrl && storedDcid) {
    await deregisterFromRelay(relayBaseUrl, storedDcid);
  }

  await clearAccountPushKeys(accountId);

  const remaining = (await readPushAccountIds()).filter((id) => id !== accountId);
  await writePushAccountIds(remaining);
}

/**
 * Listing and destroying the account's push subscriptions, through the
 * jmapClient when it serves the account, else through a client of its own.
 * Null when the account can't be loaded: its server is left alone then.
 */
async function pushSubscriptionsOf(accountId: string): Promise<{
  list: () => Promise<ListedSubscription[]>;
  destroy: (id: string) => Promise<void>;
} | null> {
  const username = jmapClient.username;
  const serverUrl = jmapClient.serverUrl;
  if (username && serverUrl && generateAccountId(username, serverUrl) === accountId) {
    return { list: listPushSubscriptions, destroy: destroyPushSubscription };
  }
  const client = new JMAPClient();
  if (!(await client.loadAccount(accountId).catch(() => false))) return null;
  const using = [CAPABILITIES.CORE];
  return {
    list: async () => {
      const res = await client.request(
        [['PushSubscription/get', { ids: null, properties: ['id', 'deviceClientId'] }, '0']],
        using,
      );
      return (requireMethodResult(res, '0', 'PushSubscription/get').list as ListedSubscription[] | undefined) ?? [];
    },
    destroy: async (id) => {
      const res = await client.request([['PushSubscription/set', { destroy: [id] }, '0']], using);
      requireMethodResult(res, '0', 'PushSubscription/set');
    },
  };
}

/**
 * Turn push off for one account because the user asked to: the settings
 * toggle, or revoking this device (here, or from another device - see
 * resyncPushNotifications). Tears the registration down and remembers the
 * choice, so the launch-time resync doesn't quietly register the account
 * again. Enabling push for it again clears the mark.
 */
export async function disablePushForAccount(accountId: string): Promise<void> {
  await teardownPushNotificationsForAccount(accountId);
  await AsyncStorage.setItem(optedOutKey(accountId), String(Date.now()));
}

/**
 * True when the server no longer has this account's recorded subscription
 * although it wasn't due to expire - someone revoked it. Without a known
 * expiry (a registration made by an older build, or one on a server that was
 * replaced since, or may have been) nothing can be told apart, so it counts
 * as not revoked. Throws when the server can't be asked.
 */
async function wasRevokedOnServer(accountId: string): Promise<boolean> {
  const storedServerId = await AsyncStorage.getItem(subscriptionIdKey(accountId));
  const expires = Date.parse((await AsyncStorage.getItem(subscriptionExpiresKey(accountId))) ?? '');
  if (!storedServerId || !Number.isFinite(expires)) return false;
  if (expires - Date.now() < REVOKED_EXPIRY_MARGIN_MS) return false;
  const deviceClientId = await AsyncStorage.getItem(deviceClientIdKey(accountId));
  const subs = await listPushSubscriptions();
  return !subs.some((s) => isOwnSubscription(s, storedServerId, deviceClientId));
}

/**
 * Whether a subscription the server lists is the one this device recorded.
 * Stalwart hands out short ids and gives a destroyed subscription's id to the
 * next one created ("b" in every account), so the id alone can name another
 * client's subscription on the same account, such as the webmail's. A
 * subscription listed without a device client id, or one recorded before the
 * device kept its own, is taken on the id.
 */
function isOwnSubscription(
  s: { id: string; deviceClientId?: string | null },
  subscriptionId: string,
  deviceClientId: string | null,
): boolean {
  return s.id === subscriptionId && (!s.deviceClientId || !deviceClientId || s.deviceClientId === deviceClientId);
}

/**
 * Bring the loaded account's registration up to date without user action -
 * on launch and when the push token or endpoint rotates. Skips an account the
 * user turned push off for, and honours a revocation: when the server dropped
 * the subscription before it was due to expire, push is turned off for the
 * account instead of being silently registered again. A server replaced at
 * the account's address loses every subscription too; that is told apart by
 * its fingerprint, which forgets the expiry (forgetPushServerState), so the
 * subscription is re-created there. Resolves to null when it left push off.
 */
export async function resyncPushNotifications(
  params: PushSetupParams,
): Promise<PushSetupResult | null> {
  const username = jmapClient.username;
  const serverUrl = jmapClient.serverUrl;
  if (!username || !serverUrl) return null;
  const accountId = generateAccountId(username, serverUrl);
  if (await AsyncStorage.getItem(optedOutKey(accountId))) return null;
  if (await wasRevokedOnServer(accountId)) {
    logPhase('revoked', 'subscription gone before it was due to expire; leaving push off');
    await disablePushForAccount(accountId);
    return null;
  }
  return setupPushNotifications(params);
}

export interface PushEnableOutcome {
  error: unknown;
  // The relay the settings should show afterwards.
  relayBaseUrl: string;
  // Whether the account has a subscription recorded once the run is over.
  enabled: boolean;
}

/**
 * The enable and re-register buttons of the notification settings: run the
 * setup and say what it left behind. When the mail server refuses a new
 * relay, or the move to it fails otherwise, the setup goes back to the one in
 * use; the relay field must show that one again rather than the new address,
 * since the device list asks
 * the relay in the field about each device and a revoke goes to it. With no
 * relay in use the typed one stays, so the user can correct it.
 */
export async function enablePushFromSettings(params: PushSetupParams): Promise<PushEnableOutcome> {
  const accountId = jmapClient.username && jmapClient.serverUrl
    ? generateAccountId(jmapClient.username, jmapClient.serverUrl)
    : null;
  let error: unknown = null;
  try {
    await setupPushNotifications(params);
  } catch (err) {
    error = err;
  }
  const typed = (params.relayBaseUrl ?? DEFAULT_RELAY_BASE_URL).replace(/\/+$/, '');
  return {
    error,
    relayBaseUrl: (await getStoredRelayBaseUrl()) ?? typed,
    enabled: accountId ? await isPushEnabledForAccount(accountId) : false,
  };
}

/**
 * Re-apply an account's push types to its subscription after device sync was
 * turned on or off for it (#34). The account the client serves goes through
 * the api/push helpers; another signed-in account through a client of its
 * own, never the singleton. Best effort: the next resync of the account
 * applies them anyway.
 */
export async function refreshPushSubscriptionTypes(accountId: string): Promise<void> {
  if (await AsyncStorage.getItem(optedOutKey(accountId))) return;
  const subscriptionId = await AsyncStorage.getItem(subscriptionIdKey(accountId));
  if (!subscriptionId) return;
  const username = jmapClient.username;
  const serverUrl = jmapClient.serverUrl;
  const served = !!username && !!serverUrl && generateAccountId(username, serverUrl) === accountId;
  const deviceClientId = await AsyncStorage.getItem(deviceClientIdKey(accountId));
  try {
    if (served) {
      const types = await pushTypesFor(accountId, jmapClient.currentSession);
      const current = (await listPushSubscriptions()).find((s) => isOwnSubscription(s, subscriptionId, deviceClientId));
      if (!current || sameTypes(current.types, types)) return;
      await updatePushSubscription(subscriptionId, { types: [...types] });
      return;
    }
    const client = new JMAPClient();
    if (!(await client.loadAccount(accountId))) return;
    const types = await pushTypesFor(accountId, client.currentSession);
    const using = [CAPABILITIES.CORE];
    const res = await client.request(
      [['PushSubscription/get', { ids: [subscriptionId], properties: ['id', 'deviceClientId', 'types'] }, '0']],
      using,
    );
    const list = requireMethodResult(res, '0', 'PushSubscription/get').list as
      | Array<{ id: string; deviceClientId?: string | null; types?: string[] | null }>
      | undefined;
    const current = list?.find((s) => isOwnSubscription(s, subscriptionId, deviceClientId));
    if (!current || sameTypes(current.types, types)) return;
    await client.request(
      [['PushSubscription/set', { update: { [subscriptionId]: { types: [...types] } } }, '0']],
      using,
    );
  } catch {
    // The next resync re-applies them.
  }
}

/**
 * Keep push alive for the signed-in accounts the app is not showing (webmail #1054).
 * The launch-time resync works on the loaded account only, and Stalwart keeps
 * a subscription for seven days from its last refresh, so another account's
 * push stopped about a week after the user last switched to it. Each account
 * goes through a client of its own, never the singleton: its registration
 * with the relay is renewed (the device token may have rotated since), its
 * subscription's expiry pushed forward and the expiry the server settled on
 * recorded. A subscription the server no longer has - lapsed, or revoked
 * elsewhere - is left to the account's own resync, which can tell the two
 * apart and verify a new one; so are its delivery filter and push types.
 * Best effort: whatever fails is tried again on the next launch.
 */
export async function renewOtherPushAccounts(): Promise<void> {
  const username = jmapClient.username;
  const serverUrl = jmapClient.serverUrl;
  const served = username && serverUrl ? generateAccountId(username, serverUrl) : null;
  const relayBaseUrl = await getStoredRelayBaseUrl();
  for (const accountId of await readPushAccountIds()) {
    if (accountId === served) continue;
    try {
      await renewPushAccount(accountId, relayBaseUrl);
    } catch (err) {
      logPhase('renew', `${accountId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

type ListedSubscription = { id: string; deviceClientId?: string | null; expires?: string | null };

async function renewPushAccount(accountId: string, relayBaseUrl: string | null): Promise<void> {
  if (await AsyncStorage.getItem(optedOutKey(accountId))) return;
  const subscriptionId = await AsyncStorage.getItem(subscriptionIdKey(accountId));
  if (!subscriptionId) return;
  const deviceClientId = await AsyncStorage.getItem(deviceClientIdKey(accountId));
  const client = new JMAPClient();
  if (!(await client.loadAccount(accountId))) return;
  if (relayBaseUrl && deviceClientId) {
    await registerDeviceWithRelay(relayBaseUrl, deviceClientId, client.username ?? undefined).catch(() => undefined);
  }
  const using = [CAPABILITIES.CORE];
  const properties = ['id', 'deviceClientId', 'expires'];
  const ownIn = (res: Awaited<ReturnType<JMAPClient['request']>>, callId: string) =>
    (requireMethodResult(res, callId, 'PushSubscription/get').list as ListedSubscription[] | undefined)
      ?.find((s) => isOwnSubscription(s, subscriptionId, deviceClientId));
  const current = ownIn(
    await client.request([['PushSubscription/get', { ids: [subscriptionId], properties }, '0']], using),
    '0',
  );
  if (!current) return;
  let expires = current.expires ?? null;
  const remainingMs = Date.parse(expires ?? '') - Date.now();
  if (!(remainingMs > SUBSCRIPTION_REFRESH_THRESHOLD_DAYS * 24 * 60 * 60 * 1000)) {
    const res = await client.request(
      [
        ['PushSubscription/set', { update: { [subscriptionId]: { expires: expiresFromNow(SUBSCRIPTION_EXPIRES_DAYS) } } }, '0'],
        // The update's answer doesn't say what the server settled on.
        ['PushSubscription/get', { ids: [subscriptionId], properties }, '1'],
      ],
      using,
    );
    expires = ownIn(res, '1')?.expires ?? expires;
  }
  if (expires) await AsyncStorage.setItem(subscriptionExpiresKey(accountId), expires);
  let jmapAccountId: string | null = null;
  try {
    jmapAccountId = client.accountId;
  } catch {
    jmapAccountId = null;
  }
  await shareAccountWithExtension(accountId, jmapAccountId, client.currentSession?.apiUrl, client.username);
}

/**
 * Register an account's device client id with the relay again, with the
 * device token or endpoint this device has now. Never asks for anything: no
 * permission prompt, no new UnifiedPush registration.
 */
async function registerDeviceWithRelay(relayBaseUrl: string, deviceClientId: string, accountLabel?: string): Promise<void> {
  const transport = await getEffectivePushTransport();
  if (transport === 'apns') {
    const token = (await Notifications.getDevicePushTokenAsync()).data;
    if (typeof token !== 'string' || !token) return;
    await registerWithRelayApns({ relayBaseUrl, subscriptionId: deviceClientId, deviceToken: token, accountLabel });
  } else if (transport === 'unifiedpush') {
    const endpoint = await getUnifiedPushEndpoint();
    if (!endpoint) return;
    await registerWithRelayUnifiedPush({ relayBaseUrl, subscriptionId: deviceClientId, endpoint, accountLabel });
  } else {
    const token = await getFcmToken();
    if (!token) return;
    await registerWithRelay({ relayBaseUrl, subscriptionId: deviceClientId, fcmToken: token, accountLabel });
  }
}

export interface PushAccountState {
  // A subscription is recorded for the account on this device.
  enabled: boolean;
  // The user turned push off for it here (see disablePushForAccount).
  optedOut: boolean;
}

/** What this device knows about each account's push, for the settings. */
export async function readPushAccountStates(accountIds: string[]): Promise<Record<string, PushAccountState>> {
  await migrateLegacyPushKeys();
  const out: Record<string, PushAccountState> = {};
  for (const accountId of accountIds) {
    out[accountId] = {
      enabled: (await AsyncStorage.getItem(subscriptionIdKey(accountId))) !== null,
      optedOut: (await AsyncStorage.getItem(optedOutKey(accountId))) !== null,
    };
  }
  return out;
}

/**
 * Tear down push for ALL accounts on this device. Used by the logout-all
 * flow; best-effort because we typically aren't authenticated to every
 * account's JMAP server at the moment we need to call destroy on it. The
 * FCM token is always deleted so no push gets through regardless.
 */
export async function teardownPushNotifications(): Promise<void> {
  await migrateLegacyPushKeys();

  const accountIds = await readPushAccountIds();
  const relayBaseUrl = await getStoredRelayBaseUrl();

  for (const accountId of accountIds) {
    const storedSubId = await AsyncStorage.getItem(subscriptionIdKey(accountId));
    const storedDcid = await AsyncStorage.getItem(deviceClientIdKey(accountId));

    if (storedSubId) {
      // Will only succeed if the jmapClient happens to be authenticated to
      // this account right now. We don't switch the client to attempt each
      // one; the subscription expires server-side instead (Stalwart keeps
      // one for at most seven days without a refresh).
      await destroyPushSubscription(storedSubId).catch(() => undefined);
    }
    if (relayBaseUrl && storedDcid) {
      await deregisterFromRelay(relayBaseUrl, storedDcid);
    }
    await clearAccountPushKeys(accountId);
  }

  await AsyncStorage.multiRemove([PUSH_ACCOUNT_IDS_KEY, PUSH_JMAP_ACCOUNT_IDS_KEY]);

  const native = getNative();
  if (native) {
    await native.deleteToken().catch(() => undefined);
  }
  // Also release any UnifiedPush registration so the distributor stops
  // holding a channel for us. No-op when never registered.
  await unregisterUnifiedPush().catch(() => undefined);
}

export interface PushDevice {
  // The JMAP PushSubscription id - what you destroy to revoke it.
  id: string;
  // Client-chosen id the relay keys its endpoint mapping on.
  deviceClientId: string;
  expires: string | null;
  types: string[] | null;
  // True when this registration belongs to the device you're looking at.
  isThisDevice: boolean;
  relayStatus: PushRelayStatus;
}

/**
 * Every push registration the JMAP server holds for this account, annotated
 * with whether it is this device and what the relay makes of it.
 *
 * Stalwart hides a subscription's url and verified state from clients, so
 * deviceClientId is the only handle we get. That's enough to spot our own
 * registration and to ask the relay about the rest - but registrations made
 * against a different relay, or by a non-Bulwark client, come back `unknown`
 * rather than dead, and the UI must present them as revocable-but-unclassified.
 */
export async function listPushDevices(params: {
  accountId: string;
  relayBaseUrl?: string;
}): Promise<PushDevice[]> {
  const relayBaseUrl = (params.relayBaseUrl ?? DEFAULT_RELAY_BASE_URL).replace(/\/+$/, '');
  const thisDeviceClientId = await AsyncStorage.getItem(deviceClientIdKey(params.accountId));

  const subs = await listPushSubscriptions();
  return Promise.all(
    subs.map(async (s) => ({
      id: s.id,
      deviceClientId: s.deviceClientId,
      expires: s.expires ?? null,
      types: s.types ?? null,
      isThisDevice: thisDeviceClientId !== null && s.deviceClientId === thisDeviceClientId,
      relayStatus: await relayStatusFor(relayBaseUrl, s.deviceClientId),
    })),
  );
}

/**
 * Revoke one registration. Destroying the JMAP subscription stops the server
 * fanning StateChanges to it; dropping the relay mapping stops the relay
 * forwarding anything already in flight and frees the deviceClientId. Revoking
 * this device runs the full local teardown so the UI doesn't keep claiming push
 * is on.
 */
export async function revokePushDevice(params: {
  accountId: string;
  device: Pick<PushDevice, 'id' | 'deviceClientId' | 'isThisDevice'>;
  relayBaseUrl?: string;
}): Promise<void> {
  const relayBaseUrl = (params.relayBaseUrl ?? DEFAULT_RELAY_BASE_URL).replace(/\/+$/, '');

  if (params.device.isThisDevice) {
    await disablePushForAccount(params.accountId);
    return;
  }

  await destroyPushSubscription(params.device.id);
  if (relayBaseUrl && params.device.deviceClientId) {
    await deregisterFromRelay(relayBaseUrl, params.device.deviceClientId);
  }
}

export type FcmMessageListener = (payload: {
  title?: string;
  body?: string;
  data: Record<string, string>;
}) => void;

export function addMessageListener(listener: FcmMessageListener): () => void {
  if (Platform.OS !== 'android') return () => undefined;
  const emitter = new NativeEventEmitter(NativeModules.BulwarkFcm);
  const sub = emitter.addListener('fcm:message', listener);
  return () => sub.remove();
}

export type FcmTokenListener = (payload: { token: string }) => void;

export function addTokenRefreshListener(listener: FcmTokenListener): () => void {
  if (Platform.OS !== 'android') return () => undefined;
  const emitter = new NativeEventEmitter(NativeModules.BulwarkFcm);
  const sub = emitter.addListener('fcm:newToken', listener);
  return () => sub.remove();
}

export interface NotificationTapPayload {
  emailId: string;
  threadId: string;
  subject?: string;
  // Identifies which logged-in account the notification was generated for.
  // Optional for back-compat: older notifications already on the system tray
  // won't carry this and will fall back to the active account on tap.
  accountId?: string;
  // The JMAP account the message lives in: a group or shared mailbox's account
  // when it isn't the user's own. Absent on older notifications.
  jmapAccountId?: string;
  // Notification action tapped (e.g. 'reply' to jump straight to Compose)
  action?: 'reply';
}

/**
 * The JMAP account to open a tapped notification's message against, in the
 * form the EmailThread route takes: the group or shared account it was
 * delivered from, or undefined for the user's own mail - including
 * notifications posted before the field existed (#839).
 */
export function notificationTapJmapAccountId(payload: NotificationTapPayload): string | undefined {
  if (!payload.jmapAccountId) return undefined;
  let primary: string | null = null;
  try {
    primary = jmapClient.accountId;
  } catch {
    primary = null;
  }
  return payload.jmapAccountId === primary ? undefined : payload.jmapAccountId;
}

// Returns - and clears - any pending "notification tap" that launched the app
// before JS was ready to handle it. Subsequent taps while running are delivered
// via addNotificationTapListener.
export async function getInitialNotificationTap(): Promise<NotificationTapPayload | null> {
  if (Platform.OS === 'ios') {
    const response = await Notifications.getLastNotificationResponseAsync().catch(() => null);
    if (!response || response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return null;
    const handledKey = 'push:lastHandledResponse:v1';
    const id = response.notification.request.identifier;
    // The last response survives app restarts; open it once.
    if ((await AsyncStorage.getItem(handledKey)) === id) return null;
    const payload = await iosTapPayload(response.notification.request.content.data);
    if (payload) await AsyncStorage.setItem(handledKey, id);
    return payload;
  }
  if (Platform.OS !== 'android') return null;
  const native = (NativeModules as Record<string, unknown>).BulwarkFcm as
    | { getInitialNotification?: () => Promise<NotificationTapPayload | null> }
    | undefined;
  if (!native?.getInitialNotification) return null;
  try {
    return (await native.getInitialNotification()) ?? null;
  } catch {
    return null;
  }
}

export function addNotificationTapListener(
  listener: (payload: NotificationTapPayload) => void,
): () => void {
  if (Platform.OS === 'ios') {
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
      const id = response.notification.request.identifier;
      void iosTapPayload(response.notification.request.content.data).then((payload) => {
        if (!payload) return;
        void AsyncStorage.setItem('push:lastHandledResponse:v1', id);
        listener(payload);
      });
    });
    return () => sub.remove();
  }
  if (Platform.OS !== 'android') return () => undefined;
  const emitter = new NativeEventEmitter(NativeModules.BulwarkFcm);
  const sub = emitter.addListener('fcm:notificationTap', listener);
  return () => sub.remove();
}

/**
 * A tapped iOS mail notification as the app opens it. The relay puts the
 * JMAP account and message ids into the payload's `body`, which
 * expo-notifications hands over as `data`; the notification extension adds
 * the message (and thread) it showed. Calendar reminders and other local
 * notifications carry no `kind` and are left to their own handlers.
 */
export async function iosTapPayload(data: unknown): Promise<NotificationTapPayload | null> {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  if (d.kind !== 'jmap-email-push' && d.kind !== 'jmap-state-change') return null;
  const jmapAccountId = typeof d.accountId === 'string' ? d.accountId : '';
  const ids = Array.isArray(d.emailIds) ? d.emailIds.filter((v): v is string => typeof v === 'string') : [];
  const emailId = typeof d.emailId === 'string' && d.emailId ? d.emailId : ids[0];
  if (!emailId) return null;
  // The local account the subscription belongs to: the one whose push
  // setup recorded this JMAP account id. Ids repeat across servers: with
  // more than one such login the relay's label (the username) picks one, and
  // when it can't, the app just opens rather than show another login's
  // message on a guess. A single login has to fit the label too: the push
  // may be for another login's group account, whose id comes from the same
  // short pool.
  const byLocal = await readPushJmapAccountIds();
  let candidates = Object.keys(byLocal).filter((local) => byLocal[local] === jmapAccountId);
  const label = typeof d.accountLabel === 'string' ? d.accountLabel : '';
  if (candidates.length > 1 || (label && candidates.length === 1)) {
    candidates = label ? candidates.filter((local) => accountMatchesPushLabel(local, label)) : [];
    if (candidates.length !== 1) return null;
  }
  const accountId = candidates[0];
  return {
    emailId,
    threadId: typeof d.threadId === 'string' ? d.threadId : '',
    accountId,
    jmapAccountId: jmapAccountId || undefined,
  };
}
