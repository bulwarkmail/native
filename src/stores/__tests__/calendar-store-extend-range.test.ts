import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/calendar', () => ({
  getCalendars: vi.fn(),
  queryEvents: vi.fn(),
  getEvents: vi.fn(),
  scanCalendarObjects: vi.fn(),
  isCalendarAccessDenied: vi.fn(() => false),
  noteCalendarAccessError: vi.fn(() => false),
  resetCalendarAccessDenied: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvents: vi.fn(),
  batchCreateEvents: vi.fn(),
  setDefaultCalendar: vi.fn(),
  rsvpEvent: vi.fn(),
  // No server-side expansion: queryEvents/getEvents answer the range.
  supportsSyntheticCalendarIds: vi.fn(async () => false),
  queryExpandedEvents: vi.fn(),
  hydrateExpandedOccurrences: vi.fn(async (events: unknown[]) => events),
  resetSyntheticIdSupport: vi.fn(),
}));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    isConnected: true,
  },
}));

import * as calendarApi from '../../api/calendar';
import { useCalendarStore } from '../calendar-store';

const mockQueryEvents = calendarApi.queryEvents as ReturnType<typeof vi.fn>;
const mockGetEvents = calendarApi.getEvents as ReturnType<typeof vi.fn>;
const mockScan = calendarApi.scanCalendarObjects as ReturnType<typeof vi.fn>;

const SEP = '2026-09-01T00:00:00.000Z';
const OCT = '2026-10-01T00:00:00.000Z';
const NOV = '2026-11-01T00:00:00.000Z';

function event(id: string, start: string) {
  return { id, uid: id, title: id, start, duration: 'PT1H', calendarIds: { 'cal-1': true } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockScan.mockResolvedValue([]);
  useCalendarStore.setState({
    calendars: [{ id: 'cal-1', name: 'Personal' } as never],
    events: [],
    tasks: [],
    taskOnlyCalendarIds: [],
    hiddenCalendarIds: [],
    loadedRange: null,
    loading: false,
    error: null,
    hydrated: false,
  });
});

describe('calendar-store extendRange (#759)', () => {
  it('loads the whole range when nothing is loaded yet', async () => {
    mockQueryEvents.mockResolvedValue([]);
    await useCalendarStore.getState().extendRange(SEP, OCT);
    expect(mockQueryEvents).toHaveBeenCalledWith(['cal-1'], SEP, OCT, undefined);
    expect(useCalendarStore.getState().loadedRange).toEqual({ after: SEP, before: OCT });
  });

  it('fetches only the new part and keeps the loaded events', async () => {
    useCalendarStore.setState({
      events: [event('a', '2026-09-10T10:00:00') as never],
      loadedRange: { after: SEP, before: OCT },
    });
    mockQueryEvents.mockResolvedValue(['b']);
    mockGetEvents.mockResolvedValue([event('b', '2026-10-10T10:00:00')]);

    await useCalendarStore.getState().extendRange(SEP, NOV);

    expect(mockQueryEvents).toHaveBeenCalledTimes(1);
    expect(mockQueryEvents).toHaveBeenCalledWith(['cal-1'], OCT, NOV, undefined);
    const state = useCalendarStore.getState();
    expect(state.events.map((e) => e.id)).toEqual(['a', 'b']);
    expect(state.loadedRange).toEqual({ after: SEP, before: NOV });
    expect(state.loading).toBe(false);
  });

  it('keeps one copy of an event that the new part returns again', async () => {
    useCalendarStore.setState({
      events: [event('a', '2026-09-30T23:30:00') as never],
      loadedRange: { after: SEP, before: OCT },
    });
    mockQueryEvents.mockResolvedValue(['a']);
    mockGetEvents.mockResolvedValue([{ ...event('a', '2026-09-30T23:30:00'), title: 'renamed' }]);

    await useCalendarStore.getState().extendRange(SEP, NOV);

    const events = useCalendarStore.getState().events;
    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('renamed');
  });

  it('loads the calendars first when a cached window has none yet', async () => {
    const mockGetCalendars = calendarApi.getCalendars as ReturnType<typeof vi.fn>;
    mockGetCalendars.mockResolvedValue([{ id: 'cal-1', name: 'Personal' }]);
    useCalendarStore.setState({ calendars: [], loadedRange: { after: SEP, before: OCT } });
    mockQueryEvents.mockResolvedValue([]);

    await useCalendarStore.getState().extendRange(SEP, NOV);

    expect(mockGetCalendars).toHaveBeenCalledTimes(1);
    expect(mockQueryEvents).toHaveBeenCalledWith(['cal-1'], OCT, NOV, undefined);
    expect(useCalendarStore.getState().loadedRange).toEqual({ after: SEP, before: NOV });
  });

  it('does not fetch a range that is already loaded', async () => {
    useCalendarStore.setState({ loadedRange: { after: SEP, before: NOV } });
    await useCalendarStore.getState().extendRange(OCT, NOV);
    expect(mockQueryEvents).not.toHaveBeenCalled();
  });

  it('starts over for a range far from the loaded one', async () => {
    useCalendarStore.setState({
      events: [event('a', '2026-09-10T10:00:00') as never],
      loadedRange: { after: SEP, before: OCT },
    });
    mockQueryEvents.mockResolvedValue([]);
    const far = { after: '2027-05-01T00:00:00.000Z', before: '2027-06-01T00:00:00.000Z' };

    await useCalendarStore.getState().extendRange(far.after, far.before);

    expect(mockQueryEvents).toHaveBeenCalledWith(['cal-1'], far.after, far.before, undefined);
    expect(useCalendarStore.getState().loadedRange).toEqual(far);
    expect(useCalendarStore.getState().events).toEqual([]);
  });

  it('starts over instead of dragging a large window along to a jump next to it', async () => {
    const big = { after: '2025-01-01T00:00:00.000Z', before: '2027-01-01T00:00:00.000Z' };
    useCalendarStore.setState({
      events: [event('old', '2025-06-10T10:00:00') as never],
      loadedRange: big,
    });
    mockQueryEvents.mockResolvedValue([]);
    const jump = { after: '2026-12-20T00:00:00.000Z', before: '2027-03-20T00:00:00.000Z' };

    await useCalendarStore.getState().extendRange(jump.after, jump.before);

    expect(mockQueryEvents).toHaveBeenCalledWith(['cal-1'], jump.after, jump.before, undefined);
    expect(useCalendarStore.getState().loadedRange).toEqual(jump);
  });

  it('drops the new part when the window was replaced meanwhile', async () => {
    useCalendarStore.setState({
      events: [event('a', '2026-09-10T10:00:00') as never],
      loadedRange: { after: SEP, before: OCT },
    });
    const elsewhere = { after: '2027-05-01T00:00:00.000Z', before: '2027-06-01T00:00:00.000Z' };
    mockQueryEvents.mockImplementation(async () => {
      useCalendarStore.setState({ events: [], loadedRange: elsewhere });
      return ['b'];
    });
    mockGetEvents.mockResolvedValue([event('b', '2026-10-10T10:00:00')]);

    await useCalendarStore.getState().extendRange(SEP, NOV);

    expect(useCalendarStore.getState().loadedRange).toEqual(elsewhere);
    expect(useCalendarStore.getState().events).toEqual([]);
    expect(useCalendarStore.getState().loading).toBe(false);
  });

  it('reports a failed load and keeps what was loaded', async () => {
    useCalendarStore.setState({
      events: [event('a', '2026-09-10T10:00:00') as never],
      loadedRange: { after: SEP, before: OCT },
    });
    mockQueryEvents.mockRejectedValue(new Error('offline'));

    await useCalendarStore.getState().extendRange(SEP, NOV);

    const state = useCalendarStore.getState();
    expect(state.error).toBe('offline');
    expect(state.loadedRange).toEqual({ after: SEP, before: OCT });
    expect(state.events.map((e) => e.id)).toEqual(['a']);
  });
});
