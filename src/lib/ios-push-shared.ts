// What the app shares with the iOS notification service extension
// (plugins/ios-push): account credentials, where to reach each pushed account,
// and the badge counts. They live in a keychain access group both targets
// belong to; nothing else of the app is visible to the extension.
//
// Readable after the first unlock: a push usually arrives while the phone is
// locked, and a notification that has to wait for the user to unlock would
// show only "New message". On this device only: the items stay out of
// encrypted backups and device-to-device transfers, so a restored device asks
// for the sign-in again.

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
  return { accessGroup: group, keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
}

// A keychain item keeps the class it was added with: writing it again only
// replaces the value (expo-secure-store updates an existing item's data). An
// item an earlier version added with another class is deleted and added anew
// once; this marker, itself device-only, says that happened on this device.
// A device restored from a backup has the items but not the markers, so it
// does it again.
const CLASS_MARKER_PREFIX = 'bulwark_device_only__';
// A copy of a credentials item while it is replaced (replaceSharedSecret).
const REWRITE_COPY_PREFIX = 'bulwark_rewrite__';

async function hasCurrentClass(key: string, options: SecureStore.SecureStoreOptions): Promise<boolean> {
  return (await SecureStore.getItemAsync(CLASS_MARKER_PREFIX + key, options).catch(() => null)) === '1';
}

async function markCurrentClass(key: string, options: SecureStore.SecureStoreOptions): Promise<void> {
  await SecureStore.setItemAsync(CLASS_MARKER_PREFIX + key, '1', options).catch(() => undefined);
}

/**
 * Write an item the extension or the widget reads and the app can build
 * again (push entries, settings, the widget snapshot): the first write on
 * this device replaces the item, so it gets the class of sharedStoreOptions.
 */
export async function writeSharedItem(key: string, value: string, options: SecureStore.SecureStoreOptions): Promise<void> {
  if (!(await hasCurrentClass(key, options))) await SecureStore.deleteItemAsync(key, options).catch(() => undefined);
  await SecureStore.setItemAsync(key, value, options);
  await markCurrentClass(key, options);
}

// Writes of one credentials item, one after the other: the start-up rewrite
// must not put back a value a token refresh replaced meanwhile.
const keyQueues = new Map<string, Promise<unknown>>();

function serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
  const previous = keyQueues.get(key) ?? Promise.resolve();
  const next = previous.then(run, run);
  const settled = next.then(() => undefined, () => undefined);
  keyQueues.set(key, settled);
  void settled.then(() => {
    if (keyQueues.get(key) === settled) keyQueues.delete(key);
  });
  return next;
}

/**
 * Add a credentials item anew with the class of `shared`, keeping the
 * stored sign-in when the keychain refuses: a copy is written first, and
 * nothing is deleted when that fails. When adding the item back fails, it
 * goes back with the class it had.
 */
async function replaceSharedSecret(key: string, value: string, shared: SecureStore.SecureStoreOptions): Promise<void> {
  const copy = REWRITE_COPY_PREFIX + key;
  await SecureStore.setItemAsync(copy, value, shared);
  await SecureStore.deleteItemAsync(key, shared);
  try {
    await SecureStore.setItemAsync(key, value, shared);
  } catch (err) {
    await SecureStore.setItemAsync(key, value, { accessGroup: shared.accessGroup, keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK })
      .catch(() => undefined);
    throw err;
  }
  await SecureStore.deleteItemAsync(copy, shared).catch(() => undefined);
  await markCurrentClass(key, shared);
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
  /**
   * The username the account registered with the relay, which the relay
   * sends back as the push's accountLabel. The extension leaves a push whose
   * label is another's as the placeholder: it may be for another login's
   * group account that has this account's id.
   */
  label?: string;
  /**
   * This device's PushSubscription on the account's server, so the native
   * side keeps it alive (plugins/ios-push/PushRenewal.swift): Stalwart drops
   * a subscription seven days after its last refresh, and on iOS the app's JS
   * runs only when the app is opened. The native side extends it only while
   * the server still lists it with this device's client id, and writes the
   * expiry it settled on back here.
   */
  subscriptionId?: string;
  deviceClientId?: string;
  /** When the subscription expires, as last recorded (UTCDate). */
  subscriptionExpires?: string;
  /**
   * The login's organisation wants new-mail notifications to say only that
   * there is new mail (organisation.devices.pushWithoutContent): the
   * extension keeps the relay's placeholder and fetches nothing. Present
   * only while the rule is on.
   */
  withoutContent?: true;
}

export async function writeIosPushAccount(jmapAccountId: string, account: IosPushAccount): Promise<void> {
  const options = sharedStoreOptions();
  if (!options) return;
  await writeSharedItem(pushAccountKey(jmapAccountId), JSON.stringify(account), options);
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
  await writeSharedItem(PUSH_SETTINGS_KEY, JSON.stringify(settings), options);
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
  await serialized(key, async () => {
    if (await hasCurrentClass(key, shared)) await SecureStore.setItemAsync(key, value, shared);
    else await replaceSharedSecret(key, value, shared);
  });
  const own = appStoreOptions();
  if (own) await SecureStore.deleteItemAsync(key, own).catch(() => undefined);
}

/**
 * The step every start runs for each account's credentials item (jmap-client
 * loadAccount and loadAccountFromCache). Moves an item saved before the
 * shared group existed into it, and adds an item an earlier version stored
 * there with another class anew, with the class of sharedStoreOptions. When
 * the keychain refuses (a start before the first unlock), the item stays as
 * it is and the next start tries again. True if it moved.
 */
export async function moveToSharedGroup(key: string): Promise<boolean> {
  const shared = sharedStoreOptions();
  if (!shared) return false;
  const own = appStoreOptions();
  const fromOwn = own ? await SecureStore.getItemAsync(key, own).catch(() => null) : null;
  if (fromOwn !== null) {
    await writeSharedSecret(key, fromOwn);
    return true;
  }
  await serialized(key, async () => {
    if (await hasCurrentClass(key, shared)) return;
    const value = await SecureStore.getItemAsync(key, shared);
    if (value !== null) await replaceSharedSecret(key, value, shared);
  });
  return false;
}
