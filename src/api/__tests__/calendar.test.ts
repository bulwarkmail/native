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
  batchCreateEvents,
  clearCalendarEvents,
  findEventsByUid,
  toLocalDateTime,
  supportsSyntheticCalendarIds,
  resetSyntheticIdSupport,
  queryExpandedEvents,
  hydrateExpandedOccurrences,
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
  resetSyntheticIdSupport();
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
        [
          ['Calendar/get', { accountId: 'acc-1' }, '0'],
          // The synthetic-id probe rides along with the first Calendar/get.
          ['CalendarEvent/set', { accountId: 'acc-1', update: { h333333: {} } }, 'synthetic-id-probe'],
        ],
        expect.arrayContaining(['urn:ietf:params:jmap:calendars']),
      );
    });
  });

  describe('supportsSyntheticCalendarIds', () => {
    it('takes the verdict from the probe that rode along with Calendar/get', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [
          ['Calendar/get', { list: [] }, '0'],
          ['CalendarEvent/set', { notUpdated: { h333333: { type: 'notFound' } } }, 'synthetic-id-probe'],
        ],
      });

      await getCalendars();
      expect(await supportsSyntheticCalendarIds()).toBe(true);
      expect(mockRequest).toHaveBeenCalledTimes(1);

      // Known now: the next Calendar/get goes out alone.
      await getCalendars();
      expect(mockRequest.mock.calls[1][0]).toHaveLength(1);
    });

    it('counts a server that refuses synthetic ids as unsupported', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/set', {
          notUpdated: { h333333: { type: 'invalidProperties', description: 'Updating synthetic ids is not yet supported.' } },
        }, 'synthetic-id-probe']],
      });

      expect(await supportsSyntheticCalendarIds()).toBe(false);
      expect(await supportsSyntheticCalendarIds()).toBe(false);
      expect(mockRequest).toHaveBeenCalledTimes(1);
    });

    it('probes again after a failed request', async () => {
      mockRequest.mockRejectedValueOnce(new Error('offline'));
      expect(await supportsSyntheticCalendarIds()).toBe(false);

      mockRequest.mockResolvedValueOnce({
        methodResponses: [['CalendarEvent/set', { notUpdated: { h333333: { type: 'notFound' } } }, 'synthetic-id-probe']],
      });
      expect(await supportsSyntheticCalendarIds()).toBe(true);
      expect(mockRequest).toHaveBeenCalledTimes(2);
    });
  });

  describe('queryExpandedEvents', () => {
    it('asks the server to expand the range with a filter of the bounds alone', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/query', { ids: ['s1', 's2'] }, '0']],
      });

      expect(await queryExpandedEvents('2026-03-01T00:00:00Z', '2026-04-01T00:00:00Z')).toEqual(['s1', 's2']);
      const args = mockRequest.mock.calls[0][0][0][1];
      expect(args.expandRecurrences).toBe(true);
      expect(Object.keys(args.filter).sort()).toEqual(['after', 'before']);
    });

    it('returns null when the range expands past the server limit', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['error', {
          type: 'invalidArguments',
          description: 'The number of expanded recurrences exceeds the limit of 1000',
        }, '0']],
      });

      expect(await queryExpandedEvents('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')).toBeNull();
    });

    it('throws on any other error', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['error', { type: 'forbidden' }, '0']],
      });

      await expect(queryExpandedEvents('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')).rejects.toThrow('forbidden');
    });
  });

  describe('hydrateExpandedOccurrences', () => {
    it('gives server occurrences their base event\'s rules, overrides and all-day flag', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/get', {
          list: [{
            id: 'base',
            recurrenceRule: { frequency: 'daily' },
            recurrenceOverrides: { '2026-03-03': { title: 'Moved' } },
            showWithoutTime: true,
            timeZone: null,
            duration: 'P1D',
          }],
        }, '0']],
      });
      const occurrence = {
        id: 's1', baseEventId: 'base', recurrenceId: '2026-03-02', start: '2026-03-02T00:00:00',
        timeZone: 'Europe/Berlin', title: 'Daily',
      } as any;
      const single = { id: 's9', baseEventId: 'other', start: '2026-03-02T09:00:00', title: 'Once' } as any;

      const [hydrated, untouched] = await hydrateExpandedOccurrences([occurrence, single]);

      expect(mockRequest.mock.calls[0][0][0][1]).toMatchObject({ ids: ['base'] });
      expect(hydrated).toMatchObject({
        id: 's1',
        recurrenceRules: [{ frequency: 'daily' }],
        recurrenceOverrides: { '2026-03-03': { title: 'Moved' } },
        showWithoutTime: true,
        timeZone: null,
      });
      expect(untouched).toBe(single);
    });

    it('skips the round trip when nothing recurs', async () => {
      const single = { id: 's9', baseEventId: 'other', start: '2026-03-02T09:00:00' } as any;
      expect(await hydrateExpandedOccurrences([single])).toEqual([single]);
      expect(mockRequest).not.toHaveBeenCalled();
    });
  });

  describe('getEvents for expanded occurrences', () => {
    it('asks for the base event id only then', async () => {
      mockRequest.mockResolvedValue({ methodResponses: [['CalendarEvent/get', { list: [] }, '0']] });

      await getEvents(['a'], undefined, { expanded: true });
      await getEvents(['a']);

      expect(mockRequest.mock.calls[0][0][0][1].properties).toContain('baseEventId');
      expect(mockRequest.mock.calls[1][0][0][1].properties).not.toContain('baseEventId');
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

    it('throws when the server refuses to destroy (B24)', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/set', {
          destroyed: [],
          notDestroyed: { ev1: { type: 'forbidden', description: 'read-only calendar' } },
        }, '0']],
      });

      await expect(deleteEvents(['ev1'])).rejects.toThrow(/destroy event ev1.*read-only calendar/);
    });

    it('throws on a method-level error', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['error', { type: 'accountNotFound' }, '0']],
      });

      await expect(deleteEvents(['ev1'])).rejects.toThrow('accountNotFound');
    });
  });

  describe('batchCreateEvents', () => {
    it('reports the refused events by index with the reason', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/set', {
          created: { 'evt-0': { id: 'a' } },
          notCreated: {
            'evt-1': { type: 'invalidProperties', properties: ['participants'] },
            'evt-2': { type: 'forbidden', description: 'UID already exists' },
          },
        }, '0']],
      });

      expect(await batchCreateEvents([{ title: 'A' }, { title: 'B' }, { title: 'C' }], 'cal-1')).toEqual({
        created: 1,
        refused: [
          { index: 1, reason: 'invalidProperties (participants)' },
          { index: 2, reason: 'UID already exists' },
        ],
      });
    });

    it('reports every event when the server refused them all (B24)', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/set', {
          notCreated: { 'evt-0': { type: 'invalidProperties', properties: ['participants'] } },
        }, '0']],
      });

      expect(await batchCreateEvents([{ title: 'A' }], 'cal-1')).toEqual({
        created: 0,
        refused: [{ index: 0, reason: 'invalidProperties (participants)' }],
      });
    });

    it('throws on a method-level error', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['error', { type: 'invalidArguments', description: 'unknown calendar' }, '0']],
      });

      await expect(batchCreateEvents([{ title: 'A' }], 'cal-1')).rejects.toThrow(/unknown calendar/);
    });
  });

  describe('clearCalendarEvents', () => {
    it('throws when the server refuses to destroy the events (B24)', async () => {
      mockRequest
        .mockResolvedValueOnce({ methodResponses: [['CalendarEvent/query', { ids: ['ev1'] }, '0']] })
        .mockResolvedValueOnce({
          methodResponses: [['CalendarEvent/get', { list: [{ id: 'ev1', calendarIds: { 'cal-1': true } }] }, '0']],
        })
        .mockResolvedValueOnce({
          methodResponses: [['CalendarEvent/set', { notDestroyed: { ev1: { type: 'forbidden' } } }, '0']],
        });

      await expect(clearCalendarEvents('cal-1')).rejects.toThrow(/forbidden/);
    });
  });
});
