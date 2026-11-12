import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 30, select: <T,>(s: { default?: T; android?: T }) => s.android ?? s.default },
  NativeModules: {
    BulwarkDirectPush: {
      start: vi.fn(async () => undefined),
      stop: vi.fn(async () => undefined),
      setAccounts: vi.fn(async () => undefined),
    },
  },
  NativeEventEmitter: class {
    addListener() {
      return { remove: () => undefined };
    }
  },
  PermissionsAndroid: { RESULTS: { GRANTED: 'granted' }, request: vi.fn(async () => 'granted') },
  AppState: { currentState: 'active', addEventListener: () => ({ remove: () => undefined }) },
  Appearance: { getColorScheme: () => 'dark', addChangeListener: () => ({ remove: () => undefined }) },
  Linking: { openURL: async () => undefined },
}));

// Each account's stored credentials, drawn at run time.
const { CREDS } = vi.hoisted(() => ({ CREDS: {} as Record<string, Record<string, unknown>> }));

vi.mock('../../api/jmap-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/jmap-client')>()),
  jmapClient: {
    getStoredCredentials: vi.fn(async (id: string) => CREDS[id] ?? null),
    setStoredCredentials: vi.fn(async () => undefined),
  },
}));
vi.mock('../client-cert', () => ({
  getClientCertAlias: vi.fn(async () => null),
  secureFetch: vi.fn(),
}));
vi.mock('../oauth', () => ({
  refreshOAuthAccessToken: vi.fn(async () => {
    throw new Error('token endpoint unreachable');
  }),
  forgetRefreshRotations: vi.fn(),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { NativeModules } from 'react-native';
import { getClientCertAlias, secureFetch } from '../client-cert';
import { directPushCredentialsTask } from '../direct-push-task';

type Native = { stop: ReturnType<typeof vi.fn>; setAccounts: ReturnType<typeof vi.fn> };
const native = () => (NativeModules as { BulwarkDirectPush: Native }).BulwarkDirectPush;
const fetchMock = secureFetch as ReturnType<typeof vi.fn>;

const ALICE = 'alice@https://mail.example.org';
const BOB = 'bob@https://other.example.net';
const TEMPLATE = '/jmap/eventsource/?types={types}&closeafter={closeafter}&ping={ping}';
const secret = () => `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

/** Sessions answer only the credentials they were given. */
function serveSessions(valid: Record<string, string>): void {
  fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
    const origin = url.replace(/\/\.well-known\/jmap$/, '');
    const auth = (init.headers as Record<string, string>).Authorization;
    if (valid[origin] !== auth) return { ok: false, status: 401, json: async () => ({}) };
    const session = { apiUrl: `${origin}/jmap/`, eventSourceUrl: `${origin}${TEMPLATE}`, capabilities: {} };
    return { ok: true, status: 200, json: async () => session };
  });
}

describe('directPushCredentialsTask', () => {
  let aliceToken: string;
  let bobPassword: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    await AsyncStorage.clear();
    await AsyncStorage.setItem('push:transport:v1', 'direct');
    await AsyncStorage.setItem('push:accountIds:v1', JSON.stringify([ALICE, BOB]));
    aliceToken = secret();
    bobPassword = secret();
    for (const key of Object.keys(CREDS)) delete CREDS[key];
    CREDS[ALICE] = { serverUrl: 'https://mail.example.org/', username: 'alice', password: '', accessToken: aliceToken };
    CREDS[BOB] = { serverUrl: 'https://other.example.net', username: 'bob', password: bobPassword };
    serveSessions({
      'https://mail.example.org': `Bearer ${aliceToken}`,
      'https://other.example.net': `Basic ${btoa(`bob:${bobPassword}`)}`,
    });
  });

  it("hands over every push account's stream", async () => {
    const request = Math.floor(Math.random() * 1000) + 1;
    await directPushCredentialsTask({ request });

    expect(native().stop).not.toHaveBeenCalled();
    const [{ request: answered, accounts, unreadable, refused, ...rest }] = native().setAccounts.mock.calls[0];
    expect(answered).toBe(request);
    // The texts go with start only.
    expect(rest).toEqual({});
    expect(unreadable).toEqual([]);
    expect(refused).toEqual([]);
    expect(accounts).toEqual([
      {
        id: ALICE,
        eventSourceUrl: `https://mail.example.org${TEMPLATE}`,
        authorization: `Bearer ${aliceToken}`,
        types: ['EmailDelivery'],
        label: 'alice',
      },
      {
        id: BOB,
        eventSourceUrl: `https://other.example.net${TEMPLATE}`,
        authorization: `Basic ${btoa(`bob:${bobPassword}`)}`,
        types: ['EmailDelivery'],
        label: 'bob',
      },
    ]);
  });

  it('streams under a relay transport only the accounts still owed their relay registration', async () => {
    await AsyncStorage.setItem('push:transport:v1', 'fcm');
    await AsyncStorage.setItem('push:relayOwed:v1', JSON.stringify([BOB]));

    await directPushCredentialsTask({ request: 1 });

    expect(native().stop).not.toHaveBeenCalled();
    const { accounts } = native().setAccounts.mock.calls[0][0] as { accounts: { id: string }[] };
    expect(accounts.map((a) => a.id)).toEqual([BOB]);
  });

  it('moves a stream the server reports on an internal origin onto the one the account connects to', async () => {
    fetchMock.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ apiUrl: 'http://stalwart:8080/jmap/', eventSourceUrl: `http://stalwart:8080${TEMPLATE}`, capabilities: {} }),
    }));

    await directPushCredentialsTask({ request: 1 });

    const { accounts } = native().setAccounts.mock.calls[0][0] as { accounts: { eventSourceUrl: string }[] };
    expect(accounts.map((a) => a.eventSourceUrl)).toEqual([`https://mail.example.org${TEMPLATE}`, `https://other.example.net${TEMPLATE}`]);
  });

  it('names an account whose server refuses its credentials, not as unreadable', async () => {
    // An expired token whose refresh fails: the server refuses the old one.
    Object.assign(CREDS[ALICE], { refreshToken: secret(), expiresAt: Date.now() - 1000, tokenEndpoint: 'https://mail.example.org/token', clientId: 'app' });
    serveSessions({
      'https://mail.example.org': `Bearer ${secret()}`,
      'https://other.example.net': `Basic ${btoa(`bob:${bobPassword}`)}`,
    });

    await directPushCredentialsTask({ request: 1 });

    const [{ accounts, unreadable, refused }] = native().setAccounts.mock.calls[0];
    expect(unreadable).toEqual([]);
    expect(refused).toEqual([ALICE]);
    expect((accounts as Array<{ id: string }>).map((a) => a.id)).toEqual([BOB]);
  });

  it('names the account whose server could not be read, so its stream stays and no other does', async () => {
    const serve = fetchMock.getMockImplementation() as (url: string, init: RequestInit) => Promise<unknown>;
    fetchMock.mockImplementation(async (url: string, init: RequestInit) => {
      if (url.startsWith('https://other.example.net')) return { ok: false, status: 503, json: async () => ({}) };
      return serve(url, init);
    });

    await directPushCredentialsTask({ request: 1 });

    const [{ accounts, unreadable, refused }] = native().setAccounts.mock.calls[0];
    expect(unreadable).toEqual([BOB]);
    expect(refused).toEqual([]);
    expect((accounts as Array<{ id: string }>).map((a) => a.id)).toEqual([ALICE]);
  });

  it('leaves out a signed-out account, not as unreadable', async () => {
    delete CREDS[BOB];

    await directPushCredentialsTask({ request: 1 });

    const [{ accounts, unreadable, refused }] = native().setAccounts.mock.calls[0];
    expect(unreadable).toEqual([]);
    expect(refused).toEqual([]);
    expect((accounts as Array<{ id: string }>).map((a) => a.id)).toEqual([ALICE]);
  });

  it('stops the service while email notifications are off, as the app stored the setting', async () => {
    await AsyncStorage.setItem('webmail:settings:v1', JSON.stringify({ emailNotificationsEnabled: false }));
    await AsyncStorage.setItem('push:directWanted:v1', '1');

    await directPushCredentialsTask({ request: 1 });

    expect(native().stop).toHaveBeenCalledTimes(1);
    expect(native().setAccounts).not.toHaveBeenCalled();
    // Turned on again, notifying resumes: the next start records the mail there is.
    expect(await AsyncStorage.getItem('push:directWanted:v1')).toBeNull();
  });

  it('hands over no stream with a client certificate in use', async () => {
    (getClientCertAlias as ReturnType<typeof vi.fn>).mockResolvedValueOnce(`cert-${secret()}`);

    await directPushCredentialsTask({ request: 1 });

    expect(native().setAccounts).toHaveBeenCalledWith({ request: 1, accounts: [], unreadable: [], refused: [] });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('logs how many accounts it could not read, never their ids', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    fetchMock.mockImplementation(async () => ({ ok: false, status: 503, json: async () => ({}) }));

    await directPushCredentialsTask({ request: 1 });

    const logged = JSON.stringify(warn.mock.calls);
    warn.mockRestore();
    expect(logged).toContain('of 2 accounts, 0 refused, 2 unreadable');
    expect(logged).not.toContain('account 1');
    expect(logged).not.toContain('alice');
    expect(logged).not.toContain('bob');
  });

  it('answers nothing without a request number', async () => {
    await directPushCredentialsTask({});
    await directPushCredentialsTask({ request: '1' });

    expect(native().setAccounts).not.toHaveBeenCalled();
    expect(native().stop).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stops the service under another transport or without push accounts', async () => {
    await AsyncStorage.setItem('push:transport:v1', 'fcm');
    await directPushCredentialsTask({ request: 1 });
    expect(native().stop).toHaveBeenCalledTimes(1);

    await AsyncStorage.setItem('push:transport:v1', 'direct');
    await AsyncStorage.removeItem('push:accountIds:v1');
    await directPushCredentialsTask({ request: 1 });
    expect(native().stop).toHaveBeenCalledTimes(2);

    expect(native().setAccounts).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
