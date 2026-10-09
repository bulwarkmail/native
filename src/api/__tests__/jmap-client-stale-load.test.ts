import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock('expo-secure-store', () => ({
  setItemAsync: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
  getItemAsync: vi.fn(async (k: string) => store.get(k) ?? null),
  deleteItemAsync: vi.fn(async (k: string) => { store.delete(k); }),
}));

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));
vi.mock('../../lib/oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/oauth')>();
  return { ...actual, refreshOAuthAccessToken: mockRefresh };
});

import { JMAPClient, StaleLoadError, AuthenticationError } from '../jmap-client';
import { generateAccountId } from '../../lib/account-utils';
import type { JMAPSession } from '../types';

// C-1: the session retry starts loadAccount(A) while A's server is down, the
// user switches to B and B loads; then A's load settles. Whatever A's outcome,
// the shared client must keep B's session and B's credentials, and A's load
// must reject with StaleLoadError having changed nothing.

const A = { serverUrl: 'https://a.example.com', username: 'alice', password: 'pa' };
const B = { serverUrl: 'https://b.example.com', username: 'bob', password: 'pb' };
const idA = generateAccountId(A.username, A.serverUrl);
const idB = generateAccountId(B.username, B.serverUrl);

function session(host: string, account: string): JMAPSession {
  return {
    apiUrl: `https://${host}/jmap/`,
    downloadUrl: `https://${host}/download/{accountId}/{blobId}/{name}?type={type}`,
    uploadUrl: `https://${host}/upload/{accountId}/`,
    eventSourceUrl: `https://${host}/eventsource/`,
    primaryAccounts: { 'urn:ietf:params:jmap:mail': account },
    accounts: { [account]: { name: account, isPersonal: true, isReadOnly: false, accountCapabilities: {} } },
    capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:mail': {} },
    state: 's1',
    username: account,
  } as JMAPSession;
}

function response(status: number, json?: unknown) {
  const text = json === undefined ? '' : JSON.stringify(json);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    redirected: false,
    url: '',
    headers: { get: () => null },
    json: async () => JSON.parse(text),
    text: async () => text,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

interface Call { url: string; auth: string | undefined }
let calls: Call[];
/** Per-host handler; returns the response (or throws) for one fetch. */
let handlers: Record<string, (call: Call) => Promise<unknown>>;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Mirrors jmap-client's credentialsKey; keysCheck() fails if it drifts.
const key = (id: string) => 'jmap_credentials__' + id.replace(/[^a-zA-Z0-9._-]/g, '_');

const basic = (c: { username: string; password: string }) => `Basic ${btoa(`${c.username}:${c.password}`)}`;

beforeEach(() => {
  store.clear();
  store.set(key(idA), JSON.stringify(A));
  store.set(key(idB), JSON.stringify(B));
  calls = [];
  handlers = {};
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    const call = { url, auth };
    calls.push(call);
    return handlers[new URL(url).host](call);
  }) as unknown as typeof fetch;
});
afterEach(() => vi.useRealTimers());

async function keysCheck(): Promise<void> {
  // The test's storage keys must match the client's; fail loudly otherwise.
  const probe = new JMAPClient();
  handlers['b.example.com'] = async () => response(200, session('b.example.com', 'bob'));
  expect(await probe.loadAccount(idB)).toBe(true);
  calls = [];
}

describe('a superseded session load (C-1)', () => {
  it('A fails late: the client keeps B, and A rejects with StaleLoadError', async () => {
    await keysCheck();
    const client = new JMAPClient();
    const aFetch = deferred<unknown>();
    handlers['a.example.com'] = () => aFetch.promise;
    handlers['b.example.com'] = async () => response(200, session('b.example.com', 'bob'));

    const loadA = client.loadAccount(idA).catch((e) => e);
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes('a.example.com'))).toBe(true));
    expect(await client.loadAccount(idB)).toBe(true);

    aFetch.reject(new AuthenticationError('late 401 for A'));
    expect(await loadA).toBeInstanceOf(StaleLoadError);
    expect(client.currentSession?.apiUrl).toBe('https://b.example.com/jmap/');
    expect(client.serverUrl).toBe(B.serverUrl);
    expect(client.authHeader).toBe(basic(B));
    expect(client.accountId).toBe('bob');
  });

  it('A fails late with a transport error: no retry carries B\'s header to A', async () => {
    vi.useFakeTimers();
    await keysCheck();
    const client = new JMAPClient();
    const aFetch = deferred<unknown>();
    handlers['a.example.com'] = () => aFetch.promise;
    handlers['b.example.com'] = async () => response(200, session('b.example.com', 'bob'));

    const loadA = client.loadAccount(idA).catch((e) => e);
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes('a.example.com'))).toBe(true));
    expect(await client.loadAccount(idB)).toBe(true);
    aFetch.reject(new TypeError('Network request failed'));
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await loadA).toBeInstanceOf(StaleLoadError);
    expect(calls.filter((c) => c.url.includes('a.example.com')).every((c) => c.auth === basic(A))).toBe(true);
    expect(client.currentSession?.apiUrl).toBe('https://b.example.com/jmap/');
    expect(client.authHeader).toBe(basic(B));
  });

  it('A succeeds late: the client keeps B\'s session with B\'s credentials', async () => {
    await keysCheck();
    const client = new JMAPClient();
    const aFetch = deferred<unknown>();
    handlers['a.example.com'] = () => aFetch.promise;
    handlers['b.example.com'] = async () => response(200, session('b.example.com', 'bob'));

    const loadA = client.loadAccount(idA).catch((e) => e);
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes('a.example.com'))).toBe(true));
    expect(await client.loadAccount(idB)).toBe(true);

    aFetch.resolve(response(200, session('a.example.com', 'alice')));
    expect(await loadA).toBeInstanceOf(StaleLoadError);
    expect(client.currentSession?.apiUrl).toBe('https://b.example.com/jmap/');
    expect(client.serverUrl).toBe(B.serverUrl);
    expect(client.authHeader).toBe(basic(B));
    expect(client.accountId).toBe('bob');
  });

  it('a load superseded while reading storage changes nothing', async () => {
    await keysCheck();
    const client = new JMAPClient();
    handlers['b.example.com'] = async () => response(200, session('b.example.com', 'bob'));
    const loadA = client.loadAccount(idA).catch((e) => e);
    const loadB = client.loadAccount(idB);
    expect(await loadA).toBeInstanceOf(StaleLoadError);
    expect(await loadB).toBe(true);
    expect(calls.some((c) => c.url.includes('a.example.com'))).toBe(false);
    expect(client.authHeader).toBe(basic(B));
  });

  it('a reset supersedes a load in flight', async () => {
    await keysCheck();
    const client = new JMAPClient();
    const aFetch = deferred<unknown>();
    handlers['a.example.com'] = () => aFetch.promise;
    const loadA = client.loadAccount(idA).catch((e) => e);
    await vi.waitFor(() => expect(calls.length).toBe(1));
    client.reset();
    aFetch.resolve(response(200, session('a.example.com', 'alice')));
    expect(await loadA).toBeInstanceOf(StaleLoadError);
    expect(client.currentSession).toBeNull();
    expect(client.isConnected).toBe(false);
  });

  it('a request for A retried after the switch to B is not sent with B\'s header', async () => {
    vi.useFakeTimers();
    await keysCheck();
    const client = new JMAPClient();
    handlers['a.example.com'] = async () => response(200, session('a.example.com', 'alice'));
    expect(await client.loadAccount(idA)).toBe(true);

    let first = true;
    handlers['a.example.com'] = async () => {
      if (first) { first = false; throw new TypeError('Network request failed'); }
      return response(200, { methodResponses: [] });
    };
    handlers['b.example.com'] = async () => response(200, session('b.example.com', 'bob'));
    calls = [];
    const req = client.request([['Mailbox/get', { accountId: 'alice' }, '0']]).catch((e) => e);
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(await client.loadAccount(idB)).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(await req).toBeInstanceOf(StaleLoadError);
    const toA = calls.filter((c) => c.url.includes('a.example.com'));
    expect(toA).toHaveLength(1);
    expect(toA[0].auth).toBe(basic(A));
  });

  it('a late 401 for a request made for A does not report an auth failure for B', async () => {
    await keysCheck();
    const client = new JMAPClient();
    handlers['a.example.com'] = async () => response(200, session('a.example.com', 'alice'));
    expect(await client.loadAccount(idA)).toBe(true);
    const onAuthFailure = vi.fn();
    client.onAuthFailure(onAuthFailure);

    const aFetch = deferred<unknown>();
    handlers['a.example.com'] = () => aFetch.promise;
    handlers['b.example.com'] = async () => response(200, session('b.example.com', 'bob'));
    calls = [];
    const req = client.request([['Email/set', { accountId: 'alice' }, '0']]).catch((e) => e);
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(await client.loadAccount(idB)).toBe(true);
    aFetch.resolve(response(401));

    expect(await req).toBeInstanceOf(StaleLoadError);
    expect(onAuthFailure).not.toHaveBeenCalled();
    expect(client.authHeader).toBe(basic(B));
  });

  it('a superseded connect does not restore the client it replaced', async () => {
    await keysCheck();
    const client = new JMAPClient();
    const aFetch = deferred<unknown>();
    handlers['a.example.com'] = () => aFetch.promise;
    handlers['b.example.com'] = async () => response(200, session('b.example.com', 'bob'));
    const connectA = client.connectWithToken(A.serverUrl, 'token-a').catch((e) => e);
    await vi.waitFor(() => expect(calls.length).toBe(1));
    expect(await client.loadAccount(idB)).toBe(true);
    aFetch.reject(new AuthenticationError('rejected'));
    expect(await connectA).toBeInstanceOf(StaleLoadError);
    expect(client.currentSession?.apiUrl).toBe('https://b.example.com/jmap/');
    expect(client.authHeader).toBe(basic(B));
  });

  it('a token refresh that outlives a switch stores A\'s tokens under A and leaves B live', async () => {
    await keysCheck();
    const aOAuth = {
      serverUrl: A.serverUrl, username: A.username, password: '', accessToken: 'old-a', refreshToken: 'r-a',
      expiresAt: Date.now() + 1_000, tokenEndpoint: 'https://a.example.com/token', clientId: 'c',
    };
    store.set(key(idA), JSON.stringify(aOAuth));
    const client = new JMAPClient();
    handlers['a.example.com'] = async () => response(200, session('a.example.com', 'alice'));
    handlers['b.example.com'] = async () => response(200, session('b.example.com', 'bob'));
    mockRefresh.mockResolvedValueOnce({ ...aOAuth, accessToken: 'old-a' }); // load's own refresh: unchanged
    expect(await client.loadAccount(idA)).toBe(true);

    const refreshed = deferred<unknown>();
    mockRefresh.mockImplementationOnce(() => refreshed.promise);
    const refresh = client.ensureFreshToken();
    expect(await client.loadAccount(idB)).toBe(true);
    refreshed.resolve({ accessToken: 'new-a', refreshToken: 'r-a2', expiresAt: Date.now() + 3_600_000, tokenEndpoint: aOAuth.tokenEndpoint, clientId: 'c' });
    await refresh;

    expect(client.authHeader).toBe(basic(B));
    const storedA = JSON.parse(store.get(key(idA))!);
    expect(storedA.accessToken).toBe('new-a');
    expect(storedA.refreshToken).toBe('r-a2');
    expect(JSON.parse(store.get(key(idB))!).accessToken).toBeUndefined();
  });

  it('does not bring back the credentials of an account signed out while its refresh ran', async () => {
    await keysCheck();
    const aOAuth = {
      serverUrl: A.serverUrl, username: A.username, password: '', accessToken: 'old-a', refreshToken: 'r-a',
      expiresAt: Date.now() + 1_000, tokenEndpoint: 'https://a.example.com/token', clientId: 'c',
    };
    store.set(key(idA), JSON.stringify(aOAuth));
    const client = new JMAPClient();
    handlers['a.example.com'] = async () => response(200, session('a.example.com', 'alice'));
    mockRefresh.mockResolvedValueOnce({ ...aOAuth });
    expect(await client.loadAccount(idA)).toBe(true);

    const refreshed = deferred<unknown>();
    mockRefresh.mockImplementationOnce(() => refreshed.promise);
    const refresh = client.ensureFreshToken();
    await client.logout();
    refreshed.resolve({ accessToken: 'new-a', refreshToken: 'r-a2', expiresAt: Date.now() + 3_600_000, tokenEndpoint: aOAuth.tokenEndpoint, clientId: 'c' });
    await refresh;
    expect(store.has(key(idA))).toBe(false);
  });

  it('a refresh that outlives a reload of the same account updates the live connection too', async () => {
    await keysCheck();
    const aOAuth = {
      serverUrl: A.serverUrl, username: A.username, password: '', accessToken: 'old-a', refreshToken: 'r-a',
      expiresAt: Date.now() + 1_000, tokenEndpoint: 'https://a.example.com/token', clientId: 'c',
    };
    store.set(key(idA), JSON.stringify(aOAuth));
    const client = new JMAPClient();
    handlers['a.example.com'] = async () => response(200, session('a.example.com', 'alice'));
    mockRefresh.mockResolvedValue({ ...aOAuth }); // loads' own proactive refreshes: unchanged
    expect(await client.loadAccount(idA)).toBe(true);

    const refreshed = deferred<unknown>();
    mockRefresh.mockImplementationOnce(() => refreshed.promise);
    const refresh = client.ensureFreshToken();
    // The same account is loaded again (a session retry) while the refresh runs.
    expect(await client.loadAccount(idA)).toBe(true);
    refreshed.resolve({ accessToken: 'new-a', refreshToken: 'r-a2', expiresAt: Date.now() + 3_600_000, tokenEndpoint: aOAuth.tokenEndpoint, clientId: 'c' });
    await refresh;

    // The rotated refresh token is neither lost in memory nor in storage.
    expect(client.authHeader).toBe('Bearer new-a');
    expect(JSON.parse(store.get(key(idA))!).refreshToken).toBe('r-a2');
    mockRefresh.mockReset();
  });

  // I-2: A uses OAuth. switchAccount(B) takes a snapshot; while B loads, a
  // 401 on A rotates A's tokens (at-a1/rt-a1 -> at-a2/rt-a2). B's load fails
  // and the snapshot is put back. Restoring rt-a1 would make the next refresh
  // reuse a rotated-away refresh token, which an IdP with reuse detection
  // answers by revoking the whole token family.
  it('a failed switch keeps the tokens A rotated while B was loading (I-2)', async () => {
    await keysCheck();
    const aOAuth = {
      serverUrl: A.serverUrl, username: A.username, password: '', accessToken: 'at-a1', refreshToken: 'rt-a1',
      expiresAt: Date.now() + 3_600_000, tokenEndpoint: 'https://a.example.com/token', clientId: 'c',
    };
    store.set(key(idA), JSON.stringify(aOAuth));
    const client = new JMAPClient();
    let aApi = 0;
    handlers['a.example.com'] = async (call) => {
      if (!call.url.endsWith('/jmap/')) return response(200, session('a.example.com', 'alice'));
      aApi += 1;
      return aApi === 1 ? response(401) : response(200, { methodResponses: [] });
    };
    expect(await client.loadAccount(idA)).toBe(true);

    const snap = client.snapshot();
    const bSession = deferred<unknown>();
    handlers['b.example.com'] = () => bSession.promise;
    const loadB = client.loadAccount(idB).catch((e) => e);
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes('b.example.com'))).toBe(true));

    // A request on A meets a 401 and rotates A's tokens.
    mockRefresh.mockResolvedValueOnce({
      accessToken: 'at-a2', refreshToken: 'rt-a2', expiresAt: Date.now() + 3_600_000,
      tokenEndpoint: aOAuth.tokenEndpoint, clientId: 'c',
    });
    await client.request([['Mailbox/get', { accountId: 'alice' }, '0']]);
    expect(mockRefresh).toHaveBeenCalledTimes(1);
    expect(JSON.parse(store.get(key(idA))!).refreshToken).toBe('rt-a2');

    // B's load fails; the switch puts A back.
    bSession.reject(new TypeError('Network request failed'));
    await loadB;
    client.restoreSnapshot(snap);

    expect(client.authHeader).toBe('Bearer at-a2');
    expect(JSON.parse(store.get(key(idA))!).refreshToken).toBe('rt-a2');
    // The next refresh presents the live refresh token, not the rotated-away one.
    mockRefresh.mockResolvedValueOnce({
      accessToken: 'at-a3', refreshToken: 'rt-a3', expiresAt: Date.now() + 3_600_000,
      tokenEndpoint: aOAuth.tokenEndpoint, clientId: 'c',
    });
    expect(await client.forceRefreshToken()).toBe(true);
    expect(mockRefresh.mock.calls[1][0].refreshToken).toBe('rt-a2');
    expect(client.authHeader).toBe('Bearer at-a3');
    mockRefresh.mockReset();
  });

  it('a restored snapshot on another token chain keeps its own tokens (I-2)', async () => {
    await keysCheck();
    const aOAuth = {
      serverUrl: A.serverUrl, username: A.username, password: '', accessToken: 'at-a1', refreshToken: 'rt-a1',
      expiresAt: Date.now() + 3_600_000, tokenEndpoint: 'https://a.example.com/token', clientId: 'c',
    };
    store.set(key(idA), JSON.stringify(aOAuth));
    const client = new JMAPClient();
    handlers['a.example.com'] = async () => response(200, session('a.example.com', 'alice'));
    expect(await client.loadAccount(idA)).toBe(true);
    // Another chain of A's (say, a re-sign-in) is rotated after the snapshot.
    mockRefresh.mockResolvedValueOnce({
      accessToken: 'at-old2', refreshToken: 'rt-old2', expiresAt: Date.now() + 3_600_000,
      tokenEndpoint: aOAuth.tokenEndpoint, clientId: 'c',
    });
    const snap = client.snapshot();
    store.set(key(idA), JSON.stringify({ ...aOAuth, accessToken: 'at-old', refreshToken: 'rt-old' }));
    expect(await client.loadAccount(idA)).toBe(true);
    expect(await client.forceRefreshToken()).toBe(true);
    expect(client.authHeader).toBe('Bearer at-old2');
    client.restoreSnapshot(snap);
    expect(client.authHeader).toBe('Bearer at-a1');
    mockRefresh.mockReset();
  });
});

describe('a session refresh', () => {
  const withShare = (host: string, account: string, shared: string): JMAPSession => {
    const s = session(host, account);
    return {
      ...s,
      accounts: { ...s.accounts, [shared]: { name: shared, isPersonal: false, isReadOnly: false, accountCapabilities: {} } },
    } as JMAPSession;
  };

  it('swaps in the new session document on the live connection and keeps its account', async () => {
    await keysCheck();
    const client = new JMAPClient();
    handlers['a.example.com'] = async () => response(200, session('a.example.com', 'alice'));
    expect(await client.loadAccount(idA)).toBe(true);
    const gen = client.connectionGen;
    handlers['a.example.com'] = async () => response(200, withShare('a.example.com', 'alice', 'dana'));

    const fresh = await client.refreshSession();
    expect(Object.keys(fresh?.accounts ?? {})).toEqual(['alice', 'dana']);
    expect(client.currentSession).toBe(fresh);
    expect(client.accountId).toBe('alice');
    // The same connection: requests already made on it keep going.
    expect(client.connectionGen).toBe(gen);
    expect(client.isCurrent(gen)).toBe(true);
  });

  it('a session refresh that a switch overtakes changes nothing', async () => {
    await keysCheck();
    const client = new JMAPClient();
    handlers['a.example.com'] = async () => response(200, session('a.example.com', 'alice'));
    expect(await client.loadAccount(idA)).toBe(true);
    const before = client.currentSession;
    const aFetch = deferred<unknown>();
    const bFetch = deferred<unknown>();
    handlers['a.example.com'] = () => aFetch.promise;
    handlers['b.example.com'] = () => bFetch.promise;

    const refresh = client.refreshSession();
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes('a.example.com'))).toBe(true));
    // The switch starts while the refresh is out; A still serves until B commits.
    const loadB = client.loadAccount(idB);
    await vi.waitFor(() => expect(calls.some((c) => c.url.includes('b.example.com'))).toBe(true));
    aFetch.resolve(response(200, withShare('a.example.com', 'alice', 'dana')));
    expect(await refresh).toBeNull();
    expect(client.currentSession).toBe(before);

    bFetch.resolve(response(200, session('b.example.com', 'bob')));
    expect(await loadB).toBe(true);
    expect(client.accountId).toBe('bob');
    expect(Object.keys(client.currentSession?.accounts ?? {})).toEqual(['bob']);
  });

  it('does nothing without a live session', async () => {
    const client = new JMAPClient();
    expect(await client.refreshSession()).toBeNull();
    expect(calls).toEqual([]);
  });

  it('keeps the live session when the new document lacks the connection\'s account', async () => {
    await keysCheck();
    const client = new JMAPClient();
    handlers['a.example.com'] = async () => response(200, session('a.example.com', 'alice'));
    expect(await client.loadAccount(idA)).toBe(true);
    const before = client.currentSession;
    handlers['a.example.com'] = async () => response(200, session('a.example.com', 'someone-else'));
    expect(await client.refreshSession()).toBeNull();
    expect(client.currentSession).toBe(before);
    expect(client.accountId).toBe('alice');
  });
});
