import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    getMaxObjectsInGet: () => 500,
  },
}));

import { jmapClient } from '../jmap-client';
import {
  getCalendars,
  queryEvents,
  getEvents,
  createEvent,
  updateEvent,
  deleteEvents,
} from '../calendar';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('calendar operations', () => {
  describe('getCalendars', () => {
    it('should fetch calendars', async () => {
      const calendars = [{ id: 'cal-1', name: 'Personal', color: '#3b82f6' }];
      mockRequest.mockResolvedValue({
        methodResponses: [['Calendar/get', { list: calendars }, '0']],
      });

      const result = await getCalendars();
      expect(result).toEqual(calendars);
      expect(mockRequest).toHaveBeenCalledWith(
        [['Calendar/get', { accountId: 'acc-1' }, '0']],
        expect.arrayContaining(['urn:ietf:params:jmap:calendars']),
      );
    });
  });

  describe('queryEvents', () => {
    it('should filter via singular inCalendar conditions (Stalwart-compatible)', async () => {
      // Stalwart rejects the draft's plural `inCalendars` filter (and
      // after/before); calendars are restricted via singular `inCalendar`
      // conditions and date filtering stays client-side.
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/query', { ids: ['ev1', 'ev2'] }, '0']],
      });

      const result = await queryEvents(['cal-1'], '2026-03-01T00:00:00Z', '2026-03-31T23:59:59Z');
      expect(result).toEqual(['ev1', 'ev2']);

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[0]).toBe('CalendarEvent/query');
      expect(call[1].filter).toEqual({ inCalendar: 'cal-1' });
      expect(call[1].accountId).toBe('acc-1');
    });

    it('should OR multiple calendars and respect the target account', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/query', { ids: [] }, '0']],
      });

      await queryEvents(['cal-1', 'cal-2'], '', '', 'acc-shared');

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].filter).toEqual({
        operator: 'OR',
        conditions: [{ inCalendar: 'cal-1' }, { inCalendar: 'cal-2' }],
      });
      expect(call[1].accountId).toBe('acc-shared');
    });

    it('should omit the filter when no calendars are given', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/query', { ids: [] }, '0']],
      });

      await queryEvents([], '', '');

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].filter).toBeUndefined();
    });
  });

  describe('getEvents', () => {
    it('should fetch events by id with expected properties', async () => {
      const events = [{ id: 'ev1', title: 'Meeting', start: '2026-03-29T10:00:00' }];
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/get', { list: events }, '0']],
      });

      const result = await getEvents(['ev1']);
      expect(result).toEqual(events);

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].properties).toContain('title');
      expect(call[1].properties).toContain('start');
      expect(call[1].properties).toContain('recurrenceRules');
    });
  });

  describe('createEvent', () => {
    it('should create an event in the specified calendar', async () => {
      const created = { id: 'ev-new', title: 'Lunch', calendarIds: { 'cal-1': true } };
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/set', { created: { 'new-event': created } }, '0']],
      });

      const result = await createEvent(
        { title: 'Lunch', start: '2026-03-30T12:00:00', duration: 'PT1H' },
        'cal-1',
      );

      expect(result).toEqual(created);
      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].create['new-event'].calendarIds).toEqual({ 'cal-1': true });
    });
  });

  describe('updateEvent', () => {
    it('should update event fields', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/set', { updated: {} }, '0']],
      });

      await updateEvent('ev1', { title: 'Updated Meeting' });

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].update).toEqual({ ev1: { title: 'Updated Meeting' } });
    });
  });

  describe('deleteEvents', () => {
    it('should destroy events by ids', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/set', { destroyed: ['ev1'] }, '0']],
      });

      await deleteEvents(['ev1']);

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].destroy).toEqual(['ev1']);
    });
  });
});
