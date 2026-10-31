import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const secure = new Map<string, string>();
vi.mock('expo-secure-store', () => ({
  setItemAsync: vi.fn(async (k: string, v: string) => { secure.set(k, v); }),
  getItemAsync: vi.fn(async (k: string) => secure.get(k) ?? null),
  deleteItemAsync: vi.fn(async (k: string) => { secure.delete(k); }),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { JMAPClient, AuthenticationError, SessionSupersededError } from '../jmap-client';
import type { JMAPSession } from '../types';
import { setKnownAccounts } from '../../lib/account-utils';

// Start-up used to wait for the server's session document before the
// account could show. The client now keeps the last one per account and
// starts from it (loadAccountFromCache), then fetches a fresh one.

const ACCOUNT = 'user@mail.example.com';
const CREDS = { serverUrl: 'https://mail.example.com', username: 'user', password: 'pass' };

const SESSION: JMAPSession = {
  apiUrl: 'https://mail.example.com/jmap/',
  downloadUrl: 'https://mail.example.com/download/{accountId}/{blobId}/{name}?type={type}',
  uploadUrl: 'https://mail.example.com/upload/{accountId}/',
  eventSourceUrl: 'https://mail.example.com/eventsource/',
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc-1', 'urn:ietf:params:jmap:core': 'acc-1' },
  accounts: { 'acc-1': { name: 'user@example.com', isPersonal: true, isReadOnly: false } },
  capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:mail': {} },
  state: 'state-1',
};

function mockFetch(responses: Array<{ status: number; json?: unknown }>) {
  let i = 0;
  const fn = vi.fn(async (url: string) => {
    const r = responses[i++] ?? responses[responses.length - 1];
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: r.status === 200 ? 'OK' : 'Error',
      url,
      redirected: false,
      headers: { get: () => null },
      json: async () => r.json,
      text: async () => (r.json === undefined ? '' : JSON.stringify(r.json)),
    };
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

async function storeCredentials() {
  const SecureStore = await import('expo-secure-store');
  await SecureStore.setItemAsync(`jmap_credentials__${ACCOUNT.replace(/[^a-zA-Z0-9._-]/g, '_')}`, JSON.stringify(CREDS));
}

beforeEach(async () => {
  secure.clear();
  await AsyncStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setKnownAccounts([]);
});

describe('saved session', () => {
  it('starts from the session of the last connect, without a request', async () => {
    await storeCredentials();
    mockFetch([{ status: 200, json: SESSION }]);
    expect(await new JMAPClient().loadAccount(ACCOUNT)).toBe(true);
    await vi.waitFor(async () => expect(await AsyncStorage.getAllKeys()).toHaveLength(1));

    const fetch = mockFetch([{ status: 500 }]);
    const client = new JMAPClient();
    expect(await client.loadAccountFromCache(ACCOUNT)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
    expect(client.accountId).toBe('acc-1');
    expect(client.currentSession?.apiUrl).toBe(SESSION.apiUrl);
  });

  it('has nothing to start from before the first connect', async () => {
    await storeCredentials();
    expect(await new JMAPClient().loadAccountFromCache(ACCOUNT)).toBe(false);
  });

  it('ignores a session saved for another server', async () => {
    await storeCredentials();
    await AsyncStorage.setItem(
      `jmap_session_cache__${ACCOUNT}`,
      JSON.stringify({ serverUrl: 'https://old.example.com', session: SESSION }),
    );
    expect(await new JMAPClient().loadAccountFromCache(ACCOUNT)).toBe(false);
  });

  it('is dropped with the credentials', async () => {
    await storeCredentials();
    await AsyncStorage.setItem(
      `jmap_session_cache__${ACCOUNT}`,
      JSON.stringify({ serverUrl: CREDS.serverUrl, session: SESSION }),
    );
    await new JMAPClient().clearAccountCredentials(ACCOUNT);
    expect(await AsyncStorage.getItem(`jmap_session_cache__${ACCOUNT}`)).toBeNull();
  });

  it('revalidates against the server and reports refused credentials', async () => {
    await storeCredentials();
    await AsyncStorage.setItem(
      `jmap_session_cache__${ACCOUNT}`,
      JSON.stringify({ serverUrl: CREDS.serverUrl, session: SESSION }),
    );
    const client = new JMAPClient();
    await client.loadAccountFromCache(ACCOUNT);
    mockFetch([{ status: 401 }]);
    await expect(client.revalidateSession()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('drops a revalidation that finishes after a switch to another account', async () => {
    await storeCredentials();
    await AsyncStorage.setItem(
      `jmap_session_cache__${ACCOUNT}`,
      JSON.stringify({ serverUrl: CREDS.serverUrl, session: SESSION }),
    );
    const client = new JMAPClient();
    await client.loadAccountFromCache(ACCOUNT);
    mockFetch([{ status: 200, json: { ...SESSION, apiUrl: 'https://mail.example.com/jmap2/' } }]);
    const pending = client.revalidateSession();
    client.reset();
    expect(await pending).toBeNull();
    expect(client.currentSession).toBeNull();
  });
});

// Account changes overlap (a switch while the start is still reading the
// saved session, or while it checks it with the server). The client's
// session epoch decides which one owns the client; the saved-session start
// takes part in it like any load.
describe('saved session and overlapping account changes', () => {
  const OTHER = 'other@mail.example.com';
  const OTHER_CREDS = { serverUrl: 'https://mail.example.com', username: 'other', password: 'pass2' };
  const OTHER_SESSION: JMAPSession = {
    ...SESSION,
    primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc-2', 'urn:ietf:params:jmap:core': 'acc-2' },
    accounts: { 'acc-2': { name: 'other@example.com', isPersonal: true, isReadOnly: false } },
  };

  async function saveSession() {
    await storeCredentials();
    await AsyncStorage.setItem(
      `jmap_session_cache__${ACCOUNT}`,
      JSON.stringify({ serverUrl: CREDS.serverUrl, session: SESSION }),
    );
  }

  it('does not let a saved session read before a switch land after it', async () => {
    await saveSession();
    const SecureStore = await import('expo-secure-store');
    await SecureStore.setItemAsync(`jmap_credentials__${OTHER.replace(/[^a-zA-Z0-9._-]/g, '_')}`, JSON.stringify(OTHER_CREDS));

    // The saved session comes off storage slowly.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const realGetItem = AsyncStorage.getItem.bind(AsyncStorage);
    vi.spyOn(AsyncStorage, 'getItem').mockImplementationOnce(async (key: string) => {
      await gate;
      return realGetItem(key);
    });

    const client = new JMAPClient();
    const cachedStart = client.loadAccountFromCache(ACCOUNT);
    mockFetch([{ status: 200, json: OTHER_SESSION }]);
    expect(await client.loadAccount(OTHER)).toBe(true);
    release();

    await expect(cachedStart).rejects.toBeInstanceOf(SessionSupersededError);
    expect(client.accountId).toBe('acc-2');
    expect(client.username).toBe('other');
  });

  it('drops a check of the saved session when a snapshot is put back meanwhile', async () => {
    await saveSession();
    const client = new JMAPClient();
    await client.loadAccountFromCache(ACCOUNT);
    const left = client.snapshot();
    mockFetch([{ status: 200, json: { ...SESSION, apiUrl: 'https://mail.example.com/jmap2/' } }]);

    const pending = client.revalidateSession();
    // A switch that failed puts the account back: same credentials, but a
    // newer account change than the check.
    client.restoreSnapshot(left);

    expect(await pending).toBeNull();
    expect(client.currentSession?.apiUrl).toBe(SESSION.apiUrl);
  });

  it('keeps a check of the saved session across a credential update of the same account', async () => {
    await saveSession();
    const client = new JMAPClient();
    await client.loadAccountFromCache(ACCOUNT);
    mockFetch([{ status: 200, json: { ...SESSION, apiUrl: 'https://mail.example.com/jmap2/' } }]);

    const pending = client.revalidateSession();
    // A password change replaces the credentials object; the account and
    // the account change are the same.
    await client.updatePassword('new-pass');

    expect((await pending)?.apiUrl).toBe('https://mail.example.com/jmap2/');
    expect(client.currentSession?.apiUrl).toBe('https://mail.example.com/jmap2/');
  });

  it('serves nothing on credentials the server refused', async () => {
    await saveSession();
    const client = new JMAPClient();
    await client.loadAccountFromCache(ACCOUNT);
    mockFetch([{ status: 401 }]);

    await expect(client.revalidateSession()).rejects.toBeInstanceOf(AuthenticationError);
    expect(client.currentSession).toBeNull();
    expect(client.isConnected).toBe(false);
  });
});

// Accounts signed in before ports were part of ids keep username@host
// (generateAccountId with the registry). The saved session is keyed by the
// same id, so a host-only account and the account of another server on the
// same host never read each other's.
describe('saved session keys', () => {
  const HOST_ONLY = 'usera@10.10.10.62';
  const PORT = 'usera@10.10.10.62:8016';
  const LEGACY_CREDS = { serverUrl: 'http://10.10.10.62:8120', username: 'usera', password: 'a' };
  const PORT_CREDS = { serverUrl: 'http://10.10.10.62:8016', username: 'usera', password: 'b' };
  const sessionAt = (base: string, jmapAccount: string): JMAPSession => ({
    ...SESSION,
    apiUrl: `${base}/jmap/`,
    downloadUrl: `${base}/download/{accountId}/{blobId}/{name}?type={type}`,
    uploadUrl: `${base}/upload/{accountId}/`,
    eventSourceUrl: `${base}/eventsource/`,
    primaryAccounts: { 'urn:ietf:params:jmap:mail': jmapAccount, 'urn:ietf:params:jmap:core': jmapAccount },
    accounts: { [jmapAccount]: { name: 'usera', isPersonal: true, isReadOnly: false } },
  });

  async function storeBoth() {
    const SecureStore = await import('expo-secure-store');
    const key = (id: string) => `jmap_credentials__${id.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    await SecureStore.setItemAsync(key(HOST_ONLY), JSON.stringify(LEGACY_CREDS));
    await SecureStore.setItemAsync(key(PORT), JSON.stringify(PORT_CREDS));
    setKnownAccounts([
      { id: HOST_ONLY, username: 'usera', serverUrl: LEGACY_CREDS.serverUrl },
      { id: PORT, username: 'usera', serverUrl: PORT_CREDS.serverUrl },
    ]);
  }

  it('keeps the host-only account and the port account apart', async () => {
    await storeBoth();
    mockFetch([{ status: 200, json: sessionAt('http://10.10.10.62:8120', 'a') }]);
    await new JMAPClient().loadAccount(HOST_ONLY);
    mockFetch([{ status: 200, json: sessionAt('http://10.10.10.62:8016', 'b') }]);
    await new JMAPClient().loadAccount(PORT);
    await vi.waitFor(async () => expect(await AsyncStorage.getAllKeys()).toHaveLength(2));

    expect([...(await AsyncStorage.getAllKeys())].sort()).toEqual([
      `jmap_session_cache__${HOST_ONLY}`,
      `jmap_session_cache__${PORT}`,
    ]);
    mockFetch([{ status: 500 }]);
    const legacy = new JMAPClient();
    expect(await legacy.loadAccountFromCache(HOST_ONLY)).toBe(true);
    expect(legacy.accountId).toBe('a');
    const port = new JMAPClient();
    expect(await port.loadAccountFromCache(PORT)).toBe(true);
    expect(port.accountId).toBe('b');
  });

  it('saves a re-read session under the id the account was loaded with', async () => {
    await storeBoth();
    mockFetch([{ status: 200, json: sessionAt('http://10.10.10.62:8120', 'a') }]);
    const client = new JMAPClient();
    await client.loadAccount(HOST_ONLY);
    await vi.waitFor(async () => expect(await AsyncStorage.getAllKeys()).toHaveLength(1));

    // The registry is read again (the headless task fills it from storage,
    // an account entry follows its stored server): the session stays with
    // the account it was loaded for, not with username@host:port.
    setKnownAccounts([]);
    mockFetch([{ status: 200, json: { ...sessionAt('http://10.10.10.62:8120', 'a'), state: 'state-2' } }]);
    await client.refreshSession();
    await vi.waitFor(async () => {
      const saved = JSON.parse((await AsyncStorage.getItem(`jmap_session_cache__${HOST_ONLY}`))!);
      expect(saved.session.state).toBe('state-2');
    });
    expect(await AsyncStorage.getItem('jmap_session_cache__usera@10.10.10.62:8120')).toBeNull();
  });
});
