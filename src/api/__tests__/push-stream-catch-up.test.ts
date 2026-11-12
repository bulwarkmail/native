import { createRequire } from 'node:module';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// A reopened event stream does not replay what it missed, so every
// (re)connect runs one state check (webmail #1553).

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

const nodeRequire = createRequire(import.meta.url);
const ssePath = nodeRequire.resolve('react-native-sse');
nodeRequire.cache[ssePath] = { id: ssePath, filename: ssePath, loaded: true, exports: { default: FakeEventSource } } as NodeJS.Module;

// Server states the fake answers `<type>/get` with, `<accountId>:<type>`.
const serverStates: Record<string, string> = {};
let requestGate: Promise<void> | null = null;
const requests: Array<{ calls: unknown[]; using: string[] }> = [];

const MAIL = 'urn:ietf:params:jmap:mail';
const CONTACTS = 'urn:ietf:params:jmap:contacts';
const CALENDARS = 'urn:ietf:params:jmap:calendars';

vi.mock('../../lib/client-cert', () => ({ getClientCertAlias: vi.fn(async () => null) }));
vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'a',
    currentSession: {
      eventSourceUrl: 'https://mail.example.com/eventsource/?types={types}&closeafter={closeafter}&ping={ping}',
      capabilities: {
        'urn:ietf:params:jmap:core': {},
        'urn:ietf:params:jmap:mail': {},
        'urn:ietf:params:jmap:contacts': {},
        'urn:ietf:params:jmap:calendars': {},
      },
      accounts: {
        a: { name: 'a', isPersonal: true, isReadOnly: false, accountCapabilities: { 'urn:ietf:params:jmap:mail': {}, 'urn:ietf:params:jmap:contacts': {}, 'urn:ietf:params:jmap:calendars': {} } },
        // A shared mailbox without contacts or calendars.
        s: { name: 's', isPersonal: false, isReadOnly: false, accountCapabilities: { 'urn:ietf:params:jmap:mail': {} } },
      },
    },
    authHeader: 'Basic dXNlcjpwYXNz',
    ensureFreshToken: vi.fn(async () => undefined),
    onTokenRefresh: vi.fn(() => () => undefined),
    isRateLimited: vi.fn(() => false),
    getMaxCallsInRequest: vi.fn(() => 16),
    request: vi.fn(async (calls: Array<[string, { accountId: string }, string]>, using: string[]) => {
      requests.push({ calls, using });
      if (requestGate) await requestGate;
      return {
        methodResponses: calls.map(([method, args, id]) => {
          const state = serverStates[`${args.accountId}:${method.replace('/get', '')}`];
          return [method, { accountId: args.accountId, state, list: [], notFound: [] }, id];
        }),
      };
    }),
  },
  AuthenticationError: class AuthenticationError extends Error {},
}));

import { createStateBaseline, startLiveUpdates } from '../push-stream';
import type { StateChange } from '../types';

function setServer(states: Record<string, string>) {
  for (const key of Object.keys(serverStates)) delete serverStates[key];
  Object.assign(serverStates, states);
}

const initial = {
  'a:Mailbox': 'm1', 'a:Email': 'e1', 'a:Thread': 't1',
  'a:Calendar': 'c1', 'a:CalendarEvent': 'ce1',
  'a:AddressBook': 'ab1', 'a:ContactCard': 'cc1',
  's:Mailbox': 'sm1', 's:Email': 'se1', 's:Thread': 'st1',
};

function stateEvent(changed: StateChange['changed']) {
  return { data: JSON.stringify({ '@type': 'StateChange', changed }) };
}

beforeEach(() => {
  sources.length = 0;
  requests.length = 0;
  requestGate = null;
  setServer(initial);
  vi.useFakeTimers();
});
afterEach(() => { vi.useRealTimers(); });

describe('catch-up after a reconnect', () => {
  it('only primes on the first connection, then reports what changed while the stream was down', async () => {
    const seen: StateChange[] = [];
    const handle = await startLiveUpdates({ onStateChange: (c) => seen.push(c) });
    sources[0].emit('open');
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(1);
    expect(seen).toEqual([]);

    // The socket drops; a contact and a mail in the shared account change.
    sources[0].emit('error', { xhrStatus: 0 });
    setServer({ ...initial, 'a:ContactCard': 'cc2', 's:Email': 'se2' });
    await vi.advanceTimersByTimeAsync(5_000);
    sources[1].emit('open');
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toEqual([{ '@type': 'StateChange', changed: { a: { ContactCard: 'cc2' }, s: { Email: 'se2' } } }]);
    handle.close();
  });

  it('asks only for the types each account supports, in one request', async () => {
    const handle = await startLiveUpdates({ onStateChange: () => undefined });
    sources[0].emit('open');
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(1);
    const methods = (requests[0].calls as Array<[string, { accountId: string }]>).map(([m, a]) => `${a.accountId}:${m}`);
    expect(methods.sort()).toEqual([
      'a:AddressBook/get', 'a:Calendar/get', 'a:CalendarEvent/get', 'a:ContactCard/get',
      'a:Email/get', 'a:Mailbox/get', 'a:Thread/get',
      's:Email/get', 's:Mailbox/get', 's:Thread/get',
    ]);
    expect(requests[0].using).toEqual(expect.arrayContaining([MAIL, CONTACTS, CALENDARS]));
    handle.close();
  });

  it('skips a stream event whose state the catch-up already reported, and the other way round', async () => {
    const seen: StateChange[] = [];
    const handle = await startLiveUpdates({ onStateChange: (c) => seen.push(c) });
    sources[0].emit('open');
    await vi.advanceTimersByTimeAsync(0);

    // A stream event reports e2; a reconnect's check then finds e2 too.
    sources[0].emit('state', stateEvent({ a: { Email: 'e2' } }));
    setServer({ ...initial, 'a:Email': 'e2', 'a:Mailbox': 'm2' });
    handle.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    sources[1].emit('open');
    await vi.advanceTimersByTimeAsync(0);
    // The check reports m2 (the catch-up), and the late event repeating it is dropped.
    sources[1].emit('state', stateEvent({ a: { Mailbox: 'm2', Email: 'e2' } }));
    sources[1].emit('state', stateEvent({ a: { Email: 'e3' } }));

    expect(seen).toEqual([
      { '@type': 'StateChange', changed: { a: { Email: 'e2' } } },
      { '@type': 'StateChange', changed: { a: { Mailbox: 'm2' } } },
      { '@type': 'StateChange', changed: { a: { Email: 'e3' } } },
    ]);
    handle.close();
  });

  it('still reports a stream event whose state the first, silent check already read', async () => {
    const seen: StateChange[] = [];
    setServer({ ...initial, 'a:Email': 'e2' });
    const handle = await startLiveUpdates({ onStateChange: (c) => seen.push(c) });
    sources[0].emit('open');
    await vi.advanceTimersByTimeAsync(0);
    sources[0].emit('state', stateEvent({ a: { Email: 'e2' } }));
    expect(seen).toEqual([{ '@type': 'StateChange', changed: { a: { Email: 'e2' } } }]);
    handle.close();
  });

  it('keeps a state a stream event set while the check was out', async () => {
    const seen: StateChange[] = [];
    const handle = await startLiveUpdates({ onStateChange: (c) => seen.push(c) });
    sources[0].emit('open');
    await vi.advanceTimersByTimeAsync(0);

    let release!: () => void;
    requestGate = new Promise((r) => { release = r; });
    setServer({ ...initial, 'a:Email': 'e2' });
    handle.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    sources[1].emit('open');
    // The event is newer than what the check will return.
    sources[1].emit('state', stateEvent({ a: { Email: 'e3' } }));
    release();
    await vi.advanceTimersByTimeAsync(0);
    // The check doesn't report the older e2 nor overwrite e3.
    sources[1].emit('state', stateEvent({ a: { Email: 'e3' } }));
    expect(seen).toEqual([{ '@type': 'StateChange', changed: { a: { Email: 'e3' } } }]);
    handle.close();
  });

  it('carries a baseline over a closed session and drops the closed session\'s check', async () => {
    const baseline = createStateBaseline();
    const first: StateChange[] = [];
    const h1 = await startLiveUpdates({ onStateChange: (c) => first.push(c), baseline });
    sources[0].emit('open');
    await vi.advanceTimersByTimeAsync(0);

    // A second check is still out when the app goes to the background.
    let release!: () => void;
    requestGate = new Promise((r) => { release = r; });
    setServer({ ...initial, 'a:CalendarEvent': 'ce2' });
    h1.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    sources[1].emit('open');
    await vi.advanceTimersByTimeAsync(0);
    h1.close();
    release();
    requestGate = null;
    await vi.advanceTimersByTimeAsync(0);
    expect(first).toEqual([]);

    // Resume: the new session reports the change from the old baseline.
    const second: StateChange[] = [];
    const h2 = await startLiveUpdates({ onStateChange: (c) => second.push(c), baseline });
    sources[2].emit('open');
    await vi.advanceTimersByTimeAsync(0);
    expect(second).toEqual([{ '@type': 'StateChange', changed: { a: { CalendarEvent: 'ce2' } } }]);
    h2.close();
  });

  it('keeps the baseline over a refused (rate-limited) stream', async () => {
    const seen: StateChange[] = [];
    const handle = await startLiveUpdates({ onStateChange: (c) => seen.push(c) });
    sources[0].emit('open');
    await vi.advanceTimersByTimeAsync(0);
    sources[0].emit('error', { xhrStatus: 429 });
    setServer({ ...initial, 'a:AddressBook': 'ab2' });
    await vi.advanceTimersByTimeAsync(10_000);
    sources[1].emit('open');
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([{ '@type': 'StateChange', changed: { a: { AddressBook: 'ab2' } } }]);
    handle.close();
  });

  it('checks once more after a reconnect that came while a check was out', async () => {
    const { jmapClient } = await import('../jmap-client');
    const seen: StateChange[] = [];
    const handle = await startLiveUpdates({ onStateChange: (c) => seen.push(c) });
    sources[0].emit('open');
    await vi.advanceTimersByTimeAsync(0);

    // A check reads the states, and its answer is slow to come back.
    let release!: () => void;
    const slow = new Promise<void>((r) => { release = r; });
    vi.mocked(jmapClient.request).mockImplementationOnce(async (calls: Array<[string, { accountId: string }, string]>) => {
      requests.push({ calls, using: [] });
      const methodResponses = calls.map(([method, args, id]) => {
        const state = serverStates[`${args.accountId}:${method.replace('/get', '')}`];
        return [method, { accountId: args.accountId, state, list: [], notFound: [] }, id] as [string, Record<string, unknown>, string];
      });
      await slow;
      return { methodResponses } as never;
    });
    handle.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    sources[1].emit('open');
    await vi.advanceTimersByTimeAsync(0);
    expect(requests).toHaveLength(2);

    // A mail arrives after those reads; the stream drops and reopens
    // before the check is back, and doesn't replay the change.
    setServer({ ...initial, 'a:Email': 'e2' });
    handle.reconnect();
    await vi.advanceTimersByTimeAsync(0);
    sources[2].emit('open');
    sources[2].emit('open');
    release();
    await vi.advanceTimersByTimeAsync(0);

    expect(seen).toEqual([{ '@type': 'StateChange', changed: { a: { Email: 'e2' } } }]);
    // One check more for the reopen, however many came meanwhile.
    expect(requests).toHaveLength(3);
    handle.close();
  });

  it('splits the check at the server\'s maxCallsInRequest', async () => {
    const { jmapClient } = await import('../jmap-client');
    vi.mocked(jmapClient.getMaxCallsInRequest).mockReturnValueOnce(4);
    const handle = await startLiveUpdates({ onStateChange: () => undefined });
    sources[0].emit('open');
    await vi.advanceTimersByTimeAsync(0);
    expect(requests.map((r) => r.calls.length)).toEqual([4, 4, 2]);
    handle.close();
  });
});
