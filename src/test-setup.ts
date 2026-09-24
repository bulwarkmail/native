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
    AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
  };
});

vi.mock('expo-secure-store', () => ({
  setItemAsync: vi.fn(async () => undefined),
  getItemAsync: vi.fn(async () => null),
  deleteItemAsync: vi.fn(async () => undefined),
}));

// expo-web-browser transitively pulls in expo-modules-core, which evaluates
// RN-only globals at module load. The unit tests don't exercise the real
// browser handoff flow, so stubbing the surface is enough.
vi.mock('expo-web-browser', () => ({
  openAuthSessionAsync: vi.fn(async () => ({ type: 'cancel' as const })),
  maybeCompleteAuthSession: vi.fn(),
}));

// @react-native-community/netinfo ships Flow-typed source that rolldown
// cannot parse. The outbox/network stores import it at module load, so any
// suite that reaches them (auth-store -> email-store -> outbox-store) needs
// this mock. Reports "online" by default.
vi.mock('@react-native-community/netinfo', () => ({
  default: {
    addEventListener: vi.fn(() => () => undefined),
    fetch: vi.fn(async () => ({ isConnected: true, isInternetReachable: true })),
  },
}));

// expo-crypto is a native module; lib/random.ts falls back to node's
// webcrypto when the import fails, so just make the import resolvable.
vi.mock('expo-crypto', () => ({
  getRandomValues: <T extends ArrayBufferView>(a: T): T => {
    const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return a;
  },
  randomUUID: () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  }),
}));

// React Native injects `__DEV__`; expo-modules-core reads it at import time.
(globalThis as { __DEV__?: boolean }).__DEV__ = false;

// Expo native modules reached transitively from the stores (file system,
// haptics, clipboard, notifications, sharing, pickers). Their JS entry points
// pull in expo-modules-core, which needs the RN runtime. Tests that exercise
// one of them re-mock it locally with real behaviour.
vi.mock('expo-file-system', () => ({
  File: class { constructor(public uri: string) {} async bytes() { return new Uint8Array(); } },
  Paths: { cache: { uri: 'file:///cache/' }, document: { uri: 'file:///documents/' } },
  Directory: class { constructor(public uri: string) {} },
}));
vi.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  documentDirectory: 'file:///documents/',
  createUploadTask: vi.fn(),
  uploadAsync: vi.fn(async () => ({ status: 200, body: '{}' })),
  getInfoAsync: vi.fn(async () => ({ exists: false })),
  deleteAsync: vi.fn(async () => undefined),
  readDirectoryAsync: vi.fn(async () => []),
  writeAsStringAsync: vi.fn(async () => undefined),
  readAsStringAsync: vi.fn(async () => ''),
  FileSystemUploadType: { BINARY_CONTENT: 0 },
}));
vi.mock('expo-haptics', () => ({
  impactAsync: vi.fn(async () => undefined),
  notificationAsync: vi.fn(async () => undefined),
  selectionAsync: vi.fn(async () => undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));
vi.mock('expo-clipboard', () => ({
  setStringAsync: vi.fn(async () => true),
  getStringAsync: vi.fn(async () => ''),
}));
vi.mock('expo-notifications', () => ({
  scheduleNotificationAsync: vi.fn(async () => 'id'),
  cancelScheduledNotificationAsync: vi.fn(async () => undefined),
  cancelAllScheduledNotificationsAsync: vi.fn(async () => undefined),
  getAllScheduledNotificationsAsync: vi.fn(async () => []),
  requestPermissionsAsync: vi.fn(async () => ({ granted: true })),
  getPermissionsAsync: vi.fn(async () => ({ granted: true })),
  setNotificationHandler: vi.fn(),
  setNotificationChannelAsync: vi.fn(async () => undefined),
  AndroidImportance: { DEFAULT: 3, HIGH: 4 },
  SchedulableTriggerInputTypes: { DATE: 'date' },
}));
vi.mock('expo-sharing', () => ({
  isAvailableAsync: vi.fn(async () => false),
  shareAsync: vi.fn(async () => undefined),
}));
vi.mock('expo-document-picker', () => ({
  getDocumentAsync: vi.fn(async () => ({ canceled: true, assets: null })),
}));
vi.mock('expo-image-manipulator', () => ({
  manipulateAsync: vi.fn(async (uri: string) => ({ uri, width: 0, height: 0 })),
  SaveFormat: { JPEG: 'jpeg', PNG: 'png' },
}));
vi.mock('expo-intent-launcher', () => ({
  startActivityAsync: vi.fn(async () => ({ resultCode: 0 })),
  ActivityAction: { VIEW: 'android.intent.action.VIEW' },
}));
vi.mock('expo-localization', () => ({
  getLocales: () => [{ languageCode: 'en', regionCode: 'US', languageTag: 'en-US', textDirection: 'ltr' }],
  getCalendars: () => [{ timeZone: 'UTC', firstWeekday: 1 }],
}));
