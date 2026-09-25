import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The real calendar api and store, against a mock Stalwart server
// (src/api/__tests__/stalwart-calendar-mock.ts). Stalwart 1.0 refuses a
// CalendarEvent/get that asks for recurrenceOverrides next to utcStart or
// utcEnd, and every read of the app did: the grid, tasks, reminders, the
// master of a series, the invitation look-up and the iCal subscription sync.

const h = vi.hoisted(() => ({ session: null as unknown }));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    isConnected: true,
    request: vi.fn(),
    getMaxObjectsInGet: () => 500,
    getMaxCallsInRequest: () => 16,
    get currentSession() {
      return h.session;
    },
  },
}));
vi.mock('../../api/blob', () => ({ uploadBytes: vi.fn(async () => ({ blobId: 'feed-blob' })) }));

import { jmapClient } from '../../api/jmap-client';
import type { CalendarEvent } from '../../api/types';
import { loadEventsInRange, useCalendarStore } from '../calendar-store';
import { useCalendarSubscriptionsStore } from '../calendar-subscriptions-store';
import { useSettingsStore } from '../settings-store';
import {
  asksForOverridesWithUtc,
  calendarAccountCapability,
  createStalwartCalendarMock,
  expandingQueryAnswer,
  occurrenceObjects,
  type RangeOccurrence,
  type StalwartCalendarMock,
  type StalwartCalendarMockOptions,
  type StalwartVersion,
} from '../../api/__tests__/stalwart-calendar-mock';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

const RANGE = { after: '2026-09-01T00:00:00.000Z', before: '2026-10-01T00:00:00.000Z' };
const CALENDARS = [{ id: 'cal', name: 'Personal', isDefault: true }, { id: 'work', name: 'Work' }];

const SERIES = {
  id: 'b', '@type': 'Event', uid: 'series@example.com', title: 'Daily standup', baseEventId: 'b',
  start: '2026-09-07T10:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin',
  utcStart: '2026-09-07T08:00:00Z', utcEnd: '2026-09-07T09:00:00Z', showWithoutTime: false,
  recurrenceRule: { frequency: 'daily', count: 5 },
  recurrenceOverrides: { '2026-09-10T10:00:00': { excluded: true } },
  calendarIds: { cal: true },
};
const SINGLE = {
  id: 'd', '@type': 'Event', uid: 'single@example.com', title: 'One off', baseEventId: 'd',
  start: '2026-09-08T09:00:00', duration: 'PT30M', timeZone: 'Europe/Berlin',
  utcStart: '2026-09-08T07:00:00Z', utcEnd: '2026-09-08T07:30:00Z', calendarIds: { work: true },
};
const TASK = {
  id: 't', '@type': 'Task', uid: 'task@example.com', title: 'Pay rent', due: '2026-09-10T00:00:00',
  progress: 'needs-action', calendarIds: { cal: true },
};
const occurrenceOf = (id: string, day: string) => ({
  ...SERIES, id, baseEventId: 'b', recurrenceRule: null, recurrenceOverrides: null,
  start: `2026-09-${day}T10:00:00`, utcStart: `2026-09-${day}T08:00:00Z`, utcEnd: `2026-09-${day}T09:00:00Z`,
  recurrenceId: `2026-09-${day}T10:00:00`, recurrenceIdTimeZone: 'Europe/Berlin',
});
const OCCURRENCES = {
  maaaaab: occurrenceOf('maaaaab', '07'),
  maaaaac: occurrenceOf('maaaaac', '08'),
  eaaaaad: { ...SINGLE, id: 'eaaaaad', baseEventId: 'd' },
};

describe.each<StalwartVersion>(['0.16', '1.0'])('calendar reads through the store on Stalwart %s', (version) => {
  let server: StalwartCalendarMock;

  function serve(options: Partial<StalwartCalendarMockOptions> = {}): void {
    server = createStalwartCalendarMock({
      version,
      calendars: CALENDARS,
      objects: { b: SERIES, d: SINGLE, t: TASK },
      occurrences: OCCURRENCES,
      ...options,
    });
    mockRequest.mockImplementation(server.request);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    useCalendarStore.getState().reset();
    useCalendarStore.setState({ calendars: CALENDARS as never, hiddenCalendarIds: [] });
    serve();
  });

  afterEach(() => {
    // The invariant: no get ever asks for both.
    expect(server.gets().filter((call) => asksForOverridesWithUtc(call.args))).toEqual([]);
  });

  it(`loads a range the server expands, with the series context of its occurrences, on Stalwart ${version}`, async () => {
    await useCalendarStore.getState().fetchEvents(['cal', 'work'], RANGE.after, RANGE.before);

    const { events, error } = useCalendarStore.getState();
    expect(error).toBeNull();
    expect(events.map((e) => e.id)).toEqual(['maaaaab', 'maaaaac', 'eaaaaad']);
    expect(events[0].recurrenceRules).toEqual([{ frequency: 'daily', count: 5 }]);
    expect(events[0].recurrenceOverrides).toEqual({ '2026-09-10T10:00:00': { excluded: true } });
  });

  it(`expands a series on the device from a read that carries its overrides on Stalwart ${version}`, async () => {
    serve({ syntheticIds: false });

    await useCalendarStore.getState().fetchEvents(['cal', 'work'], RANGE.after, RANGE.before);

    const { events, error } = useCalendarStore.getState();
    expect(error).toBeNull();
    const standups = events.filter((e) => e.originalId === 'b').map((e) => e.recurrenceId);
    // The override excludes the fourth day.
    expect(standups).toEqual([
      '2026-09-07T10:00:00', '2026-09-08T10:00:00', '2026-09-09T10:00:00', '2026-09-11T10:00:00',
    ]);
    expect(events.some((e) => e.id === 'd')).toBe(true);
  });

  it(`loads the reminders' window on Stalwart ${version}`, async () => {
    const upcoming = await loadEventsInRange(CALENDARS as never, ['cal', 'work'], RANGE.after, RANGE.before);
    expect(upcoming.map((e) => e.id)).toEqual(['maaaaab', 'maaaaac', 'eaaaaad']);
  });

  it(`loads tasks on Stalwart ${version}`, async () => {
    await useCalendarStore.getState().fetchTasks();

    const { tasks, error } = useCalendarStore.getState();
    expect(error).toBeNull();
    expect(tasks.map((task) => [task.id, task.due])).toEqual([['t', '2026-09-10T00:00:00']]);
  });

  it(`fetches the master of an occurrence for an edit of all events on Stalwart ${version}`, async () => {
    const occurrence = { ...OCCURRENCES.maaaaac, recurrenceRules: [{ frequency: 'daily' }] } as unknown as CalendarEvent;

    const master = await useCalendarStore.getState().getMasterEvent(occurrence);

    expect(master?.id).toBe('b');
    expect(master?.start).toBe('2026-09-07T10:00:00');
    expect(master?.recurrenceOverrides).toEqual({ '2026-09-10T10:00:00': { excluded: true } });
  });

  it(`imports events without creating the ones already there on Stalwart ${version}`, async () => {
    const result = await useCalendarStore.getState().importEvents([
      // Already in this calendar: skipped.
      { uid: 'series@example.com', title: 'Daily standup', start: '2026-09-07T10:00:00' },
      // In another calendar: linked into this one.
      { uid: 'single@example.com', title: 'One off', start: '2026-09-08T09:00:00' },
      { uid: 'new@example.com', title: 'New', start: '2026-09-12T09:00:00' },
    ], 'cal');

    expect(result).toEqual({ imported: 2, refused: [] });
    const writes = server.sets().filter((call) => !(call.args.update as Record<string, unknown> | undefined)?.h333333);
    const created = writes.flatMap((call) => Object.values((call.args.create ?? {}) as Record<string, { uid: string }>));
    expect(created.map((event) => event.uid)).toEqual(['new@example.com']);
    expect(server.objects.d.calendarIds).toEqual({ work: true, cal: true });
    // The UID look-up reads ids, UIDs and calendars only.
    expect(server.gets()[0].args.properties).toEqual(['id', 'uid', 'calendarIds']);
  });

  it(`removes what a subscribed feed dropped and adds only what is new on Stalwart ${version}`, async () => {
    serve({
      objects: {
        old: { id: 'old', uid: 'old@feed', title: 'Gone upstream', start: '2026-09-02T09:00:00', calendarIds: { feed: true } },
        kept: { id: 'kept', uid: 'kept@feed', title: 'Still there', start: '2026-09-03T09:00:00', calendarIds: { feed: true } },
      },
      answer: (call) => (call.method === 'CalendarEvent/parse'
        ? ['CalendarEvent/parse', { parsed: { 'feed-blob': [
          { uid: 'kept@feed', title: 'Still there', start: '2026-09-03T09:00:00' },
          { uid: 'new@feed', title: 'New upstream', start: '2026-09-04T09:00:00' },
        ] } }]
        : undefined),
    });
    useCalendarStore.setState({ calendars: [...CALENDARS, { id: 'feed', name: 'Feed' }] as never });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n',
    } as unknown as Response);
    useCalendarSubscriptionsStore.setState({
      subscriptions: [{ id: 'sub', name: 'Feed', url: 'https://example.com/feed.ics', calendarId: 'feed', lastSyncAt: null, lastError: null }],
    });

    try {
      await useCalendarSubscriptionsStore.getState().syncSubscription('sub');
    } finally {
      fetchSpy.mockRestore();
    }

    expect(useCalendarSubscriptionsStore.getState().subscriptions[0].lastError).toBeNull();
    expect(Object.keys(server.objects).sort()).toEqual(['created-1', 'kept']);
    expect(server.objects['created-1'].uid).toBe('new@feed');
  });

  it(`keeps the loaded events and reports the error when the server refuses a range on Stalwart ${version}`, async () => {
    await useCalendarStore.getState().fetchEvents(['cal', 'work'], RANGE.after, RANGE.before);
    const loaded = useCalendarStore.getState().events;
    serve({
      answer: (call) => (call.method === 'CalendarEvent/get'
        ? ['error', { type: 'serverFail', description: 'Internal server error' }]
        : undefined),
    });

    await useCalendarStore.getState().refresh();

    const { events, error } = useCalendarStore.getState();
    expect(events).toEqual(loaded);
    expect(error).toBe('Internal server error');
  });
});

// The loaded window of a freely scrolling view grows past a year, and
// refresh() - on every calendar push, after a series edit, on pull to
// refresh - loads all of it again in one range. Stalwart 1.0 refuses an
// expanded range longer than maxExpandedQueryDuration (P52W1D).
describe.each<StalwartVersion>(['0.16', '1.0'])('long loaded windows on Stalwart %s', (version) => {
  // About 460 days: a month view after four forward extensions.
  const LOADED = { after: '2025-12-01T00:00:00.000Z', before: '2027-03-06T00:00:00.000Z' };
  const standups: RangeOccurrence[] = [
    { id: 'maaaaab', start: '2025-12-15T10:00:00', seconds: 3600 },
    { id: 'maaaaac', start: '2026-09-07T10:00:00', seconds: 3600 },
    { id: 'maaaaad', start: '2027-03-01T10:00:00', seconds: 3600 },
  ];
  let server: StalwartCalendarMock;

  function serve(options: { maxInstances?: number } = {}): void {
    server = createStalwartCalendarMock({
      version,
      calendars: CALENDARS,
      objects: { b: SERIES },
      occurrences: occurrenceObjects('b', standups),
      answer: expandingQueryAnswer(version, { seriesId: 'b', occurrences: standups, ...options }),
    });
    mockRequest.mockImplementation(server.request);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    useSettingsStore.setState({ calendarTimeZone: 'UTC' });
    h.session = {
      accounts: { 'acc-1': { accountCapabilities: { 'urn:ietf:params:jmap:calendars': calendarAccountCapability(version) } } },
    };
    useCalendarStore.getState().reset();
    useCalendarStore.setState({ calendars: CALENDARS as never, hiddenCalendarIds: [], loadedRange: LOADED });
  });

  afterEach(() => {
    h.session = null;
    useSettingsStore.setState({ calendarTimeZone: 'auto' });
  });

  it(`refreshes the whole loaded window in chunks within the limit on Stalwart ${version}`, async () => {
    serve();

    await useCalendarStore.getState().refresh();

    const { events, error } = useCalendarStore.getState();
    expect(error).toBeNull();
    expect(events.map((e) => e.id).sort()).toEqual(['maaaaab', 'maaaaac', 'maaaaad']);
    expect(events.every((e) => e.recurrenceRules?.length === 1)).toBe(true);
    expect(server.queries().filter((q) => q.args.expandRecurrences)).toHaveLength(2);
  });

  it(`expands the window on the device when the server refuses every piece of it on Stalwart ${version}`, async () => {
    serve({ maxInstances: 0 });

    await useCalendarStore.getState().refresh();

    const { events, error } = useCalendarStore.getState();
    expect(error).toBeNull();
    // The series itself, expanded here: five days, the fourth excluded.
    expect(events.map((e) => e.recurrenceId)).toEqual([
      '2026-09-07T10:00:00', '2026-09-08T10:00:00', '2026-09-09T10:00:00', '2026-09-11T10:00:00',
    ]);
    expect(events.every((e) => e.originalId === 'b')).toBe(true);
  });
});
