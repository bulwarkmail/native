import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('expo-secure-store', () => ({
  setItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

import { JMAPClient, NetworkError, RateLimitError, RequestTimeoutError } from '../jmap-client';
import { setServerReachabilitySink, observeServerFetch } from '../../lib/server-reachability';
import type { JMAPSession } from '../types';

// Every round trip to the mail server tells the network store whether the
// server answered, so a LAN server counts as online when the internet probe
// fails (see stores/network-store).

const SESSION: JMAPSession = {
  apiUrl: 'https://mail.example.com/jmap/',
  downloadUrl: 'https://mail.example.com/download/{accountId}/{blobId}/{name}?type={type}',
  uploadUrl: 'https://mail.example.com/upload/{accountId}/',
  eventSourceUrl: 'https://mail.example.com/eventsource/',
  primaryAccounts: { 'urn:ietf:params:jmap:mail': 'acc-1' },
  accounts: { 'acc-1': { name: 'user@example.com', isPersonal: true, isReadOnly: false, accountCapabilities: {} } },
  capabilities: { 'urn:ietf:params:jmap:core': {}, 'urn:ietf:params:jmap:mail': {} },
  state: 's1',
  username: 'user@example.com',
};

type Resp = { status: number; json?: unknown; throw?: Error; delayMs?: number; headers?: Record<string, string> };

function mockFetch(responses: Resp[]) {
  let i = 0;
  const fn = vi.fn(async (_url: string, init?: RequestInit) => {
    const resp = responses[i++] ?? responses[responses.length - 1];
    if (resp.throw) throw resp.throw;
    if (resp.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          const e = new Error('Aborted');
          e.name = 'AbortError';
          reject(e);
        };
        // fetch rejects at once on a signal that is already aborted.
        if (init?.signal?.aborted) return abort();
        const t = setTimeout(resolve, resp.delayMs);
        init?.signal?.addEventListener('abort', () => {
          clearTimeout(t);
          abort();
        });
      });
    }
    const text = resp.json === undefined ? '' : JSON.stringify(resp.json);
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      statusText: 'x',
      redirected: false,
      url: '',
      headers: { get: (n: string) => resp.headers?.[n] ?? null },
      json: async () => JSON.parse(text),
      text: async () => text,
      arrayBuffer: async () => new ArrayBuffer(0),
    };
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const sink = { response: vi.fn(), unreachable: vi.fn() };

async function connected(): Promise<JMAPClient> {
  mockFetch([{ status: 200, json: SESSION }]);
  const client = new JMAPClient({ reportsReachability: true });
  await client.connect('https://mail.example.com', 'user', 'pass');
  sink.response.mockClear();
  sink.unreachable.mockClear();
  return client;
}

beforeEach(() => {
  vi.restoreAllMocks();
  sink.response.mockReset();
  sink.unreachable.mockReset();
  setServerReachabilitySink(sink);
});
afterEach(() => {
  setServerReachabilitySink(null);
  vi.useRealTimers();
});

describe('jmapClient reports whether the mail server answered', () => {
  it('reports a response for a session fetch', async () => {
    mockFetch([{ status: 200, json: SESSION }]);
    await new JMAPClient({ reportsReachability: true }).connect('https://mail.example.com', 'user', 'pass');
    expect(sink.response).toHaveBeenCalled();
    expect(sink.unreachable).not.toHaveBeenCalled();
  });

  it('a detached client (another account) reports nothing', async () => {
    mockFetch([{ status: 200, json: SESSION }]);
    const detached = new JMAPClient();
    await detached.connect('https://mail.example.com', 'user', 'pass');
    mockFetch([{ status: 200, throw: new TypeError('Network request failed') }]);
    await expect(detached.request([['EmailSubmission/set', { accountId: 'acc-1' }, '0']])).rejects.toBeInstanceOf(NetworkError);
    expect(sink.response).not.toHaveBeenCalled();
    expect(sink.unreachable).not.toHaveBeenCalled();
  });

  it('the app singleton reports', async () => {
    const { jmapClient } = await import('../jmap-client');
    expect((jmapClient as unknown as { reportsReachability: boolean }).reportsReachability).toBe(true);
  });

  it('reports a response for an API request', async () => {
    const client = await connected();
    mockFetch([{ status: 200, json: { methodResponses: [] } }]);
    await client.request([['Mailbox/get', { accountId: 'acc-1' }, '0']]);
    expect(sink.response).toHaveBeenCalledTimes(1);
    expect(sink.unreachable).not.toHaveBeenCalled();
  });

  it('counts an HTTP error status as the server answering', async () => {
    const client = await connected();
    mockFetch([{ status: 500, json: { detail: 'boom' } }]);
    await expect(client.request([['Mailbox/get', { accountId: 'acc-1' }, '0']])).rejects.toThrow(/500/);
    expect(sink.response).toHaveBeenCalled();
    expect(sink.unreachable).not.toHaveBeenCalled();
  });

  it('counts a 429 as the server answering', async () => {
    const client = await connected();
    mockFetch([{ status: 429, headers: { 'Retry-After': '1' } }]);
    await expect(client.request([['Mailbox/get', { accountId: 'acc-1' }, '0']])).rejects.toBeInstanceOf(RateLimitError);
    expect(sink.response).toHaveBeenCalled();
  });

  it('reports unreachable for a transport failure', async () => {
    const client = await connected();
    mockFetch([{ status: 200, throw: new TypeError('Network request failed') }]);
    const err = await client.request([['EmailSubmission/set', { accountId: 'acc-1' }, '0']]).catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect(sink.unreachable).toHaveBeenCalled();
    expect(sink.response).not.toHaveBeenCalled();
  });

  it('reports unreachable for a timeout', async () => {
    vi.useFakeTimers();
    const client = await connected();
    mockFetch([{ status: 200, json: { methodResponses: [] }, delayMs: 60_000 }]);
    const settled = client.request([['EmailSubmission/set', { accountId: 'acc-1' }, '0']]).catch((e) => e);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(await settled).toBeInstanceOf(RequestTimeoutError);
    expect(sink.unreachable).toHaveBeenCalled();
    expect(sink.response).not.toHaveBeenCalled();
  });

  it('reports the retry\'s response after one transient failure', async () => {
    vi.useFakeTimers();
    const client = await connected();
    mockFetch([
      { status: 200, throw: new TypeError('Network request failed') },
      { status: 200, json: { methodResponses: [] } },
    ]);
    const p = client.request([['Mailbox/get', { accountId: 'acc-1' }, '0']]);
    await vi.advanceTimersByTimeAsync(1100);
    await p;
    const lastResponse = Math.max(...sink.response.mock.invocationCallOrder);
    const lastUnreachable = Math.max(...sink.unreachable.mock.invocationCallOrder);
    expect(lastResponse).toBeGreaterThan(lastUnreachable);
  });

  it('reports a blob download response', async () => {
    const client = await connected();
    mockFetch([{ status: 200 }]);
    await client.fetchBlobArrayBuffer('b1');
    expect(sink.response).toHaveBeenCalledTimes(1);
  });

  it('says nothing when the caller aborts', async () => {
    const client = await connected();
    mockFetch([{ status: 200, delayMs: 60_000 }]);
    const controller = new AbortController();
    const p = client.authenticatedFetch('https://mail.example.com/upload/acc-1/', { method: 'POST', signal: controller.signal }, { idempotent: false });
    controller.abort();
    await expect(p).rejects.toBeInstanceOf(NetworkError);
    expect(sink.unreachable).not.toHaveBeenCalled();
    expect(sink.response).not.toHaveBeenCalled();
  });
});

describe('observeServerFetch', () => {
  it('reports a response and passes it through', async () => {
    await expect(observeServerFetch(Promise.resolve('r'))).resolves.toBe('r');
    expect(sink.response).toHaveBeenCalledTimes(1);
  });

  it('reports unreachable for a fetch TypeError and rethrows it', async () => {
    const err = new TypeError('secureFetch failed: timeout');
    await expect(observeServerFetch(Promise.reject(err))).rejects.toBe(err);
    expect(sink.unreachable).toHaveBeenCalledTimes(1);
  });

  it('says nothing for another error or a caller abort', async () => {
    await expect(observeServerFetch(Promise.reject(new Error('bad body')))).rejects.toThrow('bad body');
    const controller = new AbortController();
    controller.abort();
    await expect(observeServerFetch(Promise.reject(new TypeError('Network request failed')), controller.signal)).rejects.toThrow();
    expect(sink.unreachable).not.toHaveBeenCalled();
    expect(sink.response).not.toHaveBeenCalled();
  });
});
