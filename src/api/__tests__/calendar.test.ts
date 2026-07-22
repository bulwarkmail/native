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
    it('should fetch events by id with singular JSCalendar 2.0 recurrence properties', async () => {
      // Stalwart (calcard) names the property `recurrenceRule` (singular,
      // single object) — requesting the RFC 8984 plural form returns no
      // recurrence data and repeating events vanish from the grid (#13).
      const events = [{ id: 'ev1', title: 'Meeting', start: '2026-03-29T10:00:00' }];
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/get', { list: events }, '0']],
      });

      const result = await getEvents(['ev1']);
      expect(result).toEqual(events);

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].properties).toContain('title');
      expect(call[1].properties).toContain('start');
      expect(call[1].properties).toContain('recurrenceRule');
      expect(call[1].properties).toContain('excludedRecurrenceRule');
      expect(call[1].properties).not.toContain('recurrenceRules');
      expect(call[1].properties).not.toContain('excludedRecurrenceRules');
    });

    it('should normalize a singular recurrenceRule object to the plural array form', async () => {
      const events = [{
        id: 'ev1',
        title: 'Every 5 weeks',
        start: '2026-03-02T10:00:00',
        recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly', interval: 5 },
        excludedRecurrenceRule: { frequency: 'weekly', interval: 10 },
      }];
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/get', { list: events }, '0']],
      });

      const [event] = await getEvents(['ev1']);
      expect(event.recurrenceRules).toEqual([
        { '@type': 'RecurrenceRule', frequency: 'weekly', interval: 5 },
      ]);
      expect(event.excludedRecurrenceRules).toEqual([
        { frequency: 'weekly', interval: 10 },
      ]);
      expect(event).not.toHaveProperty('recurrenceRule');
      expect(event).not.toHaveProperty('excludedRecurrenceRule');
    });

    it('should keep an array-valued recurrenceRule as-is (JMAP-created events)', async () => {
      const events = [{
        id: 'ev1',
        title: 'Weekly',
        start: '2026-03-02T10:00:00',
        recurrenceRule: [{ frequency: 'weekly', interval: 2 }],
      }];
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/get', { list: events }, '0']],
      });

      const [event] = await getEvents(['ev1']);
      expect(event.recurrenceRules).toEqual([{ frequency: 'weekly', interval: 2 }]);
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

      // The /set response echoes only server-set properties; the return value
      // merges them over the submitted payload.
      expect(result).toEqual({
        id: 'ev-new',
        title: 'Lunch',
        start: '2026-03-30T12:00:00',
        duration: 'PT1H',
        calendarIds: { 'cal-1': true },
      });
      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].create['new-event'].calendarIds).toEqual({ 'cal-1': true });
    });

    it('should send recurrence as a singular cleaned object', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/set', { created: { 'new-event': { id: 'ev-new' } } }, '0']],
      });

      const result = await createEvent(
        {
          title: 'Series',
          start: '2026-03-30T12:00:00',
          recurrenceRules: [{ frequency: 'weekly', interval: 5, until: null as unknown as string }],
        },
        'cal-1',
      );

      const sent = mockRequest.mock.calls[0][0][0][1].create['new-event'];
      expect(sent.recurrenceRule).toEqual({ frequency: 'weekly', interval: 5 });
      expect(sent).not.toHaveProperty('recurrenceRules');
      // The returned event exposes the internal plural form again.
      expect(result.recurrenceRules).toEqual([{ frequency: 'weekly', interval: 5 }]);
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

    it('should convert recurrenceRules updates to the singular property', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/set', { updated: {} }, '0']],
      });

      await updateEvent('ev1', { recurrenceRules: [{ frequency: 'monthly' }] });
      expect(mockRequest.mock.calls[0][0][0][1].update).toEqual({
        ev1: { recurrenceRule: { frequency: 'monthly' } },
      });

      // Empty array means "remove recurrence" — sent as an explicit null.
      await updateEvent('ev1', { recurrenceRules: [] });
      expect(mockRequest.mock.calls[1][0][0][1].update).toEqual({
        ev1: { recurrenceRule: null },
      });
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
