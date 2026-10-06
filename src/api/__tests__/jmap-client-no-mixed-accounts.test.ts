import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { store } = vi.hoisted(() => ({ store: new Map<string, string>() }));
vi.mock('expo-secure-store', () => ({
  setItemAsync: vi.fn(async (k: string, v: string) => { store.set(k, v); }),
  getItemAsync: vi.fn(async (k: string) => store.get(k) ?? null),
  deleteItemAsync: vi.fn(async (k: string) => { store.delete(k); }),
}));

import { JMAPClient, StaleLoadError } from '../jmap-client';
import { generateAccountId } from '../../lib/account-utils';
import type { JMAPSession } from '../types';

// Security regression suite (review probes P1-P4, P8, P10): no request may
// ever carry one account's Authorization header to another account's server.
// The fetch mock records (host, header) for every request and the suite fails
// as soon as a host sees a header that is not its own account's.

const A = { serverUrl: 'https://a.example.com', username: 'alice', password: 'pa' };
const B = { serverUrl: 'https://b.example.com', username: 'bob', password: 'pb' };
const idA = generateAccountId(A.username, A.serverUrl);
const idB = generateAccountId(B.username, B.serverUrl);
const key = (id: string) => 'jmap_credentials__' + id.replace(/[^a-zA-Z0-9._-]/g, '_');
const basic = (c: { username: string; password: string }) => `Basic ${btoa(`${c.username}:${c.password}`)}`;

/** The only header each host may ever see. */
const OWN_HEADER: Record<string, string> = {
  'a.example.com': basic(A),
  'b.example.com': basic(B),
};

function session(host: string, account: string, shared: string[] = []): JMAPSession {
  const accounts: JMAPSession['accounts'] = {
    [account]: { name: account, isPersonal: true, isReadOnly: false, accountCapabilities: {} },
  };
  for (const id of shared) accounts[id] = { name: id, isPersonal: false, isReadOnly: false, accountCapabilities: {} };
  return {
    apiUrl: `https://${host}/jmap/`,
    downloadUrl: `https://${host}/download/{accountId}/{blobId}/{name}?type={type}`,
    uploadUrl: `https://${host}/upload/{accountId}/`,
    eventSourceUrl: `https://${host}/eventsource/`,
    primaryAccounts: { 'urn:ietf:params:jmap:mail': account },
    accounts,
    capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:mail': {} },
    state: 's1',
    username: account,
  } as JMAPSession;
}

function response(status: number, json?: unknown, url = '') {
  const text = json === undefined ? '' : JSON.stringify(json);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'x',
    redirected: false,
    url,
    headers: { get: () => null },
    json: async () => JSON.parse(text),
    text: async () => text,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface Call { host: string; path: string; auth: string | undefined }
let calls: Call[];
let foreign: Call[];
/** Per-host handler for one fetch. */
let handlers: Record<string, (call: Call) => Promise<unknown>>;

const sessionHandler = (host: string, account: string) => async (call: Call) =>
  call.path.startsWith('/jmap/session') ? response(200, session(host, account)) : response(200, { methodResponses: [] });

beforeEach(() => {
  store.clear();
  store.set(key(idA), JSON.stringify(A));
  store.set(key(idB), JSON.stringify(B));
  calls = [];
  foreign = [];
  handlers = {
    'a.example.com': sessionHandler('a.example.com', 'alice'),
    'b.example.com': sessionHandler('b.example.com', 'bob'),
  };
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const auth = (init?.headers as Record<string, string> | undefined)?.Authorization;
    const call = { host: u.host, path: u.pathname, auth };
    calls.push(call);
    if (auth !== OWN_HEADER[u.host]) foreign.push(call);
    return handlers[u.host](call);
  }) as unknown as typeof fetch;
});
afterEach(() => {
  vi.useRealTimers();
  expect(foreign).toEqual([]);
});

async function onA(): Promise<JMAPClient> {
  const client = new JMAPClient();
  expect(await client.loadAccount(idA)).toBe(true);
  calls = [];
  return client;
}

const waitForCall = (pred: (c: Call) => boolean) => vi.waitFor(() => expect(calls.some(pred)).toBe(true));

describe('no request mixes accounts', () => {
  it('P1: a load\'s .well-known fallback after a switch is not sent with the new account\'s header', async () => {
    const client = new JMAPClient();
    const primary = deferred<unknown>();
    handlers['a.example.com'] = async (call) => (call.path.startsWith('/jmap/session') ? primary.promise : response(200, session('a.example.com', 'alice')));
    const loadA = client.loadAccount(idA).catch((e) => e);
    await waitForCall((c) => c.host === 'a.example.com');
    expect(await client.loadAccount(idB)).toBe(true);
    primary.resolve(response(404));
    expect(await loadA).toBeInstanceOf(StaleLoadError);
    expect(calls.filter((c) => c.path === '/.well-known/jmap')).toEqual([]);
    expect(client.authHeader).toBe(basic(B));
  });

  it('P1: a redirect refetch inside a load uses that load\'s own credentials', async () => {
    const client = await onA();
    // B's session fetch is redirected (platform followed it, header dropped: 401).
    let n = 0;
    handlers['b.example.com'] = async (call) => {
      n += 1;
      if (n === 1) return response(401, undefined, 'https://b.example.com/jmap/session/');
      return response(200, session('b.example.com', 'bob'));
    };
    expect(await client.loadAccount(idB)).toBe(true);
    expect(calls.filter((c) => c.host === 'b.example.com').length).toBeGreaterThanOrEqual(2);
    expect(client.authHeader).toBe(basic(B));
  });

  it('P2: a concurrency-refusal replay after a switch is not sent to the old server with the new header', async () => {
    vi.useFakeTimers();
    const client = await onA();
    handlers['a.example.com'] = async () => response(400, { type: 'urn:ietf:params:jmap:error:limit', limit: 'maxConcurrentRequests' });
    const req = client.request([['Email/get', { accountId: 'alice' }, '0']]).catch((e) => e);
    await waitForCall((c) => c.host === 'a.example.com' && c.path === '/jmap/');
    expect(await client.loadAccount(idB)).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await req).toBeInstanceOf(StaleLoadError);
    expect(calls.filter((c) => c.host === 'a.example.com' && c.path === '/jmap/')).toHaveLength(1);
  });

  it('P2: a request held by the first-touch gate across a switch is not sent with the new header', async () => {
    const client = await onA();
    const first = deferred<unknown>();
    handlers['a.example.com'] = () => first.promise;
    const r1 = client.request([['Calendar/get', { accountId: 'alice' }, '0']], ['urn:ietf:params:jmap:core']).catch((e) => e);
    const r2 = client.request([['CalendarEvent/query', { accountId: 'alice' }, '0']], ['urn:ietf:params:jmap:core']).catch((e) => e);
    await waitForCall((c) => c.host === 'a.example.com');
    expect(await client.loadAccount(idB)).toBe(true);
    first.resolve(response(200, { methodResponses: [] }));
    await r1;
    expect(await r2).toBeInstanceOf(StaleLoadError);
    expect(calls.filter((c) => c.host === 'a.example.com')).toHaveLength(1);
  });

  it('P3: a request made while another account loads keeps the old connection whole', async () => {
    const client = await onA();
    const bSession = deferred<unknown>();
    handlers['b.example.com'] = () => bSession.promise;
    const loadB = client.loadAccount(idB);
    await waitForCall((c) => c.host === 'b.example.com');

    // Mid-load: the client still serves A, header and URL alike.
    expect(client.authHeader).toBe(basic(A));
    expect(client.currentSession?.apiUrl).toBe('https://a.example.com/jmap/');
    await client.request([['Mailbox/get', { accountId: 'alice' }, '0']]);
    const ctx = client.requestContext();
    expect(ctx.authHeader).toBe(basic(A));
    expect(ctx.apiUrl).toBe('https://a.example.com/jmap/');

    bSession.resolve(response(200, session('b.example.com', 'bob')));
    expect(await loadB).toBe(true);
    expect(client.authHeader).toBe(basic(B));
    expect(client.currentSession?.apiUrl).toBe('https://b.example.com/jmap/');
  });

  it('P4: a request made while a sign-in to another account runs keeps the old connection whole', async () => {
    const client = await onA();
    const bSession = deferred<unknown>();
    handlers['b.example.com'] = () => bSession.promise;
    const connectB = client.connect(B.serverUrl, B.username, B.password);
    await waitForCall((c) => c.host === 'b.example.com');
    await client.request([['Mailbox/get', { accountId: 'alice' }, '0']]);
    expect(client.authHeader).toBe(basic(A));
    bSession.resolve(response(200, session('b.example.com', 'bob')));
    await connectB;
    expect(client.authHeader).toBe(basic(B));
  });

  it('P4: a failed sign-in leaves the old connection as it was', async () => {
    const client = await onA();
    // B's server rejects the sign-in (say, a revoked password).
    handlers['b.example.com'] = async () => response(401);
    await expect(client.connect(B.serverUrl, B.username, B.password)).rejects.toThrow();
    expect(client.authHeader).toBe(basic(A));
    expect(client.currentSession?.apiUrl).toBe('https://a.example.com/jmap/');
    await client.request([['Mailbox/get', { accountId: 'alice' }, '0']]);
  });

  it('P8: an external fetch whose URL came from A gets no header once B is live', async () => {
    const client = await onA();
    const { gen, uploadUrl } = client.requestContext();
    expect(uploadUrl).toContain('a.example.com');
    expect(client.authHeaderFor(gen)).toBe(basic(A));
    expect(await client.loadAccount(idB)).toBe(true);
    expect(() => client.authHeaderFor(gen)).toThrow(StaleLoadError);
    expect(() => client.assertCurrent(gen)).toThrow(StaleLoadError);
  });

  it('P10: a request for A during the switch to B is answered by A and does not cancel the switch', async () => {
    const client = await onA();
    const bSession = deferred<unknown>();
    handlers['b.example.com'] = () => bSession.promise;
    const onAuthFailure = vi.fn();
    client.onAuthFailure(onAuthFailure);
    const loadB = client.loadAccount(idB);
    await waitForCall((c) => c.host === 'b.example.com');
    // A answers its own request fine: it got A's header, not B's.
    await expect(client.request([['Email/get', { accountId: 'alice' }, '0']])).resolves.toBeDefined();
    bSession.resolve(response(200, session('b.example.com', 'bob')));
    expect(await loadB).toBe(true);
    expect(onAuthFailure).not.toHaveBeenCalled();
    expect(client.currentSession?.apiUrl).toBe('https://b.example.com/jmap/');
  });

  it('a superseded connection does not report reachability', async () => {
    const { setServerReachabilitySink } = await import('../../lib/server-reachability');
    const sink = { response: vi.fn(), unreachable: vi.fn() };
    const client = new JMAPClient({ reportsReachability: true });
    expect(await client.loadAccount(idA)).toBe(true);
    const aReply = deferred<unknown>();
    handlers['a.example.com'] = () => aReply.promise;
    const req = client.request([['Email/get', { accountId: 'alice' }, '0']]);
    await waitForCall((c) => c.host === 'a.example.com' && c.path === '/jmap/');
    expect(await client.loadAccount(idB)).toBe(true);
    setServerReachabilitySink(sink);
    try {
      aReply.resolve(response(200, { methodResponses: [] }));
      await req;
      expect(sink.response).not.toHaveBeenCalled();
    } finally {
      setServerReachabilitySink(null);
    }
  });

  // I-1: a multi-request operation (a batched Email/set, a year/month archive,
  // a cross-account move, undo) captures the connection per request. Its later
  // requests must not go to the account switched to with the old account's id,
  // even when the new login could see that account as a shared one.
  it('I-1: a batch split across a switch sends nothing after the switch', async () => {
    const client = await onA();
    handlers['b.example.com'] = async (call) => (call.path.startsWith('/jmap/session')
      ? response(200, session('b.example.com', 'bob'))
      : response(200, { methodResponses: [['Email/set', { updated: {} }, '0']] }));
    handlers['a.example.com'] = async () => response(200, { methodResponses: [['Email/set', { updated: {} }, '0']] });
    const slices = [['m1', 'm2'], ['m3', 'm4'], ['m5']];
    const run = (async () => {
      for (const [i, slice] of slices.entries()) {
        // Like emailSetBatched: the account id is resolved once, up front.
        await client.request([['Email/set', { accountId: 'alice', update: Object.fromEntries(slice.map((id) => [id, { 'keywords/$seen': true }])) }, '0']]);
        if (i === 0) {
          // The user switches to B between the first and the second slice.
          expect(await client.loadAccount(idB)).toBe(true);
          calls = [];
        }
      }
    })();
    await expect(run).rejects.toBeInstanceOf(StaleLoadError);
    expect(calls.filter((c) => c.path === '/jmap/')).toEqual([]);
  });

  it('I-1: a copy whose fromAccountId is not in the session is not sent', async () => {
    const client = await onA();
    expect(await client.loadAccount(idB)).toBe(true);
    calls = [];
    await expect(client.request([
      ['Email/copy', { fromAccountId: 'alice', accountId: 'bob', create: {} }, '0'],
    ])).rejects.toBeInstanceOf(StaleLoadError);
    await expect(client.request([
      ['Email/get', { accountId: 'bob' }, '0'],
      ['Email/set', { accountId: 'alice', destroy: ['m1'] }, '1'],
    ])).rejects.toBeInstanceOf(StaleLoadError);
    expect(calls).toEqual([]);
  });

  it('I-1: a shared-account request within the same session still goes through', async () => {
    handlers['a.example.com'] = async (call) => (call.path.startsWith('/jmap/session')
      ? response(200, session('a.example.com', 'alice', ['team']))
      : response(200, { methodResponses: [] }));
    const client = await onA();
    await client.request([['Email/set', { accountId: 'team', destroy: ['m1'] }, '0']]);
    await client.request([['Email/copy', { fromAccountId: 'team', accountId: 'alice', create: {} }, '0']]);
    // Calls without an account id (Core/echo) are not affected.
    await client.request([['Core/echo', { hello: true }, '0']]);
    expect(calls.filter((c) => c.host === 'a.example.com' && c.path === '/jmap/')).toHaveLength(3);
  });
});
