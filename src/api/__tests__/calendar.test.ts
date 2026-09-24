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
  findEventsByUid,
  toLocalDateTime,
} from '../calendar';

describe('toLocalDateTime', () => {
  it('renders an instant as wall-clock in the given zone', () => {
    expect(toLocalDateTime('2026-03-01T00:30:00Z', 'Europe/Berlin')).toBe('2026-03-01T01:30:00');
    expect(toLocalDateTime('2026-03-01T00:30:00Z', 'America/New_York')).toBe('2026-02-28T19:30:00');
    expect(toLocalDateTime('2026-07-01T23:15:00.000Z', 'UTC')).toBe('2026-07-01T23:15:00');
  });

  it('passes LocalDateTime strings through', () => {
    expect(toLocalDateTime('2026-03-01T00:00:00', 'UTC')).toMatch(/^2026-0[23]-\d{2}T\d{2}:00:00$/);
  });
});

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
      // Stalwart rejects the draft's plural `inCalendars` filter; calendars
      // are restricted via singular `inCalendar` conditions.
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/query', { ids: ['ev1', 'ev2'] }, '0']],
      });

      const result = await queryEvents(['cal-1'], '', '');
      expect(result).toEqual(['ev1', 'ev2']);

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[0]).toBe('CalendarEvent/query');
      // No bounds: only the calendar restriction is sent.
      expect(call[1].filter).toEqual({ inCalendar: 'cal-1' });
      expect(call[1].accountId).toBe('acc-1');
      expect(call[1].position).toBe(0);
    });

    it('should send the date window as LocalDateTime after/before combined with the calendar filter', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/query', { ids: [] }, '0']],
      });

      await queryEvents(['cal-1'], '2026-03-01T00:00:00Z', '2026-03-31T23:59:59Z');

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].filter.operator).toBe('AND');
      expect(call[1].filter.conditions[0]).toEqual({ inCalendar: 'cal-1' });
      const range = call[1].filter.conditions[1];
      expect(range.after).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      expect(range.before).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
      expect(call[1].timeZone).toBeTruthy();
    });

    it('should send only the range when no calendars are given', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/query', { ids: [] }, '0']],
      });

      await queryEvents([], '2026-03-01T00:00:00Z', '2026-03-31T23:59:59Z');

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].filter.operator).toBeUndefined();
      expect(Object.keys(call[1].filter).sort()).toEqual(['after', 'before']);
    });

    it('should page through a result set larger than one page', async () => {
      // Regression: a full page used to be returned as the complete answer, so
      // an account with more events than the page size silently lost every
      // event past it - the calendar rendered empty.
      const first = Array.from({ length: 1000 }, (_, i) => `a${i}`);
      mockRequest
        .mockResolvedValueOnce({
          methodResponses: [['CalendarEvent/query', { ids: first }, '0']],
        })
        .mockResolvedValueOnce({
          methodResponses: [['CalendarEvent/query', { ids: ['tail-1', 'tail-2'] }, '0']],
        });

      const result = await queryEvents(['cal-1'], '2026-03-01T00:00:00Z', '2026-03-31T23:59:59Z');

      expect(result).toHaveLength(1002);
      expect(result[1001]).toBe('tail-2');
      expect(mockRequest).toHaveBeenCalledTimes(2);
      expect(mockRequest.mock.calls[0][0][0][1].position).toBe(0);
      expect(mockRequest.mock.calls[1][0][0][1].position).toBe(1000);
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

    it('should omit the filter when no calendars are given and window is empty', async () => {
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

    it('normalizes the CalDAV spellings of task progress (calcard#20)', async () => {
      const list = [
        { id: 't1', progress: 'COMPLETED' },
        { id: 't2', progress: 'NEEDS_ACTION' },
        { id: 't3', progress: 'IN_PROCESS' },
        { id: 't4', progress: 'canceled' },
        { id: 't5', progress: 'CANCELLED' },
        { id: 't6', progress: 'needs-action' },
      ];
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/get', { list }, '0']],
      });

      const result = await getEvents(list.map((t) => t.id));
      expect(result.map((t) => t.progress)).toEqual([
        'completed',
        'needs-action',
        'in-process',
        'cancelled',
        'cancelled',
        'needs-action',
      ]);
    });

    it('leaves unknown and non-string task progress untouched', async () => {
      const list = [
        { id: 't1', progress: 'constructor' },
        { id: 't2', progress: '__proto__' },
        { id: 't3', progress: 'failed' },
        { id: 't4', progress: 42 },
        { id: 't5', progress: null },
        { id: 'ev1', title: 'Event' },
      ];
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/get', { list }, '0']],
      });

      const result = await getEvents(list.map((t) => t.id));
      expect(result.map((t) => t.progress as unknown)).toEqual([
        'constructor',
        '__proto__',
        'failed',
        42,
        null,
        undefined,
      ]);
      expect(result[5]).not.toHaveProperty('progress');
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

  describe('findEventsByUid', () => {
    it('queries by uid, whatever the date, and fetches the matches', async () => {
      mockRequest
        .mockResolvedValueOnce({
          methodResponses: [['CalendarEvent/query', { ids: ['ev9'] }, '0']],
        })
        .mockResolvedValueOnce({
          methodResponses: [['CalendarEvent/get', { list: [{ id: 'ev9', uid: 'inv@example.com' }] }, '0']],
        });

      const found = await findEventsByUid('inv@example.com');

      const query = mockRequest.mock.calls[0][0][0];
      expect(query[0]).toBe('CalendarEvent/query');
      expect(query[1]).toEqual({ accountId: 'acc-1', filter: { uid: 'inv@example.com' } });
      expect(mockRequest.mock.calls[1][0][0][1].ids).toEqual(['ev9']);
      expect(found.map((e) => e.id)).toEqual(['ev9']);
    });

    it('returns nothing without a second request when no event matches', async () => {
      mockRequest.mockResolvedValueOnce({
        methodResponses: [['CalendarEvent/query', { ids: [] }, '0']],
      });

      expect(await findEventsByUid('missing@example.com')).toEqual([]);
      expect(mockRequest).toHaveBeenCalledTimes(1);
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
