import { describe, it, expect, vi, beforeEach } from 'vitest';

// Provide the Android native FCM surface setupPushNotifications needs. The
// global test-setup mocks react-native with an empty NativeModules, so override
// it here with a BulwarkFcm module and a pre-33 Platform.Version (which skips
// the runtime permission request).
vi.mock('react-native', () => {
  class NativeEventEmitter {
    addListener() {
      return { remove: () => undefined };
    }
  }
  return {
    Platform: { OS: 'android', Version: 30, select: <T,>(s: { default?: T; android?: T }) => s.android ?? s.default },
    NativeModules: {
      BulwarkFcm: {
        getToken: vi.fn(async () => 'fcm-token-xyz'),
        deleteToken: vi.fn(async () => undefined),
      },
    },
    NativeEventEmitter,
    PermissionsAndroid: { RESULTS: { GRANTED: 'granted' }, request: vi.fn(async () => 'granted') },
  };
});

vi.mock('../../api/jmap-client', () => ({
  jmapClient: { username: 'user@example.com', serverUrl: 'https://mail.example.com' },
}));

vi.mock('../../api/push', () => ({
  listPushSubscriptions: vi.fn(async () => []),
  createPushSubscription: vi.fn(async () => 'new-server-id'),
  verifyPushSubscription: vi.fn(async () => undefined),
  destroyPushSubscription: vi.fn(async () => undefined),
  updatePushSubscription: vi.fn(async () => true),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { setupPushNotifications, deviceClientIdKey } from '../push-notifications';
import {
  listPushSubscriptions,
  destroyPushSubscription,
} from '../../api/push';
import { generateAccountId } from '../account-utils';

const OUR_DCID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ACCOUNT_ID = generateAccountId('user@example.com', 'https://mail.example.com');
const RELAY = 'https://relay.example.com';

// State the fake relay reports for each foreign deviceClientId's /active probe.
type RelayState = 'dead' | 'live' | 'unknown';

function installFetch(states: Record<string, RelayState>): void {
  global.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/api/push/register')) {
      return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
    }
    if (url.includes('/api/push/verify/')) {
      return { ok: true, status: 200, json: async () => ({ verificationCode: 'CODE' }) } as Response;
    }
    const active = url.match(/\/api\/push\/active\/([^/?]+)$/);
    if (active) {
      const dcid = decodeURIComponent(active[1]);
      const state = states[dcid] ?? 'unknown';
      if (state === 'unknown') {
        return { ok: false, status: 404, json: async () => ({ error: 'Unknown subscription' }) } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ active: state === 'live' }) } as Response;
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
}

const destroyMock = destroyPushSubscription as ReturnType<typeof vi.fn>;
const listMock = listPushSubscriptions as ReturnType<typeof vi.fn>;

function sub(id: string, deviceClientId: string) {
  return { id, deviceClientId, expires: new Date(Date.now() + 86400000).toISOString(), types: ['Email'] };
}

describe('setupPushNotifications leftover reaping', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    // Pin our deviceClientId so we control which leftovers are "ours".
    await AsyncStorage.setItem(deviceClientIdKey(ACCOUNT_ID), OUR_DCID);
  });

  it('reaps our own and relay-confirmed-dead leftovers, keeps live and unverifiable ones', async () => {
    listMock.mockResolvedValue([
      sub('own-old', OUR_DCID), // our own previous attempt -> reap
      sub('foreign-dead', 'deaddeaddeaddeaddeaddeaddeaddead'), // relay: dead -> reap
      sub('foreign-live', 'livelivelivelivelivelivelivelive'), // relay: live -> keep
      sub('foreign-unknown', 'unknwunknwunknwunknwunknwunknwun'), // relay: 404 -> keep
    ]);
    installFetch({
      deaddeaddeaddeaddeaddeaddeaddead: 'dead',
      livelivelivelivelivelivelivelive: 'live',
      unknwunknwunknwunknwunknwunknwun: 'unknown',
    });

    const result = await setupPushNotifications({ relayBaseUrl: RELAY });

    expect(result.verified).toBe(true);
    const reaped = destroyMock.mock.calls.map((c) => c[0]);
    expect(reaped).toContain('own-old');
    expect(reaped).toContain('foreign-dead');
    expect(reaped).not.toContain('foreign-live');
    expect(reaped).not.toContain('foreign-unknown');
  });

  it('keeps foreign subs when the relay probe fails (network error)', async () => {
    listMock.mockResolvedValue([sub('foreign-x', 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')]);
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.includes('/api/push/register')) {
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      if (url.includes('/api/push/verify/')) {
        return { ok: true, status: 200, json: async () => ({ verificationCode: 'CODE' }) } as Response;
      }
      if (url.includes('/api/push/active/')) throw new Error('network down');
      throw new Error(`unexpected fetch: ${url}`);
    }) as typeof fetch;

    await setupPushNotifications({ relayBaseUrl: RELAY });

    expect(destroyMock.mock.calls.map((c) => c[0])).not.toContain('foreign-x');
  });
});
