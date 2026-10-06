import { describe, it, expect, vi, beforeEach } from 'vitest';

// A widget refresh loads the calendar and tasks of the account the widget
// asks for (the registry's active one), with the app closed: the mail store
// may show no account, or a stale one. The store's cached data is never
// handed out instead; when the load can't run the widget keeps what it had.

const ui = vi.hoisted(() => ({ started: false }));
vi.mock('../ui-presence', () => ({ uiStarted: () => ui.started }));
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
vi.mock('../../stores/locale-store', () => ({
  t: (_key: string, fallback?: string) => fallback ?? _key,
  useLocaleStore: { getState: () => ({ locale: 'en', t: (_k: string, f?: string) => f ?? _k }) },
}));
vi.mock('../../stores/outbox-store', () => ({
  useOutboxStore: { getState: () => ({ entries: [], count: () => 0, setAccount: vi.fn(), flush: vi.fn() }) },
}));
vi.mock('../../stores/settings-store', () => ({ useSettingsStore: { getState: () => ({}) } }));
vi.mock('../../stores/offline-cache-store', () => ({ useOfflineCacheStore: { getState: () => ({}) } }));
vi.mock('../../stores/toast-store', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
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
import { useCalendarStore } from '../../stores/calendar-store';
import { useEmailStore } from '../../stores/email-store';
import { useAccountStore } from '../../stores/account-store';
import { generateAccountId } from '../../lib/account-utils';
import { loadWidgetCalendar, loadWidgetTasks } from '../calendar-load';

const mockGetCalendars = calendarApi.getCalendars as ReturnType<typeof vi.fn>;
const mockQuery = calendarApi.queryEvents as ReturnType<typeof vi.fn>;
const mockGetEvents = calendarApi.getEvents as ReturnType<typeof vi.fn>;
const mockScan = calendarApi.scanCalendarObjects as ReturnType<typeof vi.fn>;

const client = jmapClient as unknown as { username: string; serverUrl: string; connectionGen: number };
const A = generateAccountId('alice@a.example', 'https://a.example');
const B = generateAccountId('bob@b.example', 'https://b.example');
const AFTER = '2026-10-01T00:00:00.000Z';
const BEFORE = '2026-11-01T00:00:00.000Z';
const SCOPE = { gen: 7, accountId: 'c' };

beforeEach(() => {
  vi.clearAllMocks();
  ui.started = false;
  client.username = 'alice@a.example';
  client.serverUrl = 'https://a.example';
  client.connectionGen = 7;
  useCalendarStore.getState().reset();
  // With the app closed: no account shown, the registry not loaded.
  useEmailStore.setState({ activeAccountId: null });
  useAccountStore.setState({ accounts: [], activeAccountId: null });
  // Another account's data left in the persisted store.
  useCalendarStore.setState({
    calendars: [{ id: 'b-cal', name: 'Bob' } as never],
    tasks: [{ id: '7', title: 'bob task' } as never],
  });
  mockScan.mockResolvedValue([]);
});

describe('loadWidgetCalendar', () => {
  it('loads the pinned account although the mail store shows none', async () => {
    mockGetCalendars.mockResolvedValueOnce([{ id: 'cal-1', name: 'Alice' }]);
    mockQuery.mockResolvedValueOnce(['1']);
    mockGetEvents.mockResolvedValueOnce([
      { id: '1', title: 'alice event', start: '2026-10-10T10:00:00', duration: 'PT1H', calendarIds: { 'cal-1': true } },
    ]);
    const out = await loadWidgetCalendar(A, AFTER, BEFORE);
    expect(out?.calendars.map((c) => c.id)).toEqual(['cal-1']);
    expect(out?.events.map((e) => e.title)).toEqual(['alice event']);
    // Every request on the one scope the widget took.
    expect(mockGetCalendars).toHaveBeenCalledWith(SCOPE);
    expect(mockQuery).toHaveBeenCalledWith(['cal-1'], AFTER, BEFORE, SCOPE);
  });

  it('loads nothing and hands out nothing when the client serves another account', async () => {
    expect(await loadWidgetCalendar(B, AFTER, BEFORE)).toBeNull();
    expect(mockGetCalendars).not.toHaveBeenCalled();
  });

  it('hands out nothing when the calendar load fails', async () => {
    mockGetCalendars.mockRejectedValueOnce(new Error('offline'));
    expect(await loadWidgetCalendar(A, AFTER, BEFORE)).toBeNull();
  });

  it('with the app open, loads only the account it shows', async () => {
    ui.started = true;
    expect(await loadWidgetCalendar(A, AFTER, BEFORE)).toBeNull();
    expect(mockGetCalendars).not.toHaveBeenCalled();
  });
});

describe('loadWidgetTasks', () => {
  it('loads the pinned account\'s tasks, never the cached ones', async () => {
    mockGetCalendars.mockResolvedValueOnce([{ id: 'cal-1', name: 'Alice' }]);
    mockScan.mockResolvedValueOnce([{ id: '7', '@type': 'Task', calendarIds: { 'cal-1': true } }]);
    mockGetEvents.mockResolvedValueOnce([{ id: '7', '@type': 'Task', title: 'alice task' }]);
    const out = await loadWidgetTasks(A, false);
    expect(out?.tasks.map((t) => t.title)).toEqual(['alice task']);
    expect(mockScan).toHaveBeenCalledWith(SCOPE);
  });

  it('hands out nothing (the widget keeps its previous tasks) when the client serves another account', async () => {
    expect(await loadWidgetTasks(B, false)).toBeNull();
    expect(mockScan).not.toHaveBeenCalled();
  });
});
