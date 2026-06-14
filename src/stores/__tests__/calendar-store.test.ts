import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/calendar', () => ({
  getCalendars: vi.fn(),
  queryEvents: vi.fn(),
  getEvents: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvents: vi.fn(),
  setDefaultCalendar: vi.fn(),
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
} from '../calendar-store';

const mockGetCalendars = calendarApi.getCalendars as ReturnType<typeof vi.fn>;
const mockQueryEvents = calendarApi.queryEvents as ReturnType<typeof vi.fn>;
const mockGetEvents = calendarApi.getEvents as ReturnType<typeof vi.fn>;
const mockCreateEvent = calendarApi.createEvent as ReturnType<typeof vi.fn>;
const mockUpdateEvent = calendarApi.updateEvent as ReturnType<typeof vi.fn>;
const mockDeleteEvents = calendarApi.deleteEvents as ReturnType<typeof vi.fn>;
const mockSetDefaultCalendar = calendarApi.setDefaultCalendar as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  useCalendarStore.setState({
    calendars: [],
    events: [],
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

    it('should expand the loaded range when requested window extends it', async () => {
      useCalendarStore.setState({
        calendars: [{ id: 'cal-1' } as any],
        loadedRange: { after: '2026-03-01', before: '2026-03-31' },
      });
      mockQueryEvents.mockResolvedValue([]);

      await useCalendarStore.getState().ensureRange('2026-04-01', '2026-04-30');

      expect(mockQueryEvents).toHaveBeenCalledWith(['cal-1'], '2026-03-01', '2026-04-30', undefined);
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
  });
});
