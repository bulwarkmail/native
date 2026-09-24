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
import { jmapClient } from '../api/jmap-client';
import { JMAPMethodError } from '../api/jmap-result';
import { CAPABILITIES } from '../api/types';
import type { EmailPushConfig, JMAPAccountInfo, Mailbox } from '../api/types';
import { generateAccountId } from './account-utils';
import {
  getUnifiedPushDistributors,
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
// one that was revoked (leave push off).
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
// expires forward on the next app start.
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
 * The delivery filter we want on every account the subscription fans out to:
 * skip anything the spam filter tagged `$junk` and anything that lives only in
 * a Junk-role mailbox (Sieve `fileinto` doesn't set the keyword). The two are
 * ANDed so a stale mailbox id - the user deleted and recreated Junk - degrades
 * to keyword-only filtering rather than letting everything through.
 */
export async function buildEmailPushConfig(): Promise<Record<string, EmailPushConfig>> {
  const primary = jmapClient.accountId;
  const junkByAccount = new Map<string, string[]>([[primary, []]]);
  const own = await getMailboxes().catch(() => [] as Mailbox[]);
  const shared = await getSharedMailboxes().catch(() => [] as Mailbox[]);
  for (const m of [...own, ...shared]) {
    const accountId = m.accountId || primary;
    const junk = junkByAccount.get(accountId) ?? [];
    // Shared-account mailboxes carry a client-side "<account>:<id>" id;
    // the server only knows the original.
    if (m.role === 'junk') junk.push(m.originalId ?? m.id);
    junkByAccount.set(accountId, junk);
  }

  const config: Record<string, EmailPushConfig> = {};
  for (const [accountId, junkIds] of junkByAccount) {
    const conditions: Record<string, unknown>[] = [{ notKeyword: '$junk' }];
    if (junkIds.length > 0) conditions.push({ inMailboxOtherThan: [...junkIds].sort() });
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
 * emailPushFallbacks while the server refuses it as `forbidden`. Resolves to
 * the write's result and the map the server took.
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
      const forbidden = err instanceof JMAPMethodError && err.type === 'forbidden';
      if (!forbidden || i === attempts.length - 1) throw err;
      logPhase('jmap', 'emailPush map refused, retrying with fewer accounts');
    }
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

type BulwarkFcmNative = {
  getToken(): Promise<string>;
  deleteToken(): Promise<void>;
};

function getNative(): BulwarkFcmNative | null {
  if (Platform.OS !== 'android') return null;
  return (NativeModules as Record<string, unknown>).BulwarkFcm as BulwarkFcmNative | undefined ?? null;
}

/** True on platforms that have a push transport wired up (Android only). */
export function isPushSupported(): boolean {
  return getNative() !== null || isUnifiedPushSupported();
}

export type PushTransport = 'fcm' | 'unifiedpush';

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

export async function wasPushPromptDismissed(accountId: string): Promise<boolean> {
  return (await AsyncStorage.getItem(promptDismissedKey(accountId))) !== null;
}

export async function dismissPushPrompt(accountId: string): Promise<void> {
  await AsyncStorage.setItem(promptDismissedKey(accountId), String(Date.now()));
}

export async function requestNotificationPermission(): Promise<boolean> {
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
    const hint =
      distributors.length > 0
        ? ' This device has a UnifiedPush distributor installed - switch the delivery method to UnifiedPush instead.'
        : '';
    throw new PushSetupError(
      'token',
      `Firebase could not issue a device token (${detail}). Push over FCM needs Google Play services on this device.${hint}`,
    );
  }
  if (!token) {
    throw new PushSetupError('token', 'Firebase returned an empty device token.');
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
    throw new PushSetupError('relay', `Could not reach the push relay at ${params.relayBaseUrl} (${detail}).`);
  }
  if (!res.ok) {
    throw new PushSetupError('relay', `The push relay rejected the registration: ${await readRelayError(res)}`);
  }
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
    throw new PushSetupError('relay', `Could not reach the push relay at ${params.relayBaseUrl} (${detail}).`);
  }
  if (!res.ok) {
    throw new PushSetupError('relay', `The push relay rejected the registration: ${await readRelayError(res)}`);
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
      ? `The relay never received the verification code from the mail server (last relay response: ${lastRelayError}).`
      : 'The mail server did not send a verification code to the relay within 75 s. Check that the server can reach the relay URL.',
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
  const run = setupPushNotificationsInner(params).finally(() => {
    inFlightSetups.delete(key);
  });
  inFlightSetups.set(key, run);
  return run;
}

function logPhase(phase: string, detail?: string): void {
  console.log(`[push] ${phase}${detail ? `: ${detail}` : ''}`);
}

async function setupPushNotificationsInner(
  params: PushSetupParams,
): Promise<PushSetupResult> {
  const transport = await getEffectivePushTransport();
  const native = getNative();
  if (transport === 'fcm' && !native) {
    throw new PushSetupError('platform', 'Push notifications are only available on Android.');
  }
  if (transport === 'unifiedpush' && !isUnifiedPushSupported()) {
    throw new PushSetupError('platform', 'UnifiedPush is only available on Android.');
  }

  const relayBaseUrl = (params.relayBaseUrl ?? DEFAULT_RELAY_BASE_URL).replace(/\/+$/, '');
  if (!relayBaseUrl) throw new PushSetupError('relay', 'relayBaseUrl is required');
  if (!isValidRelayUrl(relayBaseUrl)) {
    throw new PushSetupError('relay', 'The relay URL must use https://.');
  }

  logPhase('permission');
  const granted = await requestNotificationPermission();
  if (!granted) {
    throw new PushSetupError('permission', 'Notification permission was not granted.');
  }

  logPhase('token', transport);
  let fcmToken: string | null = null;
  let upEndpoint: UnifiedPushEndpoint | null = null;
  if (transport === 'unifiedpush') {
    upEndpoint = await getUnifiedPushEndpointOrThrow(relayBaseUrl);
  } else {
    fcmToken = await getFcmTokenOrThrow(native!);
  }

  // setupPushNotifications operates on the currently-loaded jmapClient. We
  // need its username/serverUrl up-front so we can key per-account state.
  const username = jmapClient.username;
  const serverUrl = jmapClient.serverUrl;
  if (!username || !serverUrl) {
    throw new PushSetupError('account', 'No account loaded - cannot set up push.');
  }
  const accountId = generateAccountId(username, serverUrl);

  await migrateLegacyPushKeys();

  const deviceClientId = await getOrCreateDeviceClientId(accountId);
  await setStoredRelayBaseUrl(relayBaseUrl);

  // Register this account's device-client-id with the relay. Multiple
  // accounts on the same device end up as separate registrations sharing
  // one FCM token / UnifiedPush endpoint - the relay forwards each push
  // individually and tags it with the JMAP account id so the headless task
  // can route it.
  logPhase('relay', relayBaseUrl);
  if (upEndpoint) {
    await registerWithRelayUnifiedPush({
      relayBaseUrl,
      subscriptionId: deviceClientId,
      endpoint: upEndpoint,
      accountLabel: params.accountLabel,
    });
  } else {
    await registerWithRelay({
      relayBaseUrl,
      subscriptionId: deviceClientId,
      fcmToken: fcmToken!,
      accountLabel: params.accountLabel,
    });
  }

  // Reuse the previous JMAP subscription when the server still has it, but
  // push the expiry forward so it doesn't time out before the next app start.
  // With forceRecreate we skip the reuse and replace it instead (#841). Either
  // way the old record keeps delivering until its replacement is verified, so
  // a replacement the server refuses never leaves the device without push.
  logPhase('jmap');
  const existingSubs = await listPushSubscriptions().catch(() => []);
  // A forced re-registration re-learns which accounts the server accepts in
  // the emailPush map.
  if (params.forceRecreate) await AsyncStorage.removeItem(emailPushRefusedKey(accountId));
  const refusedBefore = await readRefusedEmailPushAccounts(accountId);
  const emailPush = serverSupportsEmailPush()
    ? withoutAccounts(await buildEmailPushConfig(), refusedBefore)
    : null;
  const subKey = subscriptionIdKey(accountId);
  const storedServerId = await AsyncStorage.getItem(subKey);
  let jmapAccountId: string | null = null;
  try {
    jmapAccountId = jmapClient.accountId;
  } catch {
    jmapAccountId = null;
  }
  let replacedServerId: string | null = null;
  if (storedServerId) {
    const match = existingSubs.find((s) => s.id === storedServerId);
    if (match) {
      if (match.expires) await AsyncStorage.setItem(subscriptionExpiresKey(accountId), match.expires);
      if (!params.forceRecreate) {
        const refreshed = await refreshSubscriptionExpires(match, emailPush);
        if (refreshed) {
          await rememberRefusedEmailPushAccounts(accountId, refusedBefore, emailPush, refreshed.emailPush);
          await addPushAccountId(accountId);
          await writePushJmapAccountId(accountId, jmapAccountId);
          await AsyncStorage.removeItem(optedOutKey(accountId));
          logPhase('done', 'reused existing subscription');
          return { subscriptionId: storedServerId, verified: true };
        }
      }
      // Server rejected the refresh or the caller asked for a fresh record:
      // create a replacement below and destroy this one once it's verified.
      replacedServerId = storedServerId;
    } else {
      await AsyncStorage.removeItem(subKey);
    }
  }

  // Reap leftover Stalwart subscriptions that would otherwise starve the new
  // one's verification. Stalwart emits only one PushVerification per account
  // per ~60s and picks the oldest unverified subscription, so a single stale
  // straggler blocks every fresh attempt - the symptom is the confusing
  // "Timed out waiting for PushVerification" error. We can't read a
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
    if (s.id === storedServerId) continue;
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
  try {
    const created = await writeWithEmailPush(emailPush, (filter) =>
      createPushSubscription({
        deviceClientId,
        url: buildRelayUrl(relayBaseUrl, `/api/push/jmap/${encodeURIComponent(deviceClientId)}`),
        types: [...PUSH_TYPES],
        expires: expiresFromNow(SUBSCRIPTION_EXPIRES_DAYS),
        ...(filter ? { emailPush: filter } : {}),
      }),
    );
    serverAssignedId = created.result.id;
    serverExpires = created.result.expires;
    await rememberRefusedEmailPushAccounts(accountId, refusedBefore, emailPush, created.emailPush);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PushSetupError('jmap', `The mail server refused the push subscription: ${detail}`);
  }

  logPhase('verify');
  const verificationCode = await pollVerificationCode(relayBaseUrl, deviceClientId);
  try {
    await verifyPushSubscription(serverAssignedId, verificationCode);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new PushSetupError('verify', `The mail server rejected the verification code: ${detail}`);
  }

  await AsyncStorage.setItem(subKey, serverAssignedId);
  if (serverExpires) await AsyncStorage.setItem(subscriptionExpiresKey(accountId), serverExpires);
  if (replacedServerId) {
    await destroyPushSubscription(replacedServerId).catch(() => undefined);
  }
  await addPushAccountId(accountId);
  await writePushJmapAccountId(accountId, jmapAccountId);
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
// listens to `Email`/`Mailbox`; a Junk mailbox id can change under us).
// Returns false if the server rejects the update, which the caller treats as
// "replace"; otherwise the emailPush map the update installed (null when it
// left the filter alone).
async function refreshSubscriptionExpires(
  sub: {
    id: string;
    expires?: string | null;
    types?: string[] | null;
    emailPush?: Record<string, EmailPushConfig> | null;
  },
  // null when the server has no emailPush support - leave the property alone.
  desiredEmailPush: Record<string, EmailPushConfig> | null,
): Promise<false | { emailPush: Record<string, EmailPushConfig> | null }> {
  const typesNeedUpdate = !sameTypes(sub.types, PUSH_TYPES);
  const emailPushNeedsUpdate =
    desiredEmailPush !== null && !sameEmailPush(sub.emailPush, desiredEmailPush);
  if (!typesNeedUpdate && !emailPushNeedsUpdate && sub.expires) {
    const remainingMs = new Date(sub.expires).getTime() - Date.now();
    const thresholdMs = SUBSCRIPTION_REFRESH_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
    if (Number.isFinite(remainingMs) && remainingMs > thresholdMs) {
      // Plenty of life left - skip the update round-trip.
      return { emailPush: null };
    }
  }
  try {
    const patch: { expires?: string; types?: string[] } = {
      expires: expiresFromNow(SUBSCRIPTION_EXPIRES_DAYS),
    };
    if (typesNeedUpdate) patch.types = [...PUSH_TYPES];
    const { emailPush } = await writeWithEmailPush(
      emailPushNeedsUpdate ? desiredEmailPush : null,
      (filter) => updatePushSubscription(sub.id, filter ? { ...patch, emailPush: filter } : patch),
    );
    return { emailPush };
  } catch {
    return false;
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
 * Tear down push for a single account. Destroys every JMAP subscription the
 * server holds for this device (assumes the jmapClient is currently
 * authenticated to that account; the active-account logout flow guarantees
 * this) and tells the relay to drop its mapping. Other accounts' push setups
 * are untouched.
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
  const idsToDestroy = new Set<string>();
  if (storedSubId) idsToDestroy.add(storedSubId);
  if (storedDcid) {
    const existing = await listPushSubscriptions().catch(() => []);
    for (const s of existing) {
      if (s.deviceClientId === storedDcid) idsToDestroy.add(s.id);
    }
  }
  for (const id of idsToDestroy) {
    await destroyPushSubscription(id).catch(() => undefined);
  }
  if (relayBaseUrl && storedDcid) {
    await deregisterFromRelay(relayBaseUrl, storedDcid);
  }

  await clearAccountPushKeys(accountId);

  const remaining = (await readPushAccountIds()).filter((id) => id !== accountId);
  await writePushAccountIds(remaining);
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
 * expiry (a registration made by an older build) nothing can be told apart,
 * so it counts as not revoked. Throws when the server can't be asked.
 */
async function wasRevokedOnServer(accountId: string): Promise<boolean> {
  const storedServerId = await AsyncStorage.getItem(subscriptionIdKey(accountId));
  const expires = Date.parse((await AsyncStorage.getItem(subscriptionExpiresKey(accountId))) ?? '');
  if (!storedServerId || !Number.isFinite(expires)) return false;
  if (expires - Date.now() < REVOKED_EXPIRY_MARGIN_MS) return false;
  const subs = await listPushSubscriptions();
  return !subs.some((s) => s.id === storedServerId);
}

/**
 * Bring the loaded account's registration up to date without user action -
 * on launch and when the push token or endpoint rotates. Skips an account the
 * user turned push off for, and honours a revocation: when the server dropped
 * the subscription before it was due to expire, push is turned off for the
 * account instead of being silently registered again. Resolves to null when
 * it left push off.
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
      // one; the subscription will expire server-side instead (90-day TTL).
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
  if (Platform.OS !== 'android') return () => undefined;
  const emitter = new NativeEventEmitter(NativeModules.BulwarkFcm);
  const sub = emitter.addListener('fcm:notificationTap', listener);
  return () => sub.remove();
}
