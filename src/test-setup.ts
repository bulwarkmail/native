// Vitest setup. Two pieces of plumbing the unit tests need:
//
// 1. AsyncStorage: the Zustand `persist` middleware used by several stores
//    reaches in during `set()` calls, which on a `node` environment crashes
//    inside the RN AsyncStorage shim (no `window` global). Swap in an
//    in-memory implementation.
// 2. react-native: the bundled entry point is Flow-typed and rolldown can't
//    parse it. Stub the few surfaces used at module-load time so any store
//    that transitively imports `react-native` (via push / client-cert
//    bridges) loads cleanly. Tests that actually exercise native modules
//    re-mock the relevant module locally.

import { vi } from 'vitest';

const memory = new Map<string, string>();

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn(async (key: string) => memory.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      memory.set(key, value);
    }),
    removeItem: vi.fn(async (key: string) => {
      memory.delete(key);
    }),
    clear: vi.fn(async () => {
      memory.clear();
    }),
    getAllKeys: vi.fn(async () => Array.from(memory.keys())),
    multiGet: vi.fn(async (keys: string[]) =>
      keys.map((k) => [k, memory.get(k) ?? null] as [string, string | null]),
    ),
    multiSet: vi.fn(async (pairs: [string, string][]) => {
      for (const [k, v] of pairs) memory.set(k, v);
    }),
    multiRemove: vi.fn(async (keys: string[]) => {
      for (const k of keys) memory.delete(k);
    }),
  },
}));

vi.mock('react-native', () => {
  class NativeEventEmitter {
    addListener() {
      return { remove: () => undefined };
    }
    removeAllListeners() {}
  }
  return {
    Platform: { OS: 'android', Version: 33, select: <T,>(spec: { default?: T; android?: T; ios?: T }) => spec.android ?? spec.default ?? spec.ios },
    NativeModules: {},
    NativeEventEmitter,
    PermissionsAndroid: {
      RESULTS: { GRANTED: 'granted', DENIED: 'denied', NEVER_ASK_AGAIN: 'never_ask_again' },
      request: async () => 'granted',
    },
    Linking: { openURL: async () => undefined },
    Appearance: { getColorScheme: () => 'dark', addChangeListener: () => ({ remove: () => undefined }) },
  };
});

vi.mock('expo-secure-store', () => ({
  setItemAsync: vi.fn(async () => undefined),
  getItemAsync: vi.fn(async () => null),
  deleteItemAsync: vi.fn(async () => undefined),
}));
