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
// after app restarts. deviceClientId also routes to the relay slot.
const DEVICE_CLIENT_ID_KEY = 'push:deviceClientId:v1';
const SUBSCRIPTION_ID_KEY = 'push:subscriptionId:v1';
const RELAY_BASE_URL_KEY = 'push:relayBaseUrl:v1';
const PUSH_ACCOUNT_ID_KEY = 'push:accountId:v1';
const LAST_NOTIFIED_EMAIL_ID_KEY = 'push:lastNotifiedEmailId:v1';

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

async function getOrCreateDeviceClientId(): Promise<string> {
  const existing = await AsyncStorage.getItem(DEVICE_CLIENT_ID_KEY);
  if (existing) return existing;
  const next = randomClientId();
  await AsyncStorage.setItem(DEVICE_CLIENT_ID_KEY, next);
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
  const timeoutAt = Date.now() + 20_000;
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

  const deviceClientId = await getOrCreateDeviceClientId();
  await setStoredRelayBaseUrl(relayBaseUrl);

  // Persist the account id so the background push task can reload credentials
  // from SecureStore without the main app being running.
  const username = jmapClient.username;
  const serverUrl = jmapClient.serverUrl;
  if (username && serverUrl) {
    await AsyncStorage.setItem(
      PUSH_ACCOUNT_ID_KEY,
      generateAccountId(username, serverUrl),
    );
  }

  await registerWithRelay({
    relayBaseUrl,
    subscriptionId: deviceClientId,
    fcmToken,
    accountLabel: params.accountLabel,
  });

  // Reuse the previous JMAP subscription when the server still has it, but
  // push the expiry forward so it doesn't time out before the next app start.
  const storedServerId = await AsyncStorage.getItem(SUBSCRIPTION_ID_KEY);
  if (storedServerId) {
    const existing = await listPushSubscriptions().catch(() => []);
    const match = existing.find((s) => s.id === storedServerId);
    if (match) {
      const refreshed = await refreshSubscriptionExpires(match);
      if (refreshed) {
        return { subscriptionId: storedServerId, verified: true };
      }
      // Server rejected the refresh (likely the subscription was already
      // deleted server-side) - drop the stale id and recreate below.
      await destroyPushSubscription(storedServerId).catch(() => undefined);
    }
    await AsyncStorage.removeItem(SUBSCRIPTION_ID_KEY);
  }

  const serverAssignedId = await createPushSubscription({
    deviceClientId,
    url: buildRelayUrl(relayBaseUrl, `/api/push/jmap/${encodeURIComponent(deviceClientId)}`),
    types: [...PUSH_TYPES],
    expires: expiresFromNow(SUBSCRIPTION_EXPIRES_DAYS),
  });

  const verificationCode = await pollVerificationCode(relayBaseUrl, deviceClientId);
  await verifyPushSubscription(serverAssignedId, verificationCode);

  await AsyncStorage.setItem(SUBSCRIPTION_ID_KEY, serverAssignedId);

  return { subscriptionId: serverAssignedId, verified: true };
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

/**
 * Tear down push on logout / disable. Removes the server-side JMAP
 * subscription, tells the relay to drop the mapping, and clears the local
 * FCM token. Never throws - callers treat teardown as best effort.
 */
export async function teardownPushNotifications(): Promise<void> {
  const storedId = await AsyncStorage.getItem(SUBSCRIPTION_ID_KEY);
  const relayBaseUrl = await getStoredRelayBaseUrl();
  const deviceClientId = await AsyncStorage.getItem(DEVICE_CLIENT_ID_KEY);

  if (storedId) {
    await destroyPushSubscription(storedId).catch(() => undefined);
    await AsyncStorage.removeItem(SUBSCRIPTION_ID_KEY);
  }
  if (relayBaseUrl && deviceClientId) {
    await fetch(
      buildRelayUrl(relayBaseUrl, `/api/push/register/${encodeURIComponent(deviceClientId)}`),
      { method: 'DELETE' },
    ).catch(() => undefined);
  }
  await AsyncStorage.removeItem(PUSH_ACCOUNT_ID_KEY);
  await AsyncStorage.removeItem(LAST_NOTIFIED_EMAIL_ID_KEY);
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
