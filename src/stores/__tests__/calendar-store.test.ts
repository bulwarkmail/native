import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/calendar', () => ({
  getCalendars: vi.fn(),
  queryEvents: vi.fn(),
  getEvents: vi.fn(),
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  deleteEvents: vi.fn(),
}));

import * as calendarApi from '../../api/calendar';
import { useCalendarStore } from '../calendar-store';

const mockGetCalendars = calendarApi.getCalendars as ReturnType<typeof vi.fn>;
const mockQueryEvents = calendarApi.queryEvents as ReturnType<typeof vi.fn>;
const mockGetEvents = calendarApi.getEvents as ReturnType<typeof vi.fn>;
const mockCreateEvent = calendarApi.createEvent as ReturnType<typeof vi.fn>;
const mockUpdateEvent = calendarApi.updateEvent as ReturnType<typeof vi.fn>;
const mockDeleteEvents = calendarApi.deleteEvents as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  useCalendarStore.getState().reset();
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
    it('should query and fetch events', async () => {
      mockQueryEvents.mockResolvedValue(['ev1']);
      const events = [{ id: 'ev1', title: 'Meeting' }];
      mockGetEvents.mockResolvedValue(events);

      await useCalendarStore.getState().fetchEvents(
        ['cal-1'],
        '2026-03-01T00:00:00Z',
        '2026-03-31T23:59:59Z',
      );

      expect(useCalendarStore.getState().events).toEqual(events);
      expect(useCalendarStore.getState().loading).toBe(false);
    });

    it('should handle empty results', async () => {
      mockQueryEvents.mockResolvedValue([]);

      await useCalendarStore.getState().fetchEvents(['cal-1'], '2026-03-01', '2026-03-31');

      expect(useCalendarStore.getState().events).toEqual([]);
      expect(mockGetEvents).not.toHaveBeenCalled();
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
