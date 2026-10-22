// What the app shares with the iOS notification service extension
// (plugins/ios-push): account credentials, where to reach each pushed account,
// and the badge counts. They live in a keychain access group both targets
// belong to; nothing else of the app is visible to the extension.
//
// Readable after the first unlock: a push usually arrives while the phone is
// locked, and a notification that has to wait for the user to unlock would
// show only "New message".

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

type Extra = { iosSharedKeychainGroup?: unknown; iosAppKeychainGroup?: unknown; apnsEnvironment?: unknown };

// Loaded on first use, on iOS only: the module pulls in native code that
// Android's headless tasks and the unit tests can do without.
function extra(): Extra {
  const { default: Constants } = require('expo-constants') as typeof import('expo-constants');
  return (Constants.expoConfig?.extra ?? {}) as Extra;
}

/** The APNs host this build's device tokens belong to. */
export function apnsEnvironment(): 'production' | 'sandbox' {
  return extra().apnsEnvironment === 'sandbox' ? 'sandbox' : 'production';
}

/** The access group shared with the extension, or null off iOS. */
export function sharedKeychainGroup(): string | null {
  if (Platform.OS !== 'ios') return null;
  const group = extra().iosSharedKeychainGroup;
  return typeof group === 'string' && group ? group : null;
}

/** Options for an item the extension must read. Undefined off iOS. */
export function sharedStoreOptions(): SecureStore.SecureStoreOptions | undefined {
  const group = sharedKeychainGroup();
  if (!group) return undefined;
  return { accessGroup: group, keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };
}

/** Options naming the app's own access group, where items used to live. */
export function appStoreOptions(): SecureStore.SecureStoreOptions | undefined {
  if (Platform.OS !== 'ios') return undefined;
  const group = extra().iosAppKeychainGroup;
  return typeof group === 'string' && group ? { accessGroup: group } : undefined;
}

// SecureStore keys: letters, digits, ".", "-", "_" only. The extension
// builds the same key from the push's account id (NotificationService.swift).
function keyPart(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '_');
}

export function pushAccountKey(jmapAccountId: string): string {
  return `bulwark_push_account__${keyPart(jmapAccountId)}`;
}

export const PUSH_SETTINGS_KEY = 'bulwark_push_settings';

export interface IosPushAccount {
  /** SecureStore key of the account's credentials. */
  credentialsKey: string;
  /** The JMAP API URL as the app uses it (rewritten to the server's host). */
  apiUrl: string;
}

export async function writeIosPushAccount(jmapAccountId: string, account: IosPushAccount): Promise<void> {
  const options = sharedStoreOptions();
  if (!options) return;
  await SecureStore.setItemAsync(pushAccountKey(jmapAccountId), JSON.stringify(account), options);
}

export async function removeIosPushAccount(jmapAccountId: string): Promise<void> {
  const options = sharedStoreOptions();
  if (!options) return;
  await SecureStore.deleteItemAsync(pushAccountKey(jmapAccountId), options).catch(() => undefined);
}

export interface IosPushSettings {
  /** Show the unread count on the app icon. */
  badge: boolean;
  /** JMAP id of the active account: the badge is its inbox unread count. */
  activeAccountId: string | null;
  /** The few texts the extension writes itself, in the app's language. */
  strings: { noSubject: string; more: string };
}

export async function writeIosPushSettings(settings: IosPushSettings): Promise<void> {
  const options = sharedStoreOptions();
  if (!options) return;
  await SecureStore.setItemAsync(PUSH_SETTINGS_KEY, JSON.stringify(settings), options);
}

/**
 * Store a credentials item where the extension can read it. Written to the
 * shared group first, then removed from the app's own group, so a crash in
 * between leaves two copies rather than none. Off iOS a plain write.
 */
export async function writeSharedSecret(key: string, value: string): Promise<void> {
  const shared = sharedStoreOptions();
  if (!shared) {
    await SecureStore.setItemAsync(key, value);
    return;
  }
  await SecureStore.setItemAsync(key, value, shared);
  const own = appStoreOptions();
  if (own) await SecureStore.deleteItemAsync(key, own).catch(() => undefined);
}

/** Move an item saved before the shared group existed. True if it moved. */
export async function moveToSharedGroup(key: string): Promise<boolean> {
  const own = appStoreOptions();
  if (!own || !sharedStoreOptions()) return false;
  const value = await SecureStore.getItemAsync(key, own).catch(() => null);
  if (value === null) return false;
  await writeSharedSecret(key, value);
  return true;
}
