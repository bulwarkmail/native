import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const secure = new Map<string, string>();
vi.mock('expo-secure-store', () => ({
  setItemAsync: vi.fn(async (k: string, v: string) => { secure.set(k, v); }),
  getItemAsync: vi.fn(async (k: string) => secure.get(k) ?? null),
  deleteItemAsync: vi.fn(async (k: string) => { secure.delete(k); }),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { JMAPClient, AuthenticationError } from '../jmap-client';
import type { JMAPSession } from '../types';

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
