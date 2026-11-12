// On iOS the stored sign-in (password or tokens) never leaves the device in an
// encrypted backup or a device-to-device transfer.
//
// A new item gets the "this device only" class from sharedStoreOptions. An
// item that is already in the keychain keeps its class on every write, so the
// ones an earlier version stored get the class at launch from native code, in
// place (SharedKeychain.keepOnThisDevice, called from PushRenewalTask.register
// in AppDelegate): that part is checked in the Swift source here and needs a
// device to run. The JS side never takes an item out.
//
// The keychain is a small fake that keeps value and class per group, as iOS
// does through expo-secure-store: a write to an item that exists replaces its
// value and keeps its class. The assertions are on what ends up stored.
// expo-constants is stood in for both ways the module could load it (require
// and import).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { createRequire } from 'node:module';

const SHARED = 'TEAM.org.bulwarkmail.shared';
const OWN = 'TEAM.org.bulwarkmail.mobile';
const constants = { default: { expoConfig: { extra: { iosSharedKeychainGroup: SHARED, iosAppKeychainGroup: OWN } } } };

vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('expo-constants', () => constants);
// ios-push-shared loads expo-constants with a plain require(), which vi.mock
// doesn't see: put the same stand-in into Node's module cache as well.
const req = createRequire(path.resolve(__dirname, '../ios-push-shared.ts'));
const constantsPath = req.resolve('expo-constants');
req.cache[constantsPath] = { id: constantsPath, filename: constantsPath, loaded: true, children: [], paths: [], exports: constants } as never;

// A keychain: one item per access group and key, with the class it was added
// with. `locked` stands for a start before the first unlock: every call fails.
const keychain = new Map<string, { value: string; accessible: number | undefined }>();
const slot = (key: string, options?: { accessGroup?: string }) => `${options?.accessGroup ?? '(default)'}|${key}`;
const state = vi.hoisted(() => ({ locked: false }));
const refuseWhenLocked = () => {
  if (state.locked) throw new Error('User interaction is not allowed.');
};

vi.mock('expo-secure-store', () => ({
  // The real module's constants (expo-secure-store SecureStore.ts).
  AFTER_FIRST_UNLOCK: 0,
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 1,
  ALWAYS: 2,
  WHEN_PASSCODE_SET_THIS_DEVICE_ONLY: 3,
  ALWAYS_THIS_DEVICE_ONLY: 4,
  WHEN_UNLOCKED: 5,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
  // SecItemAdd, or for an item that exists SecItemUpdate of its data alone
  // (expo-secure-store ios/SecureStoreModule.swift): the class stays.
  setItemAsync: vi.fn(async (key: string, value: string, options?: { accessGroup?: string; keychainAccessible?: number }) => {
    refuseWhenLocked();
    const existing = keychain.get(slot(key, options));
    keychain.set(slot(key, options), { value, accessible: existing ? existing.accessible : options?.keychainAccessible });
  }),
  getItemAsync: vi.fn(async (key: string, options?: { accessGroup?: string }) => {
    refuseWhenLocked();
    return keychain.get(slot(key, options))?.value ?? null;
  }),
  deleteItemAsync: vi.fn(async (key: string, options?: { accessGroup?: string }) => {
    refuseWhenLocked();
    keychain.delete(slot(key, options));
  }),
}));

import fs from 'node:fs';
import * as SecureStore from 'expo-secure-store';
import {
  moveToSharedGroup, PUSH_SETTINGS_KEY, pushAccountKey, sharedStoreOptions, writeIosPushAccount, writeIosPushSettings,
  writeSharedSecret,
} from '../ios-push-shared';

const KEY = 'jmap_credentials__alice_example.org_mail.example.com';
const VALUE = '{"password":"not-a-real-password"}';
const DEVICE_ONLY = 1;
const OLD_CLASS = 0;

beforeEach(() => {
  keychain.clear();
  state.locked = false;
  vi.clearAllMocks();
});

describe('iOS keychain class of the stored sign-in', () => {
  it('shares with the notification extension, readable after first unlock, on this device only', () => {
    const options = sharedStoreOptions();
    expect(options?.accessGroup).toBe(SHARED);
    expect(options?.keychainAccessible).toBe(SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY);
  });

  it('writes the credentials, the push account entry and the push settings with that class', async () => {
    await writeSharedSecret(KEY, VALUE);
    await writeIosPushAccount('jmap-1', { credentialsKey: KEY, apiUrl: 'https://mail.example.com/jmap/' });
    await writeIosPushSettings({ badge: true, activeAccountId: 'jmap-1', strings: { noSubject: '(no subject)', more: 'and {count} more' } });
    for (const key of [KEY, pushAccountKey('jmap-1'), PUSH_SETTINGS_KEY]) {
      const item = keychain.get(slot(key, { accessGroup: SHARED }));
      expect(item, `${key} is in the shared group`).toBeDefined();
      expect(item!.accessible, `${key} stays on this device`).toBe(DEVICE_ONLY);
    }
  });

  it('leaves an item an earlier version stored in the shared group in place for the class change at launch', async () => {
    keychain.set(slot(KEY, { accessGroup: SHARED }), { value: VALUE, accessible: OLD_CLASS });
    await moveToSharedGroup(KEY); // the start-up step for this account in jmap-client
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    expect(keychain.get(slot(KEY, { accessGroup: SHARED }))?.value, 'the sign-in is still there').toBe(VALUE);
    expect(launchStepChangesClassInPlace(), 'and the launch step gives it the new class').toBe(true);
  });

  it('gives an item that still sits in the app\'s own group the new class when it moves', async () => {
    keychain.set(slot(KEY, { accessGroup: OWN }), { value: VALUE, accessible: OLD_CLASS });
    await moveToSharedGroup(KEY); // the start-up step for this account
    const item = keychain.get(slot(KEY, { accessGroup: SHARED }));
    expect(item?.value).toBe(VALUE);
    expect(item?.accessible).toBe(DEVICE_ONLY);
    expect(keychain.has(slot(KEY, { accessGroup: OWN })), 'no second copy with the old class is left').toBe(false);
  });

  it('does not lose the sign-in when the move fails', async () => {
    keychain.set(slot(KEY, { accessGroup: OWN }), { value: VALUE, accessible: OLD_CLASS });
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('keychain is locked'));
    await moveToSharedGroup(KEY).catch(() => undefined);
    expect(keychain.get(slot(KEY, { accessGroup: OWN }))?.value).toBe(VALUE);
  });
});

// The native side, read from its source as ios-push-renewal.test.ts does:
// what runs on an iPhone was not run here.
const pluginSource = (file: string) => fs.readFileSync(path.resolve(__dirname, '../../../plugins/ios-push', file), 'utf8');

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) return '';
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  return '';
}

/** Whether launch changes the class of the stored items in place (no delete, no add). */
function launchStepChangesClassInPlace(): boolean {
  const keychainSwift = pluginSource('SharedKeychain.swift');
  const body = functionBody(keychainSwift, 'static func keepOnThisDevice()');
  const register = functionBody(pluginSource('PushRenewalTask.swift'), 'static func register()');
  return register.includes('SharedKeychain.keepOnThisDevice()')
    && /SecItemUpdate\([^)]*\[kSecAttrAccessible as String: next\]/.test(body)
    && !/SecItemDelete|SecItemAdd|kSecValueData/.test(body);
}

describe('the class of items an earlier version stored', () => {
  const shared = (key: string) => keychain.get(slot(key, { accessGroup: SHARED }));

  it('is changed at launch in place, for every item of the shared group and every stored sign-in', () => {
    expect(launchStepChangesClassInPlace()).toBe(true);
    const keychainSwift = pluginSource('SharedKeychain.swift');
    const body = functionBody(keychainSwift, 'static func keepOnThisDevice()');
    // Every account: all items of the shared group, and the sign-ins in any group (jmap-client's prefix).
    expect(body).toMatch(/itemGroup == group \|\| key\.hasPrefix\(credentialsPrefix\)/);
    expect(keychainSwift).toMatch(/static let credentialsPrefix = "jmap_credentials"/);
    // Each class gets its "this device only" variant; device-only ones (the crypto keys) stay as they are.
    const map = functionBody(keychainSwift, 'static func deviceOnlyClass(of current: String)');
    expect(map).toMatch(/kSecAttrAccessibleAfterFirstUnlock as String: return kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly/);
    expect(map).toMatch(/kSecAttrAccessibleWhenUnlocked as String: return kSecAttrAccessibleWhenUnlockedThisDeviceOnly/);
    expect(map).toMatch(/default: return nil/);
    // The extension's write-backs (refreshed tokens, the renewal's expiry) replace the data only: the class stays.
    const update = functionBody(keychainSwift, 'static func update(_ key: String, json: [String: Any]) -> Bool');
    expect(update).toMatch(/\[kSecValueData as String: data\]/);
    expect(update).not.toMatch(/SecItemDelete|SecItemAdd/);
  });

  it('never takes the stored sign-in out: the start step, a token refresh and the push entries only write', async () => {
    keychain.set(slot(KEY, { accessGroup: SHARED }), { value: VALUE, accessible: OLD_CLASS });
    await moveToSharedGroup(KEY);
    await writeSharedSecret(KEY, '{"accessToken":"fresh"}');
    await writeIosPushAccount('jmap-1', { credentialsKey: KEY, apiUrl: 'https://mail.example.com/jmap/' });
    await writeIosPushSettings({ badge: false, activeAccountId: null, strings: { noSubject: '', more: '' } });
    const sharedDeletes = vi.mocked(SecureStore.deleteItemAsync).mock.calls.filter(([, options]) => options?.accessGroup === SHARED);
    expect(sharedDeletes).toEqual([]);
    expect(shared(KEY)?.value).toBe('{"accessToken":"fresh"}');
  });

  it('loses nothing on a start before the first unlock', async () => {
    keychain.set(slot(KEY, { accessGroup: OWN }), { value: VALUE, accessible: OLD_CLASS });
    state.locked = true;
    await moveToSharedGroup(KEY).catch(() => undefined);
    state.locked = false;
    expect(keychain.get(slot(KEY, { accessGroup: OWN }))).toEqual({ value: VALUE, accessible: OLD_CLASS });
    await moveToSharedGroup(KEY);
    expect(shared(KEY)).toEqual({ value: VALUE, accessible: DEVICE_ONLY });
  });

  it('a first sign-in after the update is on this device only from the start', async () => {
    await writeSharedSecret(KEY, VALUE);
    expect(shared(KEY)).toEqual({ value: VALUE, accessible: DEVICE_ONLY });
    expect(sharedStoreOptions()?.keychainAccessible).toBe(DEVICE_ONLY);
  });
});
