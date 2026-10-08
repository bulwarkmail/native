import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 30, select: <T,>(s: { default?: T; android?: T }) => s.android ?? s.default },
  NativeModules: {},
  NativeEventEmitter: class {
    addListener() {
      return { remove: () => undefined };
    }
  },
  PermissionsAndroid: { RESULTS: { GRANTED: 'granted' }, request: vi.fn(), check: vi.fn() },
}));

const { CLIENT } = vi.hoisted(() => ({
  CLIENT: { username: 'a' as string | null, serverUrl: 'https://one.example' as string | null },
}));
vi.mock('../../api/jmap-client', () => ({
  jmapClient: CLIENT,
  JMAPClient: class {},
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  DEFAULT_RELAY_BASE_URL,
  clearStoredRelayBaseUrl,
  getEffectiveRelayBaseUrl,
  getStoredRelayBaseUrl,
  relayBaseUrlKey,
  setStoredRelayBaseUrl,
  teardownPushNotifications,
} from '../push-notifications';

const A = 'a@one.example';
const B = 'b@two.example';
const V1 = 'push:relayBaseUrl:v1';

describe('push relay per account', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    CLIENT.username = 'a';
    CLIENT.serverUrl = 'https://one.example';
  });

  it('falls back to the default when nothing is stored', async () => {
    expect(await getStoredRelayBaseUrl(A)).toBeNull();
    expect(await getEffectiveRelayBaseUrl(A)).toBe(DEFAULT_RELAY_BASE_URL);
  });

  it('keeps each account\'s relay apart', async () => {
    await setStoredRelayBaseUrl('https://relay-a.example/', A);
    expect(await getEffectiveRelayBaseUrl(A)).toBe('https://relay-a.example');
    expect(await getEffectiveRelayBaseUrl(B)).toBe(DEFAULT_RELAY_BASE_URL);
    await setStoredRelayBaseUrl('https://relay-b.example', B);
    expect(await getEffectiveRelayBaseUrl(A)).toBe('https://relay-a.example');
  });

  it('reset (null) returns one account to the default only', async () => {
    await setStoredRelayBaseUrl('https://relay-a.example', A);
    await setStoredRelayBaseUrl('https://relay-b.example', B);
    await setStoredRelayBaseUrl(null, A);
    expect(await getEffectiveRelayBaseUrl(A)).toBe(DEFAULT_RELAY_BASE_URL);
    expect(await getEffectiveRelayBaseUrl(B)).toBe('https://relay-b.example');
  });

  it('with no account argument, reads the loaded account', async () => {
    await setStoredRelayBaseUrl('https://relay-a.example', A);
    expect(await getStoredRelayBaseUrl()).toBe('https://relay-a.example');
    CLIENT.username = null;
    expect(await getStoredRelayBaseUrl()).toBeNull();
  });

  it('migrates the v1 value to every known account without overwriting a v2 value', async () => {
    await AsyncStorage.setItem('account-registry', JSON.stringify({ state: { accounts: [{ id: A }, { id: B }] } }));
    await AsyncStorage.setItem(V1, 'https://old.example');
    await AsyncStorage.setItem(relayBaseUrlKey(B), 'https://mine.example');
    expect(await getStoredRelayBaseUrl(A)).toBe('https://old.example');
    expect(await getStoredRelayBaseUrl(B)).toBe('https://mine.example');
    expect(await AsyncStorage.getItem(V1)).toBeNull();
    // Idempotent: a later reset of A is not undone by another read.
    await setStoredRelayBaseUrl(null, A);
    expect(await getStoredRelayBaseUrl(A)).toBeNull();
    expect(await getStoredRelayBaseUrl(B)).toBe('https://mine.example');
  });

  it('does not copy v1 to an asker that is not a known account', async () => {
    await AsyncStorage.setItem(V1, 'https://old.example');
    expect(await getStoredRelayBaseUrl(A)).toBeNull();
    expect(await AsyncStorage.getItem(relayBaseUrlKey(A))).toBeNull();
  });

  it('keeps v1 when the registry is unreadable, and migrates on a later read', async () => {
    await AsyncStorage.setItem(V1, 'https://old.example');
    await AsyncStorage.setItem('account-registry', '{not json');
    expect(await getStoredRelayBaseUrl(A)).toBeNull();
    expect(await AsyncStorage.getItem(V1)).toBe('https://old.example');
    await AsyncStorage.setItem('account-registry', JSON.stringify({ state: { accounts: [{ id: A }] } }));
    expect(await getStoredRelayBaseUrl(A)).toBe('https://old.example');
    expect(await AsyncStorage.getItem(V1)).toBeNull();
  });

  it('a set racing the migration is not overwritten', async () => {
    await AsyncStorage.setItem('account-registry', JSON.stringify({ state: { accounts: [{ id: A }] } }));
    await AsyncStorage.setItem(V1, 'https://old.example');
    await Promise.all([
      setStoredRelayBaseUrl('https://new.example', A),
      getStoredRelayBaseUrl(A),
      getStoredRelayBaseUrl(A),
    ]);
    expect(await getStoredRelayBaseUrl(A)).toBe('https://new.example');
  });

  it('ignores a stored value that is not an https relay', async () => {
    await AsyncStorage.setItem(relayBaseUrlKey(A), 'http://evil.example');
    expect(await getStoredRelayBaseUrl(A)).toBeNull();
    expect(await getEffectiveRelayBaseUrl(A)).toBe(DEFAULT_RELAY_BASE_URL);
  });

  it('logout-all clears the relay of registry accounts that never had push', async () => {
    await AsyncStorage.setItem('account-registry', JSON.stringify({ state: { accounts: [{ id: A }, { id: B }] } }));
    await AsyncStorage.setItem('push:accountIds:v1', JSON.stringify([A]));
    await setStoredRelayBaseUrl('https://relay-a.example', A);
    await setStoredRelayBaseUrl('https://relay-b.example', B);
    await teardownPushNotifications();
    expect(await AsyncStorage.getItem(relayBaseUrlKey(A))).toBeNull();
    expect(await AsyncStorage.getItem(relayBaseUrlKey(B))).toBeNull();
  });

  it('migration also reaches an account only push knows about', async () => {
    await AsyncStorage.setItem('push:accountIds:v1', JSON.stringify([A, B]));
    await AsyncStorage.setItem(V1, 'https://old.example');
    expect(await getStoredRelayBaseUrl(A)).toBe('https://old.example');
    expect(await AsyncStorage.getItem(relayBaseUrlKey(B))).toBe('https://old.example');
  });

  it('sign-out clears only that account\'s relay', async () => {
    await setStoredRelayBaseUrl('https://relay-a.example', A);
    await setStoredRelayBaseUrl('https://relay-b.example', B);
    await clearStoredRelayBaseUrl(A);
    expect(await getStoredRelayBaseUrl(A)).toBeNull();
    expect(await getStoredRelayBaseUrl(B)).toBe('https://relay-b.example');
  });
});
