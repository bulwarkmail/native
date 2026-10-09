import { describe, it, expect, vi, beforeEach } from 'vitest';

// The calendar loads (calendars, the visible window, tasks) outlive an
// account switch. Stalwart numbers ids per account, so a load started in A
// that lands after the switch would put A's event "9" or task "7" in B's
// store, where a Delete or a tick acts on B's own "9" or "7". A load is bound
// to the account and connection it started on, and dropped once either is
// gone.

vi.mock('../../api/calendar', () => ({
  getCalendars: vi.fn(),
  queryEvents: vi.fn(),
  getEvents: vi.fn(),
  scanCalendarObjects: vi.fn(async () => []),
  isCalendarAccessDenied: vi.fn(() => false),
  noteCalendarAccessError: vi.fn(() => false),
  resetCalendarAccessDenied: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvents: vi.fn(),
  batchCreateEvents: vi.fn(),
  setDefaultCalendar: vi.fn(),
  createCalendar: vi.fn(),
  updateCalendar: vi.fn(),
  deleteCalendar: vi.fn(),
  setCalendarShare: vi.fn(),
  clearCalendarEvents: vi.fn(),
  rsvpEvent: vi.fn(),
  supportsSyntheticCalendarIds: vi.fn(async () => false),
  queryExpandedEvents: vi.fn(),
  hydrateExpandedOccurrences: vi.fn(async (events: unknown[]) => events),
  resetSyntheticIdSupport: vi.fn(),
  getParticipantIdentities: vi.fn(async () => []),
  setDefaultParticipantIdentity: vi.fn(),
}));

vi.mock('../../api/email', () => ({}));
vi.mock('../locale-store', () => ({
  t: (_key: string, fallback?: string) => fallback ?? _key,
  useLocaleStore: { getState: () => ({ locale: 'en', t: (_k: string, f?: string) => f ?? _k }) },
}));
vi.mock('../outbox-store', () => ({
  useOutboxStore: { getState: () => ({ entries: [], count: () => 0, setAccount: vi.fn(), flush: vi.fn() }) },
}));
vi.mock('../settings-store', () => ({ useSettingsStore: { getState: () => ({}) } }));
vi.mock('../offline-cache-store', () => ({ useOfflineCacheStore: { getState: () => ({}) } }));
vi.mock('../toast-store', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    isConnected: true,
    accountId: 'c',
    connectionGen: 7,
    username: 'alice@a.example',
    serverUrl: 'https://a.example',
    getMaxObjectsInGet: () => 500,
    request: vi.fn(),
  },
}));

import * as calendarApi from '../../api/calendar';
import { jmapClient } from '../../api/jmap-client';
import { useCalendarStore } from '../calendar-store';
import { useEmailStore } from '../email-store';
import { useAccountStore } from '../account-store';
import { generateAccountId } from '../../lib/account-utils';

// jmapClient's StaleLoadError, as isStaleLoad recognises it (the client is mocked).
class StaleLoadError extends Error {
  constructor() { super('stale'); this.name = 'StaleLoadError'; }
}

const mockGetCalendars = calendarApi.getCalendars as ReturnType<typeof vi.fn>;
const mockQuery = calendarApi.queryEvents as ReturnType<typeof vi.fn>;
const mockGetEvents = calendarApi.getEvents as ReturnType<typeof vi.fn>;
const mockScan = calendarApi.scanCalendarObjects as ReturnType<typeof vi.fn>;
const mockDelete = calendarApi.deleteEvents as ReturnType<typeof vi.fn>;
const mockUpdate = calendarApi.updateEvent as ReturnType<typeof vi.fn>;
const mockIdentities = calendarApi.getParticipantIdentities as ReturnType<typeof vi.fn>;

const client = jmapClient as unknown as {
  username: string; serverUrl: string; connectionGen: number; accountId: string;
};
const A = generateAccountId('alice@a.example', 'https://a.example');
const B = generateAccountId('bob@b.example', 'https://b.example');
const entry = (id: string, username: string, serverUrl: string) => ({
  id, serverUrl, username, displayName: username, email: username, avatarColor: '#000000',
  lastLoginAt: 0, isConnected: true, hasError: false, isDefault: id === A,
});

/** The app shows A and the client serves A (connection 7), JMAP account "c". */
function showA(): void {
  client.username = 'alice@a.example';
  client.serverUrl = 'https://a.example';
  client.connectionGen = 7;
  client.accountId = 'c';
  useAccountStore.setState({
    accounts: [entry(A, 'alice@a.example', 'https://a.example'), entry(B, 'bob@b.example', 'https://b.example')],
    activeAccountId: A,
  });
  useEmailStore.setState({ activeAccountId: A });
}

/** A full switch: the store resets, B is shown and served (connection 8, also JMAP account "c"). */
function switchToB(): void {
  useCalendarStore.getState().reset();
  useAccountStore.setState({ activeAccountId: B });
  useEmailStore.setState({ activeAccountId: B });
  client.username = 'bob@b.example';
  client.serverUrl = 'https://b.example';
  client.connectionGen = 8;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const cal = { id: 'cal-1', name: 'Personal' } as never;
const AFTER = '2026-10-01T00:00:00.000Z';
const BEFORE = '2026-11-01T00:00:00.000Z';
const ev = (id: string, title: string) => ({
  id, uid: `${title}-${id}`, title, start: '2026-10-10T10:00:00', duration: 'PT1H', calendarIds: { 'cal-1': true },
});

beforeEach(() => {
  vi.clearAllMocks();
  mockScan.mockResolvedValue([]);
  mockIdentities.mockResolvedValue([]);
  useCalendarStore.getState().reset();
  useCalendarStore.setState({ calendars: [cal] });
  showA();
});

describe('probe 1: a window load from A lands after the switch to B', () => {
  it('leaves B\'s events and loaded range alone, so a Delete in B acts on B\'s own event', async () => {
    const aQuery = deferred<string[]>();
    mockQuery.mockReturnValueOnce(aQuery.promise);
    const pending = useCalendarStore.getState().fetchEvents(['cal-1'], AFTER, BEFORE);

    switchToB();
    // B loads its own window: its event "9" is a different event.
    useCalendarStore.setState({ calendars: [cal] });
    mockQuery.mockResolvedValueOnce(['9']);
    mockGetEvents.mockResolvedValueOnce([ev('9', 'bob')]);
    await useCalendarStore.getState().fetchEvents(['cal-1'], AFTER, '2026-10-15T00:00:00.000Z');

    // A's load finishes: id "9" is A's event.
    mockGetEvents.mockResolvedValueOnce([ev('9', 'alice')]);
    aQuery.resolve(['9']);
    await pending;

    const state = useCalendarStore.getState();
    expect(state.events.map((e) => e.title)).toEqual(['bob']);
    expect(state.loadedRange).toEqual({ after: AFTER, before: '2026-10-15T00:00:00.000Z' });
    expect(state.error).toBeNull();
    expect(state.loading).toBe(false);
  });

  it('never marks B\'s range loaded from A\'s load', async () => {
    const aQuery = deferred<string[]>();
    mockQuery.mockReturnValueOnce(aQuery.promise);
    const pending = useCalendarStore.getState().fetchEvents(['cal-1'], AFTER, BEFORE);
    switchToB();
    aQuery.resolve([]);
    await pending;
    expect(useCalendarStore.getState().loadedRange).toBeNull();
    expect(useCalendarStore.getState().events).toEqual([]);
  });

  it('sends every request of the load on the connection it started on', async () => {
    mockQuery.mockResolvedValueOnce(['1']);
    mockGetEvents.mockResolvedValueOnce([ev('1', 'alice')]);
    await useCalendarStore.getState().fetchEvents(['cal-1'], AFTER, BEFORE);
    const scope = { gen: 7, accountId: 'c' };
    expect(mockQuery).toHaveBeenCalledWith(['cal-1'], AFTER, BEFORE, scope);
    expect(mockGetEvents).toHaveBeenCalledWith(['1'], scope);
  });

  it('drops a load the client refused as stale without an error', async () => {
    mockQuery.mockRejectedValueOnce(new StaleLoadError());
    await useCalendarStore.getState().fetchEvents(['cal-1'], AFTER, BEFORE);
    expect(useCalendarStore.getState().error).toBeNull();
    expect(useCalendarStore.getState().loadedRange).toBeNull();
  });

  it('drops a load whose connection was replaced although the app still shows A', async () => {
    const aQuery = deferred<string[]>();
    mockQuery.mockReturnValueOnce(aQuery.promise);
    const pending = useCalendarStore.getState().fetchEvents(['cal-1'], AFTER, BEFORE);
    client.connectionGen = 9;
    mockGetEvents.mockResolvedValueOnce([ev('1', 'alice')]);
    aQuery.resolve(['1']);
    await pending;
    expect(useCalendarStore.getState().events).toEqual([]);
    expect(useCalendarStore.getState().loadedRange).toBeNull();
  });

  it('does not load while the client still serves the account being left', async () => {
    useEmailStore.setState({ activeAccountId: B });
    useAccountStore.setState({ activeAccountId: B });
    await useCalendarStore.getState().fetchEvents(['cal-1'], AFTER, BEFORE);
    await useCalendarStore.getState().fetchCalendars();
    await useCalendarStore.getState().fetchTasks();
    expect(mockQuery).not.toHaveBeenCalled();
    expect(mockGetCalendars).not.toHaveBeenCalled();
    expect(mockScan).not.toHaveBeenCalled();
  });

  it('a Delete in B after A\'s load landed goes to B\'s event 9 as B shows it', async () => {
    const aQuery = deferred<string[]>();
    mockQuery.mockReturnValueOnce(aQuery.promise);
    const pending = useCalendarStore.getState().fetchEvents(['cal-1'], AFTER, BEFORE);
    switchToB();
    useCalendarStore.setState({ calendars: [cal], events: [ev('9', 'bob') as never] });
    mockGetEvents.mockResolvedValueOnce([{ ...ev('9', 'alice'), participants: { p: { email: 'x@y' } } }]);
    aQuery.resolve(['9']);
    await pending;
    mockDelete.mockResolvedValue(undefined);
    await useCalendarStore.getState().deleteEvent('9', { account: { appAccountId: B } });
    // B's event has no participants: no scheduling mail goes out for A's guests.
    expect(mockDelete).toHaveBeenCalledWith(['9'], undefined, { gen: 8, accountId: 'c' });
  });
});

describe('probe 2: a task load from A in flight when B asks for its tasks', () => {
  it('B gets its own load, and A\'s task "7" never reaches B\'s store', async () => {
    const aScan = deferred<unknown[]>();
    mockScan.mockReturnValueOnce(aScan.promise);
    const aPending = useCalendarStore.getState().fetchTasks();

    switchToB();
    useCalendarStore.setState({ calendars: [cal] });
    mockScan.mockResolvedValueOnce([{ id: '7', '@type': 'Task', calendarIds: { 'cal-1': true } }]);
    mockGetEvents.mockResolvedValueOnce([{ id: '7', '@type': 'Task', title: 'bob task', progress: 'needs-action' }]);
    await useCalendarStore.getState().fetchTasks();
    expect(mockScan).toHaveBeenCalledTimes(2);

    mockGetEvents.mockResolvedValueOnce([{ id: '7', '@type': 'Task', title: 'alice task', progress: 'completed' }]);
    aScan.resolve([{ id: '7', '@type': 'Task', calendarIds: { 'cal-1': true } }]);
    await aPending;

    expect(useCalendarStore.getState().tasks.map((t) => t.title)).toEqual(['bob task']);

    // The circle in B toggles B's task 7 from B's state.
    mockUpdate.mockResolvedValue(undefined);
    await useCalendarStore.getState().toggleTaskComplete('7', { appAccountId: B });
    expect(mockUpdate).toHaveBeenCalledWith('7', { progress: 'completed', percentComplete: 100 }, undefined, { gen: 8, accountId: 'c' });
  });

  it('scans on the connection the load started on', async () => {
    await useCalendarStore.getState().fetchTasks();
    expect(mockScan).toHaveBeenCalledWith({ gen: 7, accountId: 'c' });
  });

  it('a reset releases the in-flight load', async () => {
    const aScan = deferred<unknown[]>();
    mockScan.mockReturnValueOnce(aScan.promise);
    void useCalendarStore.getState().fetchTasks();
    useCalendarStore.getState().reset();
    useCalendarStore.setState({ calendars: [cal] });
    await useCalendarStore.getState().fetchTasks();
    expect(mockScan).toHaveBeenCalledTimes(2);
    aScan.resolve([]);
  });
});

describe('calendars and identities', () => {
  it('drops A\'s calendars that land after the switch, and B loads its own', async () => {
    const aCalendars = deferred<unknown[]>();
    mockGetCalendars.mockReturnValueOnce(aCalendars.promise);
    const aPending = useCalendarStore.getState().fetchCalendars();
    switchToB();
    mockGetCalendars.mockResolvedValueOnce([{ id: 'b-cal', name: 'Bob' }]);
    await useCalendarStore.getState().fetchCalendars();
    aCalendars.resolve([{ id: 'a-cal', name: 'Alice' }]);
    await aPending;
    expect(mockGetCalendars).toHaveBeenCalledTimes(2);
    expect(useCalendarStore.getState().calendars.map((c) => c.id)).toEqual(['b-cal']);
  });

  it('loads the calendars on the connection it started on', async () => {
    mockGetCalendars.mockResolvedValueOnce([]);
    await useCalendarStore.getState().fetchCalendars();
    expect(mockGetCalendars).toHaveBeenCalledWith({ gen: 7, accountId: 'c' });
  });

  it('loads the participant identities alongside, for the account explicitly', async () => {
    const list = [{ id: 'i1', name: '', calendarAddress: 'mailto:alias@a.example', isDefault: true }];
    mockGetCalendars.mockResolvedValueOnce([]);
    mockIdentities.mockResolvedValueOnce(list);
    await useCalendarStore.getState().fetchCalendars();
    expect(mockIdentities).toHaveBeenCalledWith({ gen: 7, accountId: 'c' });
    expect(useCalendarStore.getState().participantIdentities).toEqual({ c: list });
  });

  it('an ensureRange whose calendar load was superseded marks nothing loaded', async () => {
    useCalendarStore.setState({ calendars: [] });
    const aCalendars = deferred<unknown[]>();
    mockGetCalendars.mockReturnValueOnce(aCalendars.promise);
    const pending = useCalendarStore.getState().ensureRange(AFTER, BEFORE);
    switchToB();
    aCalendars.resolve([]);
    await pending;
    expect(useCalendarStore.getState().loadedRange).toBeNull();
  });

  it('an extendRange from A that lands after the switch merges nothing into B', async () => {
    useCalendarStore.setState({ loadedRange: { after: AFTER, before: BEFORE } });
    const aQuery = deferred<string[]>();
    mockQuery.mockReturnValueOnce(aQuery.promise);
    const pending = useCalendarStore.getState().extendRange(AFTER, '2026-12-01T00:00:00.000Z');
    switchToB();
    useCalendarStore.setState({ calendars: [cal], loadedRange: { after: AFTER, before: BEFORE } });
    mockGetEvents.mockResolvedValueOnce([ev('9', 'alice')]);
    aQuery.resolve(['9']);
    await pending;
    expect(useCalendarStore.getState().events).toEqual([]);
    expect(useCalendarStore.getState().loadedRange).toEqual({ after: AFTER, before: BEFORE });
  });
});

describe('a pinned load (a widget run without the app open)', () => {
  const pin = () => ({ appAccountId: A });

  it('loads the pinned account although the mail store shows none', async () => {
    useEmailStore.setState({ activeAccountId: null });
    mockGetCalendars.mockResolvedValueOnce([{ id: 'a-cal', name: 'Alice' }]);
    mockScan.mockResolvedValueOnce([{ id: '7', '@type': 'Task', calendarIds: { 'cal-1': true } }]);
    mockGetEvents.mockResolvedValueOnce([{ id: '7', '@type': 'Task', title: 'alice task' }]);
    expect(await useCalendarStore.getState().fetchCalendars(pin())).toBe(true);
    useCalendarStore.setState({ calendars: [cal] });
    expect(await useCalendarStore.getState().fetchTasks(pin())).toBe(true);
    expect(mockGetCalendars).toHaveBeenCalledWith({ gen: 7, accountId: 'c' });
    expect(mockScan).toHaveBeenCalledWith({ gen: 7, accountId: 'c' });
    expect(useCalendarStore.getState().tasks.map((t) => t.title)).toEqual(['alice task']);
  });

  it('loads it although the mail store shows another account', async () => {
    useEmailStore.setState({ activeAccountId: B });
    mockGetCalendars.mockResolvedValueOnce([{ id: 'a-cal', name: 'Alice' }]);
    expect(await useCalendarStore.getState().fetchCalendars(pin())).toBe(true);
    expect(useCalendarStore.getState().calendars.map((c) => c.id)).toEqual(['a-cal']);
  });

  it('loads nothing when the client serves another account than the pinned one', async () => {
    useEmailStore.setState({ activeAccountId: null });
    expect(await useCalendarStore.getState().fetchCalendars({ appAccountId: B })).toBe(false);
    expect(await useCalendarStore.getState().fetchTasks({ appAccountId: B })).toBe(false);
    expect(mockGetCalendars).not.toHaveBeenCalled();
    expect(mockScan).not.toHaveBeenCalled();
  });

  it('serves a pinned account the registry has not loaded, by the client\'s server and user', async () => {
    useAccountStore.setState({ accounts: [], activeAccountId: null });
    useEmailStore.setState({ activeAccountId: null });
    mockGetCalendars.mockResolvedValueOnce([]);
    expect(await useCalendarStore.getState().fetchCalendars(pin())).toBe(true);
    expect(await useCalendarStore.getState().fetchCalendars({ appAccountId: B })).toBe(false);
  });

  it('drops a pinned load whose client moved to another account meanwhile', async () => {
    const aCalendars = deferred<unknown[]>();
    mockGetCalendars.mockReturnValueOnce(aCalendars.promise);
    const pending = useCalendarStore.getState().fetchCalendars(pin());
    client.username = 'bob@b.example';
    client.serverUrl = 'https://b.example';
    aCalendars.resolve([{ id: 'a-cal' }]);
    expect(await pending).toBe(false);
    expect(useCalendarStore.getState().calendars).toEqual([cal]);
  });

  it('runs on the scope it is given', async () => {
    mockGetCalendars.mockResolvedValueOnce([]);
    await useCalendarStore.getState().fetchCalendars({ appAccountId: A, scope: { gen: 7, accountId: 'c' } });
    expect(mockGetCalendars).toHaveBeenCalledWith({ gen: 7, accountId: 'c' });
  });

  it('an unpinned load still needs the shown account', async () => {
    useEmailStore.setState({ activeAccountId: null });
    expect(await useCalendarStore.getState().fetchCalendars()).toBe(false);
    expect(mockGetCalendars).not.toHaveBeenCalled();
  });
});

describe('residual minors', () => {
  it('a load superseded by a reconnect of the same account does not leave loading on', async () => {
    const aQuery = deferred<string[]>();
    mockQuery.mockReturnValueOnce(aQuery.promise);
    const pending = useCalendarStore.getState().fetchEvents(['cal-1'], AFTER, BEFORE);
    expect(useCalendarStore.getState().loading).toBe(true);
    client.connectionGen = 9;
    aQuery.resolve([]);
    await pending;
    expect(useCalendarStore.getState().loading).toBe(false);
    expect(useCalendarStore.getState().loadedRange).toBeNull();
  });

  it('an extendRange superseded the same way does not leave loading on', async () => {
    useCalendarStore.setState({ loadedRange: { after: AFTER, before: BEFORE } });
    const aQuery = deferred<string[]>();
    mockQuery.mockReturnValueOnce(aQuery.promise);
    const pending = useCalendarStore.getState().extendRange(AFTER, '2026-12-01T00:00:00.000Z');
    client.connectionGen = 9;
    aQuery.resolve([]);
    await pending;
    expect(useCalendarStore.getState().loading).toBe(false);
    expect(useCalendarStore.getState().loadedRange).toEqual({ after: AFTER, before: BEFORE });
  });

  it('fetches the identities with the calendars only while they are not loaded', async () => {
    mockGetCalendars.mockResolvedValue([]);
    await useCalendarStore.getState().fetchCalendars();
    await useCalendarStore.getState().fetchCalendars();
    expect(mockIdentities).toHaveBeenCalledTimes(1);
  });

  it('refreshes the identities when the server pushes a ParticipantIdentity change', async () => {
    const list = [{ id: 'i2', name: '', calendarAddress: 'mailto:new@a.example', isDefault: true }];
    useCalendarStore.setState({ participantIdentities: { c: [] } });
    mockIdentities.mockResolvedValueOnce(list);
    await useCalendarStore.getState().handleStateChange({
      '@type': 'StateChange', changed: { c: { ParticipantIdentity: 's2' } },
    } as never);
    expect(mockIdentities).toHaveBeenCalledWith({ gen: 7, accountId: 'c' });
    expect(useCalendarStore.getState().participantIdentities).toEqual({ c: list });
    expect(mockGetCalendars).not.toHaveBeenCalled();
  });
});

describe('the account the calendars were loaded for', () => {
  // The calendar screen colours new shared calendars under the shown
  // account's key: it must know whose calendars the list holds.
  it('is recorded by a calendar load and cleared on reset', async () => {
    expect(useCalendarStore.getState().calendarsAppAccountId).toBeNull();
    mockGetCalendars.mockResolvedValueOnce([cal]);
    expect(await useCalendarStore.getState().fetchCalendars()).toBe(true);
    expect(useCalendarStore.getState().calendarsAppAccountId).toBe(A);
    switchToB();
    expect(useCalendarStore.getState().calendarsAppAccountId).toBeNull();
    mockGetCalendars.mockResolvedValueOnce([cal]);
    expect(await useCalendarStore.getState().fetchCalendars()).toBe(true);
    expect(useCalendarStore.getState().calendarsAppAccountId).toBe(B);
  });

  it('is not set by A\'s load landing after the switch', async () => {
    const aLoad = deferred<unknown[]>();
    mockGetCalendars.mockReturnValueOnce(aLoad.promise);
    const pending = useCalendarStore.getState().fetchCalendars();
    switchToB();
    aLoad.resolve([cal]);
    expect(await pending).toBe(false);
    expect(useCalendarStore.getState().calendarsAppAccountId).toBeNull();
  });

  // The calendar screen claims old shared calendar colours from the list
  // recorded here: a load that failed must not pass for one of its own.
  it('is not set by a load that failed', async () => {
    mockGetCalendars.mockRejectedValueOnce(new Error('boom'));
    expect(await useCalendarStore.getState().fetchCalendars()).toBe(false);
    expect(useCalendarStore.getState().calendarsAppAccountId).toBeNull();
  });
});
