// On iOS the stored sign-in (password or tokens) never leaves the device in an
// encrypted backup or a device-to-device transfer.
//
// An item that is already in the keychain keeps its class until it is added
// anew, so a sign-in stored by an earlier version is rewritten by the step
// every start runs for an account (moveToSharedGroup, called by jmap-client.ts
// when it restores a session), whichever group it was in.
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

import * as SecureStore from 'expo-secure-store';
import {
  moveToSharedGroup, PUSH_SETTINGS_KEY, pushAccountKey, sharedStoreOptions, writeIosPushAccount, writeIosPushSettings,
  writeSharedItem, writeSharedSecret,
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

  it('gives an item that an earlier version stored in the shared group the new class at the next start', async () => {
    keychain.set(slot(KEY, { accessGroup: SHARED }), { value: VALUE, accessible: OLD_CLASS });
    await moveToSharedGroup(KEY); // the start-up step for this account
    const item = keychain.get(slot(KEY, { accessGroup: SHARED }));
    expect(item?.value, 'the sign-in is still there').toBe(VALUE);
    expect(item?.accessible, 'and no longer travels with a backup').toBe(DEVICE_ONLY);
  });

  it('gives an item that still sits in the app\'s own group the new class when it moves', async () => {
    keychain.set(slot(KEY, { accessGroup: OWN }), { value: VALUE, accessible: OLD_CLASS });
    await moveToSharedGroup(KEY); // the start-up step for this account
    const item = keychain.get(slot(KEY, { accessGroup: SHARED }));
    expect(item?.value).toBe(VALUE);
    expect(item?.accessible).toBe(DEVICE_ONLY);
    expect(keychain.has(slot(KEY, { accessGroup: OWN })), 'no second copy with the old class is left').toBe(false);
  });

  it('does not lose the sign-in when the rewrite fails', async () => {
    keychain.set(slot(KEY, { accessGroup: SHARED }), { value: VALUE, accessible: OLD_CLASS });
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error('keychain is locked'));
    await moveToSharedGroup(KEY).catch(() => undefined);
    expect(keychain.get(slot(KEY, { accessGroup: SHARED }))?.value).toBe(VALUE);
  });
});

describe('rewriting the stored sign-in', () => {
  const shared = (key: string) => keychain.get(slot(key, { accessGroup: SHARED }));

  it('leaves everything alone on a start before the first unlock, and rewrites at the next one', async () => {
    keychain.set(slot(KEY, { accessGroup: SHARED }), { value: VALUE, accessible: OLD_CLASS });
    state.locked = true;
    await moveToSharedGroup(KEY).catch(() => undefined);
    state.locked = false;
    expect(shared(KEY)).toEqual({ value: VALUE, accessible: OLD_CLASS });
    await moveToSharedGroup(KEY);
    expect(shared(KEY)).toEqual({ value: VALUE, accessible: DEVICE_ONLY });
  });

  it('puts the sign-in back when adding it anew fails, and tries again at the next start', async () => {
    keychain.set(slot(KEY, { accessGroup: SHARED }), { value: VALUE, accessible: OLD_CLASS });
    // The copy goes in, adding the item anew fails.
    vi.mocked(SecureStore.setItemAsync)
      .mockImplementationOnce(async (key, value, options) => {
        keychain.set(slot(key, options), { value, accessible: options?.keychainAccessible });
      })
      .mockRejectedValueOnce(new Error('keychain error'));
    await moveToSharedGroup(KEY).catch(() => undefined);
    expect(shared(KEY)?.value).toBe(VALUE);
    await moveToSharedGroup(KEY);
    expect(shared(KEY)).toEqual({ value: VALUE, accessible: DEVICE_ONLY });
  });

  it('rewrites only once per device: a later start and a token refresh just write', async () => {
    await writeSharedSecret(KEY, VALUE); // a first sign-in after the update
    expect(shared(KEY)?.accessible).toBe(DEVICE_ONLY);
    vi.mocked(SecureStore.deleteItemAsync).mockClear();
    await moveToSharedGroup(KEY);
    await writeSharedSecret(KEY, '{"accessToken":"fresh"}');
    const sharedDeletes = vi.mocked(SecureStore.deleteItemAsync).mock.calls
      .filter(([key, options]) => key === KEY && options?.accessGroup === SHARED);
    expect(sharedDeletes).toEqual([]);
    expect(shared(KEY)).toEqual({ value: '{"accessToken":"fresh"}', accessible: DEVICE_ONLY });
  });

  it('keeps a token refresh that lands while the start-up step rewrites', async () => {
    keychain.set(slot(KEY, { accessGroup: SHARED }), { value: VALUE, accessible: OLD_CLASS });
    await Promise.all([moveToSharedGroup(KEY), writeSharedSecret(KEY, '{"accessToken":"fresh"}')]);
    expect(shared(KEY)).toEqual({ value: '{"accessToken":"fresh"}', accessible: DEVICE_ONLY });
  });

  it('gives a push entry and the push settings an earlier version stored the new class at their next write', async () => {
    keychain.set(slot(pushAccountKey('jmap-1'), { accessGroup: SHARED }), { value: '{}', accessible: OLD_CLASS });
    keychain.set(slot(PUSH_SETTINGS_KEY, { accessGroup: SHARED }), { value: '{}', accessible: OLD_CLASS });
    await writeIosPushAccount('jmap-1', { credentialsKey: KEY, apiUrl: 'https://mail.example.com/jmap/' });
    await writeIosPushSettings({ badge: false, activeAccountId: null, strings: { noSubject: '', more: '' } });
    expect(shared(pushAccountKey('jmap-1'))?.accessible).toBe(DEVICE_ONLY);
    expect(shared(PUSH_SETTINGS_KEY)?.accessible).toBe(DEVICE_ONLY);
  });

  it('gives the widget snapshot the same treatment', async () => {
    keychain.set(slot('bulwark_widget_inbox', { accessGroup: SHARED }), { value: '{}', accessible: OLD_CLASS });
    await writeSharedItem('bulwark_widget_inbox', '{"messages":[]}', sharedStoreOptions()!);
    expect(shared('bulwark_widget_inbox')).toEqual({ value: '{"messages":[]}', accessible: DEVICE_ONLY });
  });
});
