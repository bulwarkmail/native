import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/calendar', () => ({
  getCalendars: vi.fn(),
  queryEvents: vi.fn(),
  getEvents: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvents: vi.fn(),
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
  });

  describe('ensureRange', () => {
    it('should fetch when no range loaded', async () => {
      useCalendarStore.setState({
        calendars: [{ id: 'cal-1', name: 'Personal' } as any],
      });
      mockQueryEvents.mockResolvedValue([]);

      await useCalendarStore.getState().ensureRange('2026-03-01', '2026-03-31');

      expect(mockQueryEvents).toHaveBeenCalledWith(['cal-1'], '2026-03-01', '2026-03-31');
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

      expect(mockQueryEvents).toHaveBeenCalledWith(['cal-1'], '2026-03-01', '2026-04-30');
    });

    it('should fetch calendars first when none are loaded', async () => {
      mockGetCalendars.mockResolvedValue([{ id: 'cal-1', name: 'Personal' }]);
      mockQueryEvents.mockResolvedValue([]);

      await useCalendarStore.getState().ensureRange('2026-03-01', '2026-03-31');

      expect(mockGetCalendars).toHaveBeenCalled();
      expect(mockQueryEvents).toHaveBeenCalledWith(['cal-1'], '2026-03-01', '2026-03-31');
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

      expect(mockUpdateEvent).toHaveBeenCalledWith('master', { title: 'New' });
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
