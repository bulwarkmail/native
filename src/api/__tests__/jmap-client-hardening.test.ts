import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('expo-secure-store', () => ({
  setItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

const { mockRefresh } = vi.hoisted(() => ({ mockRefresh: vi.fn() }));
vi.mock('../../lib/oauth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/oauth')>();
  return { ...actual, refreshOAuthAccessToken: mockRefresh };
});

import {
  JMAPClient,
  AuthenticationError,
  NetworkError,
  RateLimitError,
  RequestTimeoutError,
  TotpRequiredError,
  JMAPMethodError,
  requireMethodResult,
  assertSetResult,
  rewriteSessionUrl,
  parseRetryAfter,
  isConcurrentRequestRefusal,
  batched,
} from '../jmap-client';
import { TransientRefreshError } from '../../lib/oauth';
import { FirstTouchGate, gateKeysFor } from '../first-touch-gate';
import type { JMAPSession } from '../types';

const SESSION: JMAPSession = {
  apiUrl: 'https://mail.example.com/jmap/',
  downloadUrl: 'https://mail.example.com/download/{accountId}/{blobId}/{name}?type={type}',
  uploadUrl: 'https://mail.example.com/upload/{accountId}/',
  eventSourceUrl: 'https://mail.example.com/eventsource/?types={types}&closeafter={closeafter}&ping={ping}',
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc-1' },
  accounts: {
    'acc-1': {
      name: 'user@example.com',
      isPersonal: true,
      isReadOnly: false,
      accountCapabilities: { 'urn:stalwart:jmap': {} },
    },
  },
  capabilities: {
    'urn:ietf:params:jmap:core': { maxObjectsInSet: 50, maxSizeUpload: 1024 },
    'urn:ietf:params:jmap:mail': {},
  },
  state: 's1',
  username: 'user@example.com',
};

type Resp = {
  status: number;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
  redirected?: boolean;
  url?: string;
  delayMs?: number;
  throw?: Error;
};

function makeResponse(resp: Resp) {
  const text = resp.text ?? (resp.json === undefined ? '' : JSON.stringify(resp.json));
  return {
    ok: resp.status >= 200 && resp.status < 300,
    status: resp.status,
    statusText: 'x',
    redirected: resp.redirected ?? false,
    url: resp.url ?? '',
    headers: { get: (n: string) => resp.headers?.[n] ?? null },
    json: async () => (resp.json !== undefined ? resp.json : JSON.parse(text)),
    text: async () => text,
    arrayBuffer: async () => new ArrayBuffer(0),
  };
}

function mockFetch(responses: Resp[]) {
  let i = 0;
  const fn = vi.fn(async (_url: string, init?: RequestInit) => {
    const resp = responses[i++] ?? responses[responses.length - 1];
    if (resp.throw) throw resp.throw;
    if (resp.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, resp.delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          const e = new Error('Aborted');
          e.name = 'AbortError';
          reject(e);
        });
      });
    }
    return makeResponse(resp);
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

async function connected(): Promise<JMAPClient> {
  mockFetch([{ status: 200, json: SESSION }]);
  const client = new JMAPClient();
  await client.connect('https://mail.example.com', 'user', 'pass');
  return client;
}

describe('pure helpers', () => {
  it('rewriteSessionUrl rebases relative and foreign-origin URLs, keeps templates', () => {
    const origin = 'https://mail.example.com';
    expect(rewriteSessionUrl('/jmap/', origin)).toBe('https://mail.example.com/jmap/');
    expect(rewriteSessionUrl('jmap/', origin)).toBe('https://mail.example.com/jmap/');
    expect(rewriteSessionUrl('http://localhost:8080/download/{accountId}/{blobId}/{name}?type={type}', origin))
      .toBe('https://mail.example.com/download/{accountId}/{blobId}/{name}?type={type}');
    expect(rewriteSessionUrl('https://mail.example.com/x', origin)).toBe('https://mail.example.com/x');
    expect(rewriteSessionUrl(undefined, origin)).toBeUndefined();
  });

  it('parseRetryAfter handles seconds, HTTP-date, garbage', () => {
    expect(parseRetryAfter('10')).toBe(10_000);
    expect(parseRetryAfter('9999')).toBe(300_000);
    const future = new Date(Date.now() + 30_000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(25_000);
    expect(ms).toBeLessThanOrEqual(31_000);
    expect(parseRetryAfter('bogus')).toBe(60_000);
    expect(parseRetryAfter(null)).toBe(60_000);
  });

  it('isConcurrentRequestRefusal matches only the limit error', () => {
    expect(isConcurrentRequestRefusal(400, JSON.stringify({ type: 'urn:ietf:params:jmap:error:limit', limit: 'maxConcurrentRequests' }))).toBe(true);
    expect(isConcurrentRequestRefusal(400, JSON.stringify({ type: 'urn:ietf:params:jmap:error:limit', limit: 'maxSizeRequest' }))).toBe(false);
    expect(isConcurrentRequestRefusal(500, 'nope')).toBe(false);
  });

  it('requireMethodResult throws JMAPMethodError on the error envelope', () => {
    const res = { methodResponses: [['error', { type: 'forbidden', description: 'no' }, '0']] as Array<[string, Record<string, any>, string]> };
    expect(() => requireMethodResult(res, '0')).toThrow(JMAPMethodError);
    expect(() => requireMethodResult(res)).toThrow('no');
    const ok = { methodResponses: [['Mailbox/get', { list: [1] }, 'a']] as Array<[string, Record<string, any>, string]> };
    expect(requireMethodResult(ok, 'a', 'Mailbox/get')).toEqual({ list: [1] });
    expect(() => requireMethodResult(ok, 'a', 'Email/get')).toThrow('Expected Email/get');
    expect(() => requireMethodResult(ok, 'zz')).toThrow('Missing JMAP response');
  });

  it('assertSetResult throws for notUpdated / notDestroyed / notCreated', () => {
    expect(() => assertSetResult({ updated: { a: null } }, ['a'])).not.toThrow();
    expect(() => assertSetResult({ notUpdated: { a: { type: 'forbidden' } } }, ['a'])).toThrow('update');
    expect(() => assertSetResult({ notUpdated: { b: { type: 'forbidden' } } }, ['a'])).not.toThrow();
    expect(() => assertSetResult({ notDestroyed: { a: { type: 'notFound', description: 'gone' } } })).toThrow('gone');
    expect(() => assertSetResult({ notCreated: { x: { type: 'invalidProperties', properties: ['uid'] } } }, undefined, 'contact')).toThrow('properties=[uid]');
  });

  it('batched splits lists', () => {
    expect(batched([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(batched([], 2)).toEqual([]);
  });
});

describe('FirstTouchGate', () => {
  it('serialises the first calendar/contacts request per account', async () => {
    const gate = new FirstTouchGate();
    const order: string[] = [];
    let release!: () => void;
    const first = gate.run([['Calendar/get', { accountId: 'a' }, '0']], () => new Promise<string>((resolve) => {
      release = () => { order.push('first'); resolve('first'); };
    }));
    const second = gate.run([['CalendarEvent/query', { accountId: 'a' }, '0']], async () => { order.push('second'); return 'second'; });
    const other = gate.run([['Mailbox/get', { accountId: 'a' }, '0']], async () => { order.push('mail'); return 'mail'; });
    await other;
    expect(order).toEqual(['mail']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['mail', 'first', 'second']);
    expect(gateKeysFor([['AddressBook/get', { accountId: 'b' }, '0'], ['Email/get', { accountId: 'b' }, '1']])).toEqual(['contacts:b']);
  });
});

describe('JMAPClient hardening', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockRefresh.mockReset();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves relative session URLs against the login origin', async () => {
    mockFetch([{ status: 200, json: { ...SESSION, apiUrl: '/jmap/', downloadUrl: '/download/{accountId}/{blobId}/{name}?type={type}' } }]);
    const client = new JMAPClient();
    const session = await client.connect('https://mail.example.com', 'user', 'pass');
    expect(session.apiUrl).toBe('https://mail.example.com/jmap/');
    expect(client.getBlobDownloadUrl('b1', 'n')).toBe('https://mail.example.com/download/acc-1/b1/n?type=application%2Foctet-stream');
  });

  it('refetches the final URL when a redirect dropped the Authorization header', async () => {
    const fetch = mockFetch([
      { status: 200, json: { apiUrl: '/jmap/', accounts: {}, primaryAccounts: {} }, redirected: true, url: 'https://mail.example.com/jmap/session' },
      { status: 200, json: SESSION },
    ]);
    const client = new JMAPClient();
    await client.connect('https://mail.example.com', 'user', 'pass');
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toBe('https://mail.example.com/jmap/session');
    expect(client.accountId).toBe('acc-1');
  });

  describe('redirects that drop the Authorization header (B15, webmail #892)', () => {
    // RN's fetch leaves `redirected` false; only `url` shows the redirect.
    const authOf = (call: unknown[]) =>
      ((call[1] as RequestInit | undefined)?.headers as Record<string, string> | undefined)?.Authorization;

    it('refetches the final URL with credentials after a 401 behind an https upgrade', async () => {
      const fetch = mockFetch([
        { status: 401, url: 'https://mail.example.com/jmap/session' },
        { status: 200, json: SESSION },
      ]);
      const client = new JMAPClient();
      await client.connect('http://mail.example.com', 'user', 'pass');
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(fetch.mock.calls[1][0]).toBe('https://mail.example.com/jmap/session');
      expect(authOf(fetch.mock.calls[1])).toMatch(/^Basic /);
      expect(client.accountId).toBe('acc-1');
    });

    it('refetches when the redirect only shows in response.url and the session came back empty', async () => {
      const fetch = mockFetch([
        { status: 404, url: 'https://mail.example.com/jmap/session' },
        { status: 200, json: { apiUrl: '/jmap/', accounts: {}, primaryAccounts: {} }, url: 'https://mail.example.com/jmap/session/' },
        { status: 200, json: SESSION },
      ]);
      const client = new JMAPClient();
      await client.connect('https://mail.example.com', 'user', 'pass');
      expect(fetch.mock.calls.map((c) => c[0])).toEqual([
        'https://mail.example.com/jmap/session',
        'https://mail.example.com/.well-known/jmap',
        'https://mail.example.com/jmap/session/',
      ]);
      expect(client.accountId).toBe('acc-1');
    });

    it('does not treat a canonicalised final URL as a redirect', async () => {
      const fetch = mockFetch([{ status: 401, url: 'https://mail.example.com/jmap/session' }]);
      const client = new JMAPClient();
      const err = await client.connect('https://Mail.Example.com:443', 'user', 'bad').catch((e) => e);
      expect(err).toBeInstanceOf(AuthenticationError);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('still reports bad credentials when the direct refetch is rejected too', async () => {
      mockFetch([
        { status: 401, url: 'https://mail.example.com/jmap/session' },
        { status: 401, url: 'https://mail.example.com/jmap/session' },
      ]);
      const client = new JMAPClient();
      const err = await client.connect('http://mail.example.com', 'user', 'bad').catch((e) => e);
      expect(err).toBeInstanceOf(AuthenticationError);
    });

    it('keeps credentials off another host and fails without an auth error', async () => {
      const fetch = mockFetch([{ status: 401, url: 'https://sso.example.net/jmap/session' }]);
      const client = new JMAPClient();
      const err = await client.connect('https://mail.example.com', 'user', 'pass').catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(AuthenticationError);
      expect(String(err.message)).toContain('redirected to https://sso.example.net');
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('surfaces a redirect it cannot follow as NetworkError on restore, so the account is kept', async () => {
      const SecureStore = await import('expo-secure-store');
      (SecureStore.getItemAsync as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        JSON.stringify({ serverUrl: 'https://mail.example.com', username: 'user', password: 'pass' }),
      );
      mockFetch([{ status: 200, json: { apiUrl: '/jmap/', accounts: {}, primaryAccounts: {} }, url: 'https://sso.example.net/session' }]);
      const client = new JMAPClient();
      const err = await client.loadAccount('user@mail.example.com').catch((e) => e);
      expect(err).toBeInstanceOf(NetworkError);
    });
  });

  it('throws TotpRequiredError on a 402 MFA challenge', async () => {
    mockFetch([{ status: 402, json: { title: 'MFA code required' } }]);
    const client = new JMAPClient();
    const err = await client.connect('https://mail.example.com', 'user', 'pass').catch((e) => e);
    expect(err).toBeInstanceOf(TotpRequiredError);
    expect(err).toBeInstanceOf(AuthenticationError);
  });

  it('times out a stalled request with RequestTimeoutError and does not retry it', async () => {
    vi.useFakeTimers();
    const client = await connected();
    const fetch = mockFetch([{ status: 200, json: { methodResponses: [] }, delayMs: 60_000 }]);
    const p = client.request([['EmailSubmission/set', { accountId: 'acc-1' }, '0']]);
    const settled = p.catch((e) => e);
    await vi.advanceTimersByTimeAsync(31_000);
    const err = await settled;
    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('retries an idempotent request once after a transient network error', async () => {
    vi.useFakeTimers();
    const client = await connected();
    const fetch = mockFetch([
      { status: 200, throw: new TypeError('Network request failed') },
      { status: 200, json: { methodResponses: [['Mailbox/get', { list: [] }, '0']] } },
    ]);
    const p = client.request([['Mailbox/get', { accountId: 'acc-1' }, '0']]);
    await vi.advanceTimersByTimeAsync(1100);
    const res = await p;
    expect(res.methodResponses[0][0]).toBe('Mailbox/get');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a submission after a network error and wraps it as NetworkError', async () => {
    const client = await connected();
    const fetch = mockFetch([{ status: 200, throw: new TypeError('Network request failed') }]);
    const err = await client.request([['EmailSubmission/set', { accountId: 'acc-1' }, '0']]).catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('replays a maxConcurrentRequests refusal with back-off', async () => {
    vi.useFakeTimers();
    const client = await connected();
    const refusal = { type: 'urn:ietf:params:jmap:error:limit', limit: 'maxConcurrentRequests' };
    const fetch = mockFetch([
      { status: 400, json: refusal },
      { status: 400, json: refusal },
      { status: 200, json: { methodResponses: [['Email/set', { updated: {} }, '0']] } },
    ]);
    const p = client.request([['Email/set', { accountId: 'acc-1' }, '0']]);
    await vi.advanceTimersByTimeAsync(3000);
    await p;
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('surfaces the response body on a failed request and guards JSON parsing', async () => {
    const client = await connected();
    mockFetch([{ status: 500, text: 'boom happened' }]);
    await expect(client.request([['Mailbox/get', {}, '0']])).rejects.toThrow('JMAP request failed: 500 - boom happened');
    mockFetch([{ status: 200, text: '<html>not json' }]);
    await expect(client.request([['Mailbox/get', {}, '0']])).rejects.toThrow('Invalid JSON');
  });

  it('enters a rate-limit window on 429 (HTTP-date) and short-circuits until it ends', async () => {
    const client = await connected();
    const onRateLimit = vi.fn();
    client.onRateLimit(onRateLimit);
    const fetch = mockFetch([{ status: 429, headers: { 'Retry-After': new Date(Date.now() + 20_000).toUTCString() } }]);
    const err = await client.request([['Mailbox/get', {}, '0']]).catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(Number.isFinite((err as RateLimitError).retryAfterMs)).toBe(true);
    expect((err as RateLimitError).retryAfterMs).toBeGreaterThan(10_000);
    expect(onRateLimit).toHaveBeenCalledTimes(1);
    expect(client.isRateLimited()).toBe(true);
    const err2 = await client.request([['Mailbox/get', {}, '0']]).catch((e) => e);
    expect(err2).toBeInstanceOf(RateLimitError);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('notifies auth-failure listeners on a 401 during a request', async () => {
    const client = await connected();
    const onAuthFailure = vi.fn();
    client.onAuthFailure(onAuthFailure);
    mockFetch([{ status: 401 }]);
    await expect(client.request([['Mailbox/get', {}, '0']])).rejects.toThrow(AuthenticationError);
    expect(onAuthFailure).toHaveBeenCalledTimes(1);
  });

  it('keeps the account when the token endpoint is transiently down', async () => {
    const client = new JMAPClient();
    mockFetch([{ status: 200, json: SESSION }]);
    await client.connectWithOAuth('https://mail.example.com', {
      accessToken: 'old',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      tokenEndpoint: 'https://mail.example.com/auth/token',
      clientId: 'c',
    });
    mockRefresh.mockRejectedValue(new TransientRefreshError('503'));
    mockFetch([{ status: 401 }]);
    const err = await client.request([['Mailbox/get', {}, '0']]).catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(err).not.toBeInstanceOf(AuthenticationError);
  });

  it('fires token-refresh listeners and retries with the new bearer after a 401', async () => {
    const client = new JMAPClient();
    mockFetch([{ status: 200, json: SESSION }]);
    await client.connectWithOAuth('https://mail.example.com', {
      accessToken: 'old',
      refreshToken: 'r',
      expiresAt: Date.now() + 3_600_000,
      tokenEndpoint: 'https://mail.example.com/auth/token',
      clientId: 'c',
    });
    const onRefresh = vi.fn();
    client.onTokenRefresh(onRefresh);
    mockRefresh.mockResolvedValue({
      accessToken: 'new',
      refreshToken: 'r2',
      expiresAt: Date.now() + 3_600_000,
      tokenEndpoint: 'https://mail.example.com/auth/token',
      clientId: 'c',
    });
    const fetch = mockFetch([
      { status: 401 },
      { status: 200, json: { methodResponses: [['Mailbox/get', {}, '0']] } },
    ]);
    await client.request([['Mailbox/get', {}, '0']]);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect((fetch.mock.calls[1][1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer new' });
    expect(client.authHeader).toBe('Bearer new');
  });

  it('updatePassword rewrites the stored credential', async () => {
    const SecureStore = await import('expo-secure-store');
    const client = await connected();
    (SecureStore.setItemAsync as ReturnType<typeof vi.fn>).mockClear();
    await client.updatePassword('new-pass');
    expect(client.authHeader).toBe(`Basic ${btoa('user:new-pass')}`);
    expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
    const saved = JSON.parse((SecureStore.setItemAsync as ReturnType<typeof vi.fn>).mock.calls[0][1] as string);
    expect(saved.password).toBe('new-pass');
  });

  it('exposes account-level capabilities and set/upload limits', async () => {
    const client = await connected();
    expect(client.hasAccountCapability('urn:stalwart:jmap')).toBe(true);
    expect(client.hasCapability('urn:stalwart:jmap')).toBe(false);
    expect(client.getMaxObjectsInSet()).toBe(50);
    expect(client.getMaxSizeUpload()).toBe(1024);
  });

  it('snapshot/restoreSnapshot round-trips the live connection', async () => {
    const client = await connected();
    const snap = client.snapshot();
    client.reset();
    expect(client.isConnected).toBe(false);
    client.restoreSnapshot(snap);
    expect(client.isConnected).toBe(true);
    expect(client.accountId).toBe('acc-1');
  });
});
