import { createRequire } from 'node:module';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The keep-alive echo is only sent while the event stream is not healthy
// (PF6), so the stream has to say when it is.

type Handler = (event: { xhrStatus?: number; data?: string }) => void;
const sources: FakeEventSource[] = [];
class FakeEventSource {
  handlers = new Map<string, Handler[]>();
  closed = false;
  constructor() { sources.push(this); }
  addEventListener(type: string, handler: Handler) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
  }
  removeEventListener(type: string, handler: Handler) {
    this.handlers.set(type, (this.handlers.get(type) ?? []).filter((h) => h !== handler));
  }
  close() { this.closed = true; }
  emit(type: string, event: { xhrStatus?: number; data?: string } = {}) {
    for (const h of this.handlers.get(type) ?? []) h(event);
  }
}

// push-stream loads the library with require(), which vi.mock does not
// reach: seed Node's module cache instead.
const nodeRequire = createRequire(import.meta.url);
const ssePath = nodeRequire.resolve('react-native-sse');
nodeRequire.cache[ssePath] = { id: ssePath, filename: ssePath, loaded: true, exports: { default: FakeEventSource } } as NodeJS.Module;
vi.mock('../../lib/client-cert', () => ({ getClientCertAlias: vi.fn(async () => null) }));
vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    currentSession: { eventSourceUrl: 'https://mail.example.com/eventsource/?types={types}&closeafter={closeafter}&ping={ping}' },
    authHeader: 'Basic dXNlcjpwYXNz',
    ensureFreshToken: vi.fn(async () => undefined),
    onTokenRefresh: vi.fn(() => () => undefined),
    request: vi.fn(),
  },
  AuthenticationError: class AuthenticationError extends Error {},
}));

import { startLiveUpdates } from '../push-stream';

beforeEach(() => {
  sources.length = 0;
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

describe('live updates health', () => {
  it('is healthy only while the stream is open and pinging', async () => {
    const handle = await startLiveUpdates({ onStateChange: () => undefined });
    expect(handle.mode).toBe('sse');
    expect(handle.healthy).toBe(false);

    sources[0].emit('open');
    expect(handle.healthy).toBe(true);
    sources[0].emit('ping');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(handle.healthy).toBe(true);

    // Three missed pings: the watchdog drops the stream.
    await vi.advanceTimersByTimeAsync(90_000);
    expect(handle.healthy).toBe(false);
    handle.close();
  });

  it('is not healthy after a network error or once closed', async () => {
    const handle = await startLiveUpdates({ onStateChange: () => undefined });
    sources[0].emit('open');
    sources[0].emit('error', { xhrStatus: 0 });
    expect(handle.healthy).toBe(false);

    // First retry after a dropped socket: 5 s.
    await vi.advanceTimersByTimeAsync(5_000);
    sources[1].emit('open');
    expect(handle.healthy).toBe(true);
    handle.close();
    expect(handle.healthy).toBe(false);
  });
});
