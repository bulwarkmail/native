import { NativeEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  createPushSubscription,
  destroyPushSubscription,
  listPushSubscriptions,
  updatePushSubscription,
  verifyPushSubscription,
} from '../api/push';
import { jmapClient } from '../api/jmap-client';
import { generateAccountId } from './account-utils';

// Persist identifiers across launches so we reuse the same JMAP subscription
// after app restarts. Each account gets its own deviceClientId so the hosted
// relay can distinguish per-account pushes via the URL slot it forwards.
const RELAY_BASE_URL_KEY = 'push:relayBaseUrl:v1';
const PUSH_ACCOUNT_IDS_KEY = 'push:accountIds:v1';
const DEVICE_CLIENT_ID_PREFIX = 'push:deviceClientId:v2:';
const SUBSCRIPTION_ID_PREFIX = 'push:subscriptionId:v2:';
export const LAST_NOTIFIED_EMAIL_ID_PREFIX = 'push:lastNotifiedEmailId:v2:';

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

// Types the mobile app wants StateChange pings for. Submission is excluded -
// outgoing mail state changes don't belong in a user-visible push.
const PUSH_TYPES = ['Email', 'EmailDelivery', 'Mailbox'] as const;

// Maximum expires we ask the server for. Stalwart (and other JMAP servers)
// may clamp this down; whatever they return is what we get. Without this,
// the server picks its own (often short) default and the subscription
// silently expires between app updates - so push stops arriving until the
// user re-enables it from settings.
const SUBSCRIPTION_EXPIRES_DAYS = 90;
// When an existing subscription has less than this much lifetime left, push
// expires forward on the next app start.
const SUBSCRIPTION_REFRESH_THRESHOLD_DAYS = 7;

function expiresFromNow(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

type BulwarkFcmNative = {
  getToken(): Promise<string>;
  deleteToken(): Promise<void>;
};

function getNative(): BulwarkFcmNative | null {
  if (Platform.OS !== 'android') return null;
  return (NativeModules as Record<string, unknown>).BulwarkFcm as BulwarkFcmNative | undefined ?? null;
}

export interface PushSetupParams {
  // Optional - falls back to the hosted relay if omitted.
  relayBaseUrl?: string;
  accountLabel?: string;
}

export interface PushSetupResult {
  subscriptionId: string;
  verified: boolean;
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

function buildRelayUrl(base: string, suffix: string): string {
  return base.replace(/\/+$/, '') + suffix;
}

async function registerWithRelay(params: {
  relayBaseUrl: string;
  subscriptionId: string;
  fcmToken: string;
  accountLabel?: string;
}): Promise<void> {
  const res = await fetch(buildRelayUrl(params.relayBaseUrl, '/api/push/register'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      subscriptionId: params.subscriptionId,
      fcmToken: params.fcmToken,
      accountLabel: params.accountLabel,
    }),
  });
  if (!res.ok) {
    throw new Error(`Relay register failed: ${res.status}`);
  }
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
  while (Date.now() < timeoutAt) {
    const res = await fetch(
      buildRelayUrl(relayBaseUrl, `/api/push/verify/${encodeURIComponent(subscriptionId)}`),
    );
    if (res.ok) {
      const body = (await res.json()) as { verificationCode?: string | null };
      if (body.verificationCode) return body.verificationCode;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(delay * 1.5, 2000);
  }
  throw new Error('Timed out waiting for PushVerification from JMAP server');
}

/**
 * Full setup flow: ask permission, fetch the device's FCM token, register
 * with the relay, create a JMAP PushSubscription, poll for the verification
 * code, and finalise the subscription.
 */
export async function setupPushNotifications(
  params: PushSetupParams,
): Promise<PushSetupResult> {
  const native = getNative();
  if (!native) throw new Error('Push notifications require Android');

  const relayBaseUrl = (params.relayBaseUrl ?? DEFAULT_RELAY_BASE_URL).replace(/\/+$/, '');
  if (!relayBaseUrl) throw new Error('relayBaseUrl is required');

  const granted = await requestNotificationPermission();
  if (!granted) throw new Error('Notification permission denied');

  const fcmToken = await native.getToken();
  if (!fcmToken) throw new Error('FCM token unavailable');

  // setupPushNotifications operates on the currently-loaded jmapClient. We
  // need its username/serverUrl up-front so we can key per-account state.
  const username = jmapClient.username;
  const serverUrl = jmapClient.serverUrl;
  if (!username || !serverUrl) {
    throw new Error('No account loaded - cannot set up push');
  }
  const accountId = generateAccountId(username, serverUrl);

  await migrateLegacyPushKeys();

  const deviceClientId = await getOrCreateDeviceClientId(accountId);
  await setStoredRelayBaseUrl(relayBaseUrl);

  // Register this account's device-client-id with the relay. Multiple
  // accounts on the same device end up as separate registrations sharing
  // one fcmToken - the relay forwards each push individually so the headless
  // task can identify the source account via the FCM data payload.
  await registerWithRelay({
    relayBaseUrl,
    subscriptionId: deviceClientId,
    fcmToken,
    accountLabel: params.accountLabel,
  });

  // Reuse the previous JMAP subscription when the server still has it, but
  // push the expiry forward so it doesn't time out before the next app start.
  const existingSubs = await listPushSubscriptions().catch(() => []);
  const subKey = subscriptionIdKey(accountId);
  const storedServerId = await AsyncStorage.getItem(subKey);
  if (storedServerId) {
    const match = existingSubs.find((s) => s.id === storedServerId);
    if (match) {
      const refreshed = await refreshSubscriptionExpires(match);
      if (refreshed) {
        await addPushAccountId(accountId);
        return { subscriptionId: storedServerId, verified: true };
      }
      // Server rejected the refresh (likely the subscription was already
      // deleted server-side) - drop the stale id and recreate below.
      await destroyPushSubscription(storedServerId).catch(() => undefined);
    }
    await AsyncStorage.removeItem(subKey);
  }

  // Reap any leftover Stalwart subscriptions still bound to this account's
  // deviceClientId. These pile up when a previous enable attempt failed
  // mid-flow (verify race, network blip, app killed). Stalwart per-account
  // rate-limits PushVerification posts, so leaving stragglers around blocks
  // the new one's verification - the symptom is a confusing "code does not
  // match". Only reap matches for THIS account's deviceClientId; other
  // accounts' subscriptions on this server (rare but possible if the same
  // JMAP server backs multiple accounts) must be left alone.
  const stragglers = existingSubs.filter(
    (s) => s.deviceClientId === deviceClientId && s.id !== storedServerId,
  );
  for (const s of stragglers) {
    await destroyPushSubscription(s.id).catch(() => undefined);
  }

  const serverAssignedId = await createPushSubscription({
    deviceClientId,
    url: buildRelayUrl(relayBaseUrl, `/api/push/jmap/${encodeURIComponent(deviceClientId)}`),
    types: [...PUSH_TYPES],
    expires: expiresFromNow(SUBSCRIPTION_EXPIRES_DAYS),
  });

  const verificationCode = await pollVerificationCode(relayBaseUrl, deviceClientId);
  await verifyPushSubscription(serverAssignedId, verificationCode);

  await AsyncStorage.setItem(subKey, serverAssignedId);
  await addPushAccountId(accountId);

  return { subscriptionId: serverAssignedId, verified: true };
}

async function addPushAccountId(accountId: string): Promise<void> {
  const ids = await readPushAccountIds();
  if (!ids.includes(accountId)) {
    await writePushAccountIds([...ids, accountId]);
  }
}

// Push the subscription's expires forward when it's getting close to the
// server's ceiling. Returns false if the server rejects the update, which the
// caller treats as "recreate".
async function refreshSubscriptionExpires(
  sub: { id: string; expires?: string | null },
): Promise<boolean> {
  if (sub.expires) {
    const remainingMs = new Date(sub.expires).getTime() - Date.now();
    const thresholdMs = SUBSCRIPTION_REFRESH_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
    if (Number.isFinite(remainingMs) && remainingMs > thresholdMs) {
      // Plenty of life left - skip the update round-trip.
      return true;
    }
  }
  try {
    return await updatePushSubscription(sub.id, {
      expires: expiresFromNow(SUBSCRIPTION_EXPIRES_DAYS),
    });
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

/**
 * Tear down push for a single account. Destroys that account's JMAP
 * subscription (assumes the jmapClient is currently authenticated to that
 * account; the active-account logout flow guarantees this) and tells the
 * relay to drop its mapping. Other accounts' push setups are untouched.
 *
 * If no accounts have push left after removal, also deletes the FCM token
 * so the device stops receiving FCM messages entirely. Never throws -
 * callers treat teardown as best effort.
 */
export async function teardownPushNotificationsForAccount(
  accountId: string,
): Promise<void> {
  await migrateLegacyPushKeys();

  const subKey = subscriptionIdKey(accountId);
  const storedSubId = await AsyncStorage.getItem(subKey);
  const dcidKey = deviceClientIdKey(accountId);
  const storedDcid = await AsyncStorage.getItem(dcidKey);
  const relayBaseUrl = await getStoredRelayBaseUrl();

  if (storedSubId) {
    await destroyPushSubscription(storedSubId).catch(() => undefined);
  }
  if (relayBaseUrl && storedDcid) {
    await deregisterFromRelay(relayBaseUrl, storedDcid);
  }

  await AsyncStorage.multiRemove([subKey, dcidKey, lastNotifiedKey(accountId)]);

  const remaining = (await readPushAccountIds()).filter((id) => id !== accountId);
  await writePushAccountIds(remaining);

  // If this was the last account with push, kill the FCM token so the device
  // truly goes silent. Otherwise the token stays alive so the remaining
  // accounts keep receiving pushes.
  if (remaining.length === 0) {
    const native = getNative();
    if (native) {
      await native.deleteToken().catch(() => undefined);
    }
  }
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
    const subKey = subscriptionIdKey(accountId);
    const dcidKey = deviceClientIdKey(accountId);
    const storedSubId = await AsyncStorage.getItem(subKey);
    const storedDcid = await AsyncStorage.getItem(dcidKey);

    if (storedSubId) {
      // Will only succeed if the jmapClient happens to be authenticated to
      // this account right now. We don't switch the client to attempt each
      // one; the subscription will expire server-side instead (90-day TTL).
      await destroyPushSubscription(storedSubId).catch(() => undefined);
    }
    if (relayBaseUrl && storedDcid) {
      await deregisterFromRelay(relayBaseUrl, storedDcid);
    }
    await AsyncStorage.multiRemove([subKey, dcidKey, lastNotifiedKey(accountId)]);
  }

  await AsyncStorage.removeItem(PUSH_ACCOUNT_IDS_KEY);

  const native = getNative();
  if (native) {
    await native.deleteToken().catch(() => undefined);
  }
}

export type FcmMessageListener = (payload: {
  title: string;
  body: string;
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
