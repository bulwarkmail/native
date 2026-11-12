// The stored sign-in on iOS is never missing while the app starts: the step
// every start runs for an account (moveToSharedGroup, called by jmap-client.ts
// when it restores a session) never takes the item out, so a reader in the
// app, a token the notification extension refreshes, and a start that ends
// half-way all find it. The class change itself is native and in place (see
// ios-credentials-stay-on-device.test.ts).
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
import { moveToSharedGroup, sharedStoreOptions } from '../ios-push-shared';

const KEY = 'jmap_credentials__alice_example.org_mail.example.com';
const VALUE = '{"password":"not-a-real-password"}';
const OLD_CLASS = 0;
const shared = (key: string) => keychain.get(slot(key, { accessGroup: SHARED }));

beforeEach(() => {
  keychain.clear();
  state.locked = false;
  vi.clearAllMocks();
});

describe('the start step seen from outside', () => {
  it('a reader in the app finds the sign-in at every step of the rewrite', async () => {
    keychain.set(slot(KEY, { accessGroup: SHARED }), { value: VALUE, accessible: OLD_CLASS });
    // jmap-client reads with no options (every group): look in the shared group after each keychain call.
    const seen: Array<string | null> = [];
    const look = () => { seen.push(shared(KEY)?.value ?? null); };
    for (const fn of [SecureStore.setItemAsync, SecureStore.deleteItemAsync] as const) {
      const real = vi.mocked(fn).getMockImplementation()!;
      vi.mocked(fn).mockImplementation((async (...args: never[]) => { const r = await (real as (...a: never[]) => Promise<unknown>)(...args); look(); return r; }) as never);
    }
    await moveToSharedGroup(KEY);
    expect(seen).not.toContain(null);
  });

  it('a token the notification extension refreshes during the rewrite survives it', async () => {
    keychain.set(slot(KEY, { accessGroup: SHARED }), { value: VALUE, accessible: OLD_CLASS });
    // SharedKeychain.update in the extension: SecItemUpdate of the data, fails when the item is missing.
    const extensionUpdate = (value: string) => {
      const item = keychain.get(slot(KEY, { accessGroup: SHARED }));
      if (item) item.value = value;
    };
    // The refresh lands right after the start step's first keychain call, whichever it is.
    let refreshed = false;
    const fns = [SecureStore.getItemAsync, SecureStore.setItemAsync, SecureStore.deleteItemAsync] as const;
    const reals = fns.map((fn) => vi.mocked(fn).getMockImplementation()!);
    fns.forEach((fn, i) => {
      vi.mocked(fn).mockImplementation((async (...args: never[]) => {
        const r = await (reals[i] as (...a: never[]) => Promise<unknown>)(...args);
        if (!refreshed) {
          refreshed = true;
          extensionUpdate('{"accessToken":"refreshed-by-extension"}');
        }
        return r;
      }) as never);
    });
    try {
      await moveToSharedGroup(KEY);
    } finally {
      fns.forEach((fn, i) => vi.mocked(fn).mockImplementation(reals[i] as never));
    }
    expect(refreshed).toBe(true);
    expect(shared(KEY)?.value).toBe('{"accessToken":"refreshed-by-extension"}');
  });

  it('a start that ends between taking the item out and putting it back keeps the sign-in at the next start', async () => {
    keychain.set(slot(KEY, { accessGroup: SHARED }), { value: VALUE, accessible: OLD_CLASS });
    // The copy goes in, the item goes out, then the process is gone (both adds fail).
    const realSet = vi.mocked(SecureStore.setItemAsync).getMockImplementation()!;
    let sets = 0;
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value, options) => {
      sets += 1;
      if (sets > 1) throw new Error('process gone');
      await realSet(key, value, options);
    });
    await moveToSharedGroup(KEY).catch(() => undefined);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(realSet);
    await moveToSharedGroup(KEY); // the next start
    expect(await SecureStore.getItemAsync(KEY, sharedStoreOptions())).toBe(VALUE);
  });
});
