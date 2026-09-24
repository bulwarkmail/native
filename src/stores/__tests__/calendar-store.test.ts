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
}));

vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    isConnected: true,
  },
}));

import * as calendarApi from '../../api/calendar';
import {
  useCalendarStore,
  selectVisibleCalendars,
  selectVisibleEvents,
  ImportRefusedError,
} from '../calendar-store';

const mockGetCalendars = calendarApi.getCalendars as ReturnType<typeof vi.fn>;
const mockQueryEvents = calendarApi.queryEvents as ReturnType<typeof vi.fn>;
const mockGetEvents = calendarApi.getEvents as ReturnType<typeof vi.fn>;
const mockCreateEvent = calendarApi.createEvent as ReturnType<typeof vi.fn>;
const mockUpdateEvent = calendarApi.updateEvent as ReturnType<typeof vi.fn>;
const mockDeleteEvents = calendarApi.deleteEvents as ReturnType<typeof vi.fn>;
const mockSetDefaultCalendar = calendarApi.setDefaultCalendar as ReturnType<typeof vi.fn>;
const mockScan = calendarApi.scanCalendarObjects as ReturnType<typeof vi.fn>;
const mockRsvpEvent = calendarApi.rsvpEvent as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockScan.mockResolvedValue([]);
  useCalendarStore.setState({
    calendars: [],
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

describe('calendar-store', () => {
  describe('fetchCalendars', () => {
    it('should load calendars', async () => {
      const calendars = [{ id: 'cal-1', name: 'Personal', color: '#3b82f6' }];
      mockGetCalendars.mockResolvedValue(calendars);

      await useCalendarStore.getState().fetchCalendars();

      expect(useCalendarStore.getState().calendars).toEqual(calendars);
    });

    it('should set error on failure', async () => {
      mockGetCalendars.mockRejectedValue(new Error('Timeout'));

      await useCalendarStore.getState().fetchCalendars();

      expect(useCalendarStore.getState().error).toBe('Timeout');
    });
  });

  describe('fetchEvents', () => {
    it('should query, fetch, and store events with loaded range', async () => {
      mockQueryEvents.mockResolvedValue(['ev1']);
      const events = [{ id: 'ev1', title: 'Meeting', start: '2026-03-15T10:00:00' }];
      mockGetEvents.mockResolvedValue(events);

      await useCalendarStore.getState().fetchEvents(
        ['cal-1'],
        '2026-03-01T00:00:00Z',
        '2026-03-31T23:59:59Z',
      );

      expect(useCalendarStore.getState().events).toEqual(events);
      expect(useCalendarStore.getState().loading).toBe(false);
      expect(useCalendarStore.getState().loadedRange).toEqual({
        after: '2026-03-01T00:00:00Z',
        before: '2026-03-31T23:59:59Z',
      });
    });

    it('should handle empty results', async () => {
      mockQueryEvents.mockResolvedValue([]);

      await useCalendarStore.getState().fetchEvents(['cal-1'], '2026-03-01', '2026-03-31');

      expect(useCalendarStore.getState().events).toEqual([]);
      expect(mockGetEvents).not.toHaveBeenCalled();
    });

    it('namespaces shared/group event ids by owning account and keeps the real id in originalId', async () => {
      // A shared calendar lives in another account; its event id ("ev1") can
      // collide with one of the user's own events, so the store must namespace
      // it. Mirrors webmail's mapServerEventToStoreEvent.
      useCalendarStore.setState({
        calendars: [
          { id: 'cal-1', name: 'Personal' } as any,
          { id: 'shared-cal', name: 'Team', accountId: 'acc-2', isShared: true } as any,
        ],
      });
      mockQueryEvents.mockImplementation(async (_ids: string[], _a: string, _b: string, accountId?: string) =>
        accountId === 'acc-2' ? ['ev1'] : [],
      );
      mockGetEvents.mockImplementation(async (_ids: string[], accountId?: string) =>
        accountId === 'acc-2'
          ? [{ id: 'ev1', title: 'Standup', start: '2026-03-15T10:00:00', calendarIds: { 'shared-cal': true } }]
          : [],
      );

      await useCalendarStore.getState().fetchEvents(['cal-1', 'shared-cal'], '2026-03-01', '2026-03-31');

      const stored = useCalendarStore.getState().events;
      expect(stored).toHaveLength(1);
      expect(stored[0].id).toBe('acc-2:ev1');
      expect(stored[0].originalId).toBe('ev1');
      expect(stored[0].accountId).toBe('acc-2');
    });

    it('keeps tasks (also CalDAV ones without @type) out of the event grid', async () => {
      mockQueryEvents.mockResolvedValue(['t1', 'e1', 't2']);
      mockGetEvents.mockResolvedValue([
        { id: 't1', '@type': 'Task', title: 'Buy milk', calendarIds: { 'cal-1': true } },
        { id: 'e1', '@type': 'Event', start: '2026-03-15T10:00:00', calendarIds: { 'cal-1': true } },
        { id: 't2', title: 'Thunderbird todo', due: '2026-03-16T00:00:00', start: '2026-03-15T10:00:00', calendarIds: { 'cal-1': true } },
      ]);

      await useCalendarStore.getState().fetchEvents(['cal-1'], '2026-03-01', '2026-03-31');

      expect(useCalendarStore.getState().events.map((e) => e.id)).toEqual(['e1']);
    });
  });

  describe('fetchTasks', () => {
    it('classifies calendars whose contents are all tasks as task lists (#28)', async () => {
      // VTODO-only CalDAV collections (Todoist imports, Thunderbird task
      // lists) must be flagged so the drawer can keep them out of the
      // calendar list. Mixed calendars, calendars with start-less Events,
      // and empty calendars all stay ordinary calendars. Tasks created by
      // external CalDAV clients may lack `@type` and are detected by their
      // task-only keys.
      useCalendarStore.setState({
        calendars: [
          { id: 'cal-tasks' }, { id: 'cal-mixed' }, { id: 'cal-startless' }, { id: 'cal-empty' },
        ] as any,
      });
      mockScan.mockResolvedValue([
        { id: 't1', '@type': 'Task', calendarIds: { 'cal-tasks': true } },
        { id: 't3', due: '2026-03-16T00:00:00', calendarIds: { 'cal-tasks': true } },
        { id: 'e1', '@type': 'Event', calendarIds: { 'cal-mixed': true } },
        { id: 't2', '@type': 'Task', calendarIds: { 'cal-mixed': true } },
        { id: 'startless', '@type': 'Event', calendarIds: { 'cal-startless': true } },
      ]);
      mockGetEvents.mockImplementation(async (ids: string[]) => ids.map((id) => ({ id, title: id })));

      await useCalendarStore.getState().fetchTasks();

      expect(useCalendarStore.getState().taskOnlyCalendarIds).toEqual(['cal-tasks']);
      expect(mockGetEvents).toHaveBeenCalledWith(['t1', 't3', 't2'], undefined);
      expect(useCalendarStore.getState().tasks.map((t) => t.id)).toEqual(['t1', 't3', 't2']);
    });

    it('reclassifies task lists on rescan instead of accumulating stale ids', async () => {
      useCalendarStore.setState({
        calendars: [{ id: 'cal-old' }] as any,
        taskOnlyCalendarIds: ['cal-old'],
      });
      mockScan.mockResolvedValue([
        { id: 'e1', '@type': 'Event', calendarIds: { 'cal-old': true } },
      ]);

      await useCalendarStore.getState().fetchTasks();

      expect(useCalendarStore.getState().taskOnlyCalendarIds).toEqual([]);
      expect(useCalendarStore.getState().tasks).toEqual([]);
    });

    it('maps shared-account task lists onto namespaced store ids', async () => {
      useCalendarStore.setState({
        calendars: [
          { id: 'cal-1' },
          { id: 'acc-2:todo', originalId: 'todo', accountId: 'acc-2', isShared: true },
        ] as any,
      });
      mockScan.mockImplementation(async (accountId?: string) =>
        accountId === 'acc-2' ? [{ id: 't1', '@type': 'Task', calendarIds: { todo: true } }] : [],
      );
      mockGetEvents.mockImplementation(async (ids: string[], accountId?: string) =>
        accountId === 'acc-2' ? [{ id: 't1', title: 'Shared todo', calendarIds: { todo: true } }] : [],
      );

      await useCalendarStore.getState().fetchTasks();

      expect(useCalendarStore.getState().taskOnlyCalendarIds).toEqual(['acc-2:todo']);
      expect(useCalendarStore.getState().tasks[0].id).toBe('acc-2:t1');
      expect(useCalendarStore.getState().tasks[0].calendarIds).toEqual({ 'acc-2:todo': true });
    });

    it('routes queries by account when own and shared calendars share a raw id', async () => {
      // The user's own "default" calendar and a family group's "default"
      // calendar collide on the raw JMAP id. The shared one is namespaced
      // (`acc-2:default`, originalId "default"); the query must use the raw id
      // against acc-2, and the returned event's calendarIds must be remapped to
      // the namespaced store id so it isn't hidden with the personal calendar.
      useCalendarStore.setState({
        calendars: [
          { id: 'default', name: 'Personal' } as any,
          { id: 'acc-2:default', originalId: 'default', name: 'Family', accountId: 'acc-2', isShared: true } as any,
        ],
      });
      const queried: Record<string, string[]> = {};
      mockQueryEvents.mockImplementation(async (ids: string[], _a: string, _b: string, accountId?: string) => {
        queried[accountId ?? 'primary'] = ids;
        return accountId === 'acc-2' ? ['fam1'] : [];
      });
      mockGetEvents.mockImplementation(async (_ids: string[], accountId?: string) =>
        accountId === 'acc-2'
          ? [{ id: 'fam1', title: 'Soccer', start: '2026-03-20T15:00:00', calendarIds: { default: true } }]
          : [],
      );

      await useCalendarStore.getState().fetchEvents(['default', 'acc-2:default'], '2026-03-01', '2026-03-31');

      // The shared account is queried with the raw calendar id, not the prefix.
      expect(queried['acc-2']).toEqual(['default']);
      const ev = useCalendarStore.getState().events[0];
      expect(ev.calendarIds).toEqual({ 'acc-2:default': true });

      // Hiding the personal "default" must not hide the family event.
      useCalendarStore.setState({ hiddenCalendarIds: ['default'] });
      const visible = selectVisibleEvents(useCalendarStore.getState());
      expect(visible.map((e) => e.id)).toContain('acc-2:fam1');
    });
  });

  describe('ensureRange', () => {
    it('should fetch when no range loaded', async () => {
      useCalendarStore.setState({
        calendars: [{ id: 'cal-1', name: 'Personal' } as any],
      });
      mockQueryEvents.mockResolvedValue([]);

      await useCalendarStore.getState().ensureRange('2026-03-01', '2026-03-31');

      // 4th arg is the owning account — undefined for primary-account calendars.
      expect(mockQueryEvents).toHaveBeenCalledWith(['cal-1'], '2026-03-01', '2026-03-31', undefined);
    });

    it('should skip refetch when loaded range covers requested', async () => {
      useCalendarStore.setState({
        calendars: [{ id: 'cal-1' } as any],
        loadedRange: { after: '2026-01-01', before: '2026-12-31' },
      });
      mockQueryEvents.mockResolvedValue([]);

      await useCalendarStore.getState().ensureRange('2026-03-01', '2026-03-31');

      expect(mockQueryEvents).not.toHaveBeenCalled();
    });

    it('should load exactly the requested window when it is not covered', async () => {
      // Queries are date-windowed, so moving past the loaded range fetches
      // the new window instead of an ever-growing union of everything seen.
      useCalendarStore.setState({
        calendars: [{ id: 'cal-1' } as any],
        loadedRange: { after: '2026-03-01', before: '2026-03-31' },
      });
      mockQueryEvents.mockResolvedValue([]);

      await useCalendarStore.getState().ensureRange('2026-04-01', '2026-04-30');

      expect(mockQueryEvents).toHaveBeenCalledWith(['cal-1'], '2026-04-01', '2026-04-30', undefined);
      expect(useCalendarStore.getState().loadedRange).toEqual({ after: '2026-04-01', before: '2026-04-30' });
    });

    it('dedupes concurrent first-touch calendar fetches (#907)', async () => {
      let resolveCalendars: (v: unknown) => void = () => {};
      mockGetCalendars.mockImplementation(
        () => new Promise((resolve) => { resolveCalendars = resolve; }),
      );
      mockQueryEvents.mockResolvedValue([]);

      const a = useCalendarStore.getState().fetchCalendars();
      const b = useCalendarStore.getState().ensureRange('2026-03-01', '2026-03-31');
      resolveCalendars([{ id: 'cal-1', name: 'Personal' }]);
      await Promise.all([a, b]);

      expect(mockGetCalendars).toHaveBeenCalledTimes(1);
      expect(mockQueryEvents).toHaveBeenCalledWith(['cal-1'], '2026-03-01', '2026-03-31', undefined);
    });

    it('should fetch calendars first when none are loaded', async () => {
      mockGetCalendars.mockResolvedValue([{ id: 'cal-1', name: 'Personal' }]);
      mockQueryEvents.mockResolvedValue([]);

      await useCalendarStore.getState().ensureRange('2026-03-01', '2026-03-31');

      expect(mockGetCalendars).toHaveBeenCalled();
      expect(mockQueryEvents).toHaveBeenCalledWith(['cal-1'], '2026-03-01', '2026-03-31', undefined);
    });
  });

  describe('handleStateChange', () => {
    it('should refetch when CalendarEvent state changes for the account', async () => {
      useCalendarStore.setState({
        calendars: [{ id: 'cal-1' } as any],
        loadedRange: { after: '2026-03-01', before: '2026-03-31' },
      });
      mockQueryEvents.mockResolvedValue([]);

      await useCalendarStore.getState().handleStateChange({
        '@type': 'StateChange',
        changed: { 'acc-1': { CalendarEvent: 'state-2' } },
      });

      expect(mockQueryEvents).toHaveBeenCalled();
    });

    it('should refetch calendars when Calendar state changes', async () => {
      mockGetCalendars.mockResolvedValue([{ id: 'cal-1' }]);

      await useCalendarStore.getState().handleStateChange({
        '@type': 'StateChange',
        changed: { 'acc-1': { Calendar: 'state-2' } },
      });

      expect(mockGetCalendars).toHaveBeenCalled();
    });

    it('should ignore unrelated changes', async () => {
      await useCalendarStore.getState().handleStateChange({
        '@type': 'StateChange',
        changed: { 'acc-1': { Email: 'state-2' } },
      });

      expect(mockGetCalendars).not.toHaveBeenCalled();
      expect(mockQueryEvents).not.toHaveBeenCalled();
    });

    it('should ignore changes for other accounts', async () => {
      await useCalendarStore.getState().handleStateChange({
        '@type': 'StateChange',
        changed: { 'other-acc': { CalendarEvent: 'state-2' } },
      });

      expect(mockQueryEvents).not.toHaveBeenCalled();
    });
  });

  describe('toggleCalendarVisibility', () => {
    it('should add to hidden when previously visible', () => {
      useCalendarStore.getState().toggleCalendarVisibility('cal-1');
      expect(useCalendarStore.getState().hiddenCalendarIds).toEqual(['cal-1']);
    });

    it('should remove from hidden when previously hidden', () => {
      useCalendarStore.setState({ hiddenCalendarIds: ['cal-1'] });
      useCalendarStore.getState().toggleCalendarVisibility('cal-1');
      expect(useCalendarStore.getState().hiddenCalendarIds).toEqual([]);
    });
  });

  describe('selectors', () => {
    it('selectVisibleCalendars filters out hidden calendars', () => {
      useCalendarStore.setState({
        calendars: [{ id: 'cal-1' } as any, { id: 'cal-2' } as any],
        hiddenCalendarIds: ['cal-1'],
      });
      expect(selectVisibleCalendars(useCalendarStore.getState())).toEqual([
        { id: 'cal-2' },
      ]);
    });

    it('selectVisibleEvents filters out events whose calendars are all hidden', () => {
      useCalendarStore.setState({
        events: [
          { id: 'a', calendarIds: { 'cal-1': true } } as any,
          { id: 'b', calendarIds: { 'cal-2': true } } as any,
          { id: 'c', calendarIds: { 'cal-1': true, 'cal-2': true } } as any,
        ],
        hiddenCalendarIds: ['cal-1'],
      });
      const visible = selectVisibleEvents(useCalendarStore.getState());
      expect(visible.map((e) => e.id)).toEqual(['b', 'c']);
    });
  });

  describe('createEvent', () => {
    it('should create and append event', async () => {
      useCalendarStore.setState({ events: [{ id: 'ev1' } as any] });
      const created = { id: 'ev-new', title: 'Lunch' };
      mockCreateEvent.mockResolvedValue(created);

      const result = await useCalendarStore.getState().createEvent(
        { title: 'Lunch', start: '2026-03-30T12:00:00' },
        'cal-1',
      );

      expect(result).toEqual(created);
      expect(useCalendarStore.getState().events).toHaveLength(2);
    });

    it('re-reads the created event and expands a recurring series across the loaded range', async () => {
      useCalendarStore.setState({
        events: [],
        loadedRange: { after: '2026-03-01T00:00:00Z', before: '2026-03-10T00:00:00Z' },
      });
      mockCreateEvent.mockResolvedValue({ id: 'ev-new', title: 'Standup', start: '2026-03-02T09:00:00' });
      mockGetEvents.mockResolvedValue([{
        id: 'ev-new',
        uid: 'u',
        title: 'Standup',
        start: '2026-03-02T09:00:00',
        utcStart: '2026-03-02T08:00:00Z',
        utcEnd: '2026-03-02T08:30:00Z',
        duration: 'PT30M',
        calendarIds: { 'cal-1': true },
        recurrenceRules: [{ frequency: 'daily', count: 3 }],
      }]);

      const result = await useCalendarStore.getState().createEvent(
        { title: 'Standup', start: '2026-03-02T09:00:00' },
        'cal-1',
      );

      expect(mockGetEvents).toHaveBeenCalledWith(['ev-new'], undefined);
      expect(result.utcStart).toBe('2026-03-02T08:00:00Z');
      const events = useCalendarStore.getState().events;
      expect(events).toHaveLength(3);
      expect(events.every((e) => e.originalId === 'ev-new' && !!e.recurrenceId)).toBe(true);
    });
  });

  describe('updateEvent', () => {
    it('should update and merge in state', async () => {
      useCalendarStore.setState({
        events: [{ id: 'ev1', title: 'Meeting' } as any],
      });
      mockUpdateEvent.mockResolvedValue(undefined);

      await useCalendarStore.getState().updateEvent('ev1', { title: 'Updated Meeting' } as any);

      expect(useCalendarStore.getState().events[0].title).toBe('Updated Meeting');
    });

    it('should resolve expanded occurrence id back to master id when updating', async () => {
      useCalendarStore.setState({
        events: [{ id: 'master:2026-04-01T09:00:00', originalId: 'master', title: 'Daily' } as any],
      });
      mockUpdateEvent.mockResolvedValue(undefined);

      await useCalendarStore.getState().updateEvent(
        'master:2026-04-01T09:00:00',
        { title: 'New' } as any,
      );

      // The third arg is the iMIP scheduling flag — undefined here since the
      // event has no participants to notify. The fourth is the owning
      // account — undefined for primary-account events.
      expect(mockUpdateEvent).toHaveBeenCalledWith('master', { title: 'New' }, undefined, undefined);
    });
  });

  describe('setDefaultCalendar', () => {
    it('flips isDefault to the chosen calendar within the same account', async () => {
      useCalendarStore.setState({
        calendars: [
          { id: 'cal-1', name: 'A', isDefault: true } as any,
          { id: 'cal-2', name: 'B' } as any,
          { id: 'cal-3', name: 'Shared', isShared: true, accountId: 'acc-2', isDefault: true } as any,
        ],
      });
      mockSetDefaultCalendar.mockResolvedValue(undefined);

      await useCalendarStore.getState().setDefaultCalendar('cal-2');

      expect(mockSetDefaultCalendar).toHaveBeenCalledWith('cal-2', undefined);
      const calendars = useCalendarStore.getState().calendars;
      expect(calendars.find((c) => c.id === 'cal-1')?.isDefault).toBe(false);
      expect(calendars.find((c) => c.id === 'cal-2')?.isDefault).toBe(true);
      // Defaults in other accounts are untouched.
      expect(calendars.find((c) => c.id === 'cal-3')?.isDefault).toBe(true);
    });
  });

  describe('deleteEvent', () => {
    it('should remove event from list', async () => {
      useCalendarStore.setState({
        events: [{ id: 'ev1' } as any, { id: 'ev2' } as any],
      });
      mockDeleteEvents.mockResolvedValue(undefined);

      await useCalendarStore.getState().deleteEvent('ev1');

      expect(useCalendarStore.getState().events).toHaveLength(1);
      expect(useCalendarStore.getState().events[0].id).toBe('ev2');
    });

    it('should drop every expanded occurrence of a destroyed master and refetch', async () => {
      useCalendarStore.setState({
        calendars: [{ id: 'cal-1', name: 'Personal' } as any],
        loadedRange: { after: '2026-03-01T00:00:00Z', before: '2026-03-31T00:00:00Z' },
        events: [
          { id: 'ev1:a', originalId: 'ev1', recurrenceId: 'a', recurrenceRules: [{ frequency: 'daily' }] } as any,
          { id: 'ev1:b', originalId: 'ev1', recurrenceId: 'b', recurrenceRules: [{ frequency: 'daily' }] } as any,
          { id: 'ev2' } as any,
        ],
      });
      mockDeleteEvents.mockResolvedValue(undefined);
      mockQueryEvents.mockResolvedValue([]);

      await useCalendarStore.getState().deleteEvent('ev1:a');

      expect(mockDeleteEvents).toHaveBeenCalledWith(['ev1'], undefined, undefined);
      // The visible range was reloaded (empty here).
      expect(mockQueryEvents).toHaveBeenCalled();
    });
  });

  describe('importEvents', () => {
    it('links UIDs that exist in another calendar instead of skipping them and whitelists properties (#113)', async () => {
      useCalendarStore.setState({
        calendars: [{ id: 'cal-1' }, { id: 'cal-2' }] as any,
        loadedRange: { after: '2026-03-01T00:00:00Z', before: '2026-03-31T00:00:00Z' },
      });
      mockQueryEvents.mockResolvedValue(['e1', 'e2']);
      mockGetEvents.mockResolvedValue([
        { id: 'e1', uid: 'uid-elsewhere', calendarIds: { 'cal-1': true } },
        { id: 'e2', uid: 'uid-here', calendarIds: { 'cal-2': true } },
      ]);
      mockUpdateEvent.mockResolvedValue(undefined);
      const batch = calendarApi.batchCreateEvents as ReturnType<typeof vi.fn>;
      batch.mockResolvedValue({ created: 1, refused: [] });

      const { imported: count, refused } = await useCalendarStore.getState().importEvents(
        [
          { uid: 'uid-elsewhere', title: 'Linked', start: '2026-03-02T09:00:00' },
          { uid: 'uid-here', title: 'Dup', start: '2026-03-02T09:00:00' },
          {
            uid: 'uid-new', title: 'New', start: '2026-03-03T00:00:00', showWithoutTime: true,
            duration: 'PT23H59M59S', timeZone: 'Europe/Berlin', utcStart: '2026-03-03T00:00:00Z',
            participants: { p: { email: 'x@y', sendTo: { imip: 'mailto:x@y' }, roles: { attendee: true } } },
          } as any,
        ],
        'cal-2',
      );

      // The UID in cal-1 is linked into cal-2; the one already in cal-2 is skipped.
      expect(mockUpdateEvent).toHaveBeenCalledWith('e1', { calendarIds: { 'cal-1': true, 'cal-2': true } }, undefined, undefined);
      expect(count).toBe(2);
      expect(refused).toEqual([]);
      const created = batch.mock.calls[0][0][0];
      expect(created.duration).toBe('P1D');
      expect(created.timeZone).toBeUndefined();
      expect(created.utcStart).toBeUndefined();
      expect(created.participants.p.calendarAddress).toBe('mailto:x@y');
      expect(created.participants.p.sendTo).toBeUndefined();
    });
  });

  describe('importEvents refusals', () => {
    const batch = () => calendarApi.batchCreateEvents as ReturnType<typeof vi.fn>;

    beforeEach(() => {
      useCalendarStore.setState({
        calendars: [{ id: 'cal-1' }, { id: 'cal-2' }] as any,
        loadedRange: { after: '2026-03-01T00:00:00Z', before: '2026-03-31T00:00:00Z' },
      });
    });

    it('lists the events the server refused next to the imported count', async () => {
      mockQueryEvents.mockResolvedValue([]);
      batch().mockResolvedValue({
        created: 1,
        refused: [{ index: 1, reason: 'invalidProperties (participants)' }],
      });

      const result = await useCalendarStore.getState().importEvents(
        [
          { uid: 'a', title: 'Fine', start: '2026-03-02T09:00:00' },
          { uid: 'b', title: 'Broken', start: '2026-03-03T09:00:00' },
        ],
        'cal-1',
      );

      expect(result.imported).toBe(1);
      expect(result.refused).toEqual([
        { event: expect.objectContaining({ title: 'Broken' }), reason: 'invalidProperties (participants)' },
      ]);
    });

    it('maps refusals in a later chunk back to the right event', async () => {
      mockQueryEvents.mockResolvedValue([]);
      batch()
        .mockResolvedValueOnce({ created: 50, refused: [] })
        .mockResolvedValueOnce({ created: 1, refused: [{ index: 1, reason: 'forbidden' }] });
      const events = Array.from({ length: 52 }, (_, i) => ({
        uid: `u${i}`, title: `E${i}`, start: '2026-03-02T09:00:00',
      }));

      const result = await useCalendarStore.getState().importEvents(events, 'cal-1');

      expect(result.imported).toBe(51);
      expect(result.refused.map((r) => r.event.title)).toEqual(['E51']);
    });

    it('reports a link into the target calendar that the server refused', async () => {
      mockQueryEvents.mockResolvedValue(['e1']);
      mockGetEvents.mockResolvedValue([{ id: 'e1', uid: 'shared', calendarIds: { 'cal-1': true } }]);
      mockUpdateEvent.mockRejectedValue(new Error('forbidden'));

      await expect(
        useCalendarStore.getState().importEvents([{ uid: 'shared', title: 'Linked' }], 'cal-2'),
      ).rejects.toMatchObject({
        name: 'ImportRefusedError',
        refused: [{ event: expect.objectContaining({ title: 'Linked' }), reason: 'forbidden' }],
      });
    });

    it('rejects with every refusal when nothing got in, so callers never read it as a duplicate', async () => {
      mockQueryEvents.mockResolvedValue([]);
      batch().mockRejectedValue(new Error('unknown calendar'));

      const promise = useCalendarStore.getState().importEvents(
        [
          { uid: 'a', title: 'One', start: '2026-03-02T09:00:00' },
          { uid: 'b', title: 'Two', start: '2026-03-03T09:00:00' },
        ],
        'cal-1',
      );

      await expect(promise).rejects.toBeInstanceOf(ImportRefusedError);
      await expect(promise).rejects.toThrow('2 events could not be imported: unknown calendar');
      await expect(promise).rejects.toMatchObject({
        refused: [
          { event: expect.objectContaining({ title: 'One' }), reason: 'unknown calendar' },
          { event: expect.objectContaining({ title: 'Two' }), reason: 'unknown calendar' },
        ],
      });
    });

    it('resolves with nothing imported and nothing refused when every event is already there', async () => {
      mockQueryEvents.mockResolvedValue(['e1']);
      mockGetEvents.mockResolvedValue([{ id: 'e1', uid: 'dup', calendarIds: { 'cal-1': true } }]);

      await expect(
        useCalendarStore.getState().importEvents([{ uid: 'dup', title: 'Dup' }], 'cal-1'),
      ).resolves.toEqual({ imported: 0, refused: [] });
      expect(batch()).not.toHaveBeenCalled();
    });
  });

  describe('recurring series mutations', () => {
    it('updateEvent on an occurrence patches the master and refetches the range', async () => {
      useCalendarStore.setState({
        calendars: [{ id: 'cal-1', name: 'Personal' } as any],
        loadedRange: { after: '2026-03-01T00:00:00Z', before: '2026-03-31T00:00:00Z' },
        events: [
          { id: 'ev1:a', originalId: 'ev1', recurrenceId: 'a', title: 'Old', recurrenceRules: [{ frequency: 'daily' }] } as any,
          { id: 'ev1:b', originalId: 'ev1', recurrenceId: 'b', title: 'Old', recurrenceRules: [{ frequency: 'daily' }] } as any,
        ],
      });
      mockUpdateEvent.mockResolvedValue(undefined);
      mockQueryEvents.mockResolvedValue(['ev1']);
      mockGetEvents.mockResolvedValue([
        { id: 'ev1', title: 'New', start: '2026-03-02T09:00:00', recurrenceRules: [{ frequency: 'daily', count: 2 }], calendarIds: { 'cal-1': true } },
      ]);

      await useCalendarStore.getState().updateEvent('ev1:a', { 'recurrenceOverrides/a': { title: 'New' } });

      expect(mockUpdateEvent).toHaveBeenCalledWith('ev1', { 'recurrenceOverrides/a': { title: 'New' } }, undefined, undefined);
      // Refetched: siblings now carry the server's state.
      const events = useCalendarStore.getState().events;
      expect(events.length).toBeGreaterThan(0);
      expect(events.every((e) => e.title === 'New')).toBe(true);
    });

    it('updateEvent remaps namespaced calendarIds to the raw server id', async () => {
      useCalendarStore.setState({
        calendars: [
          { id: 'cal-1', name: 'Personal' } as any,
          { id: 'acc-2:cal-9', originalId: 'cal-9', accountId: 'acc-2', name: 'Shared', isShared: true } as any,
        ],
        events: [{ id: 'ev1', calendarIds: { 'cal-1': true } } as any],
      });
      mockUpdateEvent.mockResolvedValue(undefined);

      await useCalendarStore.getState().updateEvent('ev1', { calendarIds: { 'acc-2:cal-9': true } });

      expect(mockUpdateEvent).toHaveBeenCalledWith('ev1', { calendarIds: { 'cal-9': true } }, undefined, undefined);
    });

    it('getMasterEvent fetches the master an occurrence points at', async () => {
      useCalendarStore.setState({ calendars: [], events: [] });
      mockGetEvents.mockResolvedValue([{ id: 'ev1', start: '2026-03-02T09:00:00', recurrenceRules: [{ frequency: 'daily' }] }]);

      const master = await useCalendarStore.getState().getMasterEvent({
        id: 'ev1:a', originalId: 'ev1', recurrenceId: 'a', start: '2026-03-04T09:00:00',
      } as any);

      expect(mockGetEvents).toHaveBeenCalledWith(['ev1'], undefined);
      expect(master?.id).toBe('ev1');
      expect(master?.start).toBe('2026-03-02T09:00:00');
    });

    it('getMasterEvent returns a master as-is', async () => {
      const ev = { id: 'ev1', recurrenceRules: [{ frequency: 'daily' }] } as any;
      expect(await useCalendarStore.getState().getMasterEvent(ev)).toBe(ev);
      expect(mockGetEvents).not.toHaveBeenCalled();
    });
  });

  describe('rsvpEvent', () => {
    it('answers an event outside the loaded window that the caller hands over (B22)', async () => {
      useCalendarStore.setState({ events: [] });
      mockRsvpEvent.mockResolvedValue(undefined);
      const found = { id: 'ev9', uid: 'inv@example.com', start: '2027-01-10T09:00:00' } as any;

      await useCalendarStore.getState().rsvpEvent(
        'ev9', 'p1', 'accepted', { imip: 'mailto:boss@example.com' }, found,
      );

      // No organizer on the event: repaired from the invitation's replyTo.
      expect(mockRsvpEvent).toHaveBeenCalledWith(
        'ev9', 'p1', 'accepted', 'mailto:boss@example.com', undefined,
      );
    });

    it('prefers the loaded copy of the event', async () => {
      useCalendarStore.setState({
        events: [{
          id: 'acc-2:ev1', originalId: 'ev1', accountId: 'acc-2',
          organizerCalendarAddress: 'mailto:boss@example.com',
          participants: { p1: { participationStatus: 'needs-action' } },
        } as any],
      });
      mockRsvpEvent.mockResolvedValue(undefined);

      await useCalendarStore.getState().rsvpEvent('acc-2:ev1', 'p1', 'declined', { imip: 'mailto:x@example.com' });

      expect(mockRsvpEvent).toHaveBeenCalledWith('ev1', 'p1', 'declined', undefined, 'acc-2');
      expect(useCalendarStore.getState().events[0].participants?.p1.participationStatus).toBe('declined');
    });
  });

  describe('toggleTaskComplete', () => {
    it('completes a task without sending progressUpdated, which Stalwart rejects (#958)', async () => {
      useCalendarStore.setState({
        tasks: [{ id: 't1', '@type': 'Task', progress: 'needs-action' } as any],
      });
      mockUpdateEvent.mockResolvedValue(undefined);

      await useCalendarStore.getState().toggleTaskComplete('t1');

      expect(mockUpdateEvent).toHaveBeenCalledWith(
        't1',
        { progress: 'completed', percentComplete: 100 },
        undefined,
        undefined,
      );
      expect(useCalendarStore.getState().tasks[0].progress).toBe('completed');
    });

    it('reopens a completed task as needs-action on its owning account', async () => {
      useCalendarStore.setState({
        tasks: [{ id: 'acc-2:t1', originalId: 't1', accountId: 'acc-2', progress: 'completed' } as any],
      });
      mockUpdateEvent.mockResolvedValue(undefined);

      await useCalendarStore.getState().toggleTaskComplete('acc-2:t1');

      expect(mockUpdateEvent).toHaveBeenCalledWith(
        't1',
        { progress: 'needs-action', percentComplete: 0 },
        undefined,
        'acc-2',
      );
      expect(useCalendarStore.getState().tasks[0].progress).toBe('needs-action');
    });

    it('reopens a cancelled task, which the tasks sheet shows as ticked', async () => {
      useCalendarStore.setState({
        tasks: [{ id: 't1', progress: 'cancelled' } as any],
      });
      mockUpdateEvent.mockResolvedValue(undefined);

      await useCalendarStore.getState().toggleTaskComplete('t1');

      expect(mockUpdateEvent).toHaveBeenCalledWith(
        't1',
        { progress: 'needs-action', percentComplete: 0 },
        undefined,
        undefined,
      );
    });

    it('flips the task at once and reverts it when the server refuses', async () => {
      useCalendarStore.setState({
        tasks: [{ id: 't1', progress: 'needs-action', percentComplete: 20 } as any],
      });
      let reject!: (err: Error) => void;
      mockUpdateEvent.mockReturnValue(new Promise((_, r) => { reject = r; }));

      const pending = useCalendarStore.getState().toggleTaskComplete('t1');
      expect(useCalendarStore.getState().tasks[0].progress).toBe('completed');

      reject(new Error('invalidProperties'));
      await expect(pending).rejects.toThrow('invalidProperties');
      expect(useCalendarStore.getState().tasks[0]).toMatchObject({
        progress: 'needs-action',
        percentComplete: 20,
      });
    });
  });
});
