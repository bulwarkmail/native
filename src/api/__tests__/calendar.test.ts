import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    getMaxObjectsInGet: () => 500,
    getMaxCallsInRequest: () => 16,
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
  resetTimeZoneChecks,
  queryExpandedEvents,
  hydrateExpandedOccurrences,
  maxParticipantsPerEvent,
  rsvpEvent,
  isCalendarAccessDenied,
  resetCalendarAccessDenied,
} from '../calendar';
import { JMAPSetError, jmapErrorType } from '../jmap-result';
import { useSettingsStore } from '../../stores/settings-store';

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

// A stored event is read with a second get for its overrides in the same
// request (Stalwart 1.0 refuses them next to utcStart/utcEnd).
function getAnswer(list: unknown[]) {
  return {
    methodResponses: [
      ['CalendarEvent/get', { list }, '0'],
      ['CalendarEvent/get', { list: [] }, '1'],
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSyntheticIdSupport();
  resetTimeZoneChecks();
  // In UTC the first calendar list carries no time zone check
  // (calendar-time-zone.test.ts covers that).
  useSettingsStore.setState({ calendarTimeZone: 'UTC' });
});

describe('calendar operations', () => {
  describe('getCalendars', () => {
    // Stalwart 1.0 lists an account that shares only a mail folder with the
    // calendars capability and answers its Calendar/get with
    // accountNotSupportedByMethod (0.16: forbidden).
    it.each(['forbidden', 'accountNotSupportedByMethod'])(
      'asks an account that answers %s for its calendars once per session',
      async (type) => {
        const client = jmapClient as unknown as { currentSession?: unknown };
        client.currentSession = {
          accounts: {
            'acc-1': { accountCapabilities: { 'urn:ietf:params:jmap:calendars': {} } },
            'acc-mail': { accountCapabilities: { 'urn:ietf:params:jmap:calendars': {} } },
          },
        };
        try {
          resetCalendarAccessDenied();
          mockRequest.mockImplementation(async (calls: [string, { accountId: string }, string][]) => ({
            methodResponses: calls.map(([name, args, id]) => (args.accountId === 'acc-mail'
              ? ['error', { type }, id]
              : [name, name === 'Calendar/get' ? { list: [] } : {}, id])),
          }));
          await getCalendars();
          await getCalendars();
          const asked = mockRequest.mock.calls.filter(([calls]) =>
            (calls as [string, { accountId: string }][]).some(([, args]) => args.accountId === 'acc-mail'));
          expect(asked).toHaveLength(1);
          expect(isCalendarAccessDenied('acc-mail')).toBe(true);
        } finally {
          client.currentSession = undefined;
          mockRequest.mockReset();
          resetCalendarAccessDenied();
        }
      },
    );

    it('keeps a refusal answered after a new login out of that login\'s memory', async () => {
      const client = jmapClient as unknown as { currentSession?: unknown };
      client.currentSession = {
        accounts: {
          'acc-1': { accountCapabilities: { 'urn:ietf:params:jmap:calendars': {} } },
          'acc-team': { accountCapabilities: { 'urn:ietf:params:jmap:calendars': {} } },
        },
      };
      try {
        resetCalendarAccessDenied();
        mockRequest.mockImplementation(async (calls: [string, { accountId: string }, string][]) => {
          if (calls.some(([, args]) => args.accountId === 'acc-team')) {
            // The previous login was refused; the next one signed in meanwhile.
            resetCalendarAccessDenied();
            return { methodResponses: [['error', { type: 'forbidden' }, '0']] };
          }
          return { methodResponses: calls.map(([name, , id]) => [name, name === 'Calendar/get' ? { list: [] } : {}, id]) };
        });
        await getCalendars();
        expect(isCalendarAccessDenied('acc-team')).toBe(false);
      } finally {
        client.currentSession = undefined;
        mockRequest.mockReset();
        resetCalendarAccessDenied();
      }
    });

    it('should fetch calendars', async () => {
      const calendars = [{ id: 'cal-1', name: 'Personal', color: '#3b82f6' }];
      mockRequest.mockResolvedValue({
        methodResponses: [['Calendar/get', { list: calendars }, '0']],
      });

      const result = await getCalendars();
      expect(result).toEqual(calendars);
      expect(mockRequest).toHaveBeenCalledWith(
        [
          // The properties by name: Stalwart 1.0's unfinished Metadata ones stay out.
          ['Calendar/get', {
            accountId: 'acc-1',
            properties: [
              'id', 'name', 'description', 'color', 'sortOrder', 'isSubscribed', 'isVisible', 'isDefault',
              'myRights', 'shareWith', 'defaultAlertsWithTime', 'defaultAlertsWithoutTime',
            ],
          }, '0'],
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

    it('returns null when even a week expands past the server limit', async () => {
      // Every chunk query of every request is refused (0.16's answer).
      mockRequest.mockImplementation(async (calls: [string, unknown, string][]) => ({
        methodResponses: calls.map(([, , callId]) => ['error', {
          type: 'invalidArguments',
          description: 'The number of expanded recurrences exceeds the limit of 1000',
        }, callId]),
      }));

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
      mockRequest.mockResolvedValue(getAnswer([]));

      await getEvents(['a'], undefined, { expanded: true });
      await getEvents(['a']);

      expect(mockRequest.mock.calls[0][0][0][1].properties).toContain('baseEventId');
      expect(mockRequest.mock.calls[1][0][0][1].properties).not.toContain('baseEventId');
    });

    // Whether the event is its organizer's own copy (0.16 and 1.0 compute it
    // for the event and each expanded occurrence): the owner's meeting in a
    // calendar shared with the user is theirs to change, and Stalwart sends
    // the change from the owner.
    it('asks for isOrigin for stored events and expanded occurrences alike', async () => {
      mockRequest.mockResolvedValue(getAnswer([]));

      await getEvents(['a'], undefined, { expanded: true });
      await getEvents(['a']);

      expect(mockRequest.mock.calls[0][0][0][1].properties).toContain('isOrigin');
      expect(mockRequest.mock.calls[1][0][0][1].properties).toContain('isOrigin');
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
    // #837: Stalwart stores a DTEND equal to DTSTART as no duration and ends
    // the event at 23:59:59 of its start day.
    it('ends a timed event without a duration at its start, and leaves tasks alone', async () => {
      mockRequest.mockResolvedValue(getAnswer([
        { id: 'z', '@type': 'Event', start: '2026-03-02T09:00:00', utcStart: '2026-03-02T08:00:00Z', utcEnd: '2026-03-02T22:59:59Z' },
        { id: 't', '@type': 'Task', start: '2026-03-02T09:00:00', utcStart: '2026-03-02T08:00:00Z', due: '2026-03-03T09:00:00' },
        { id: 'a', '@type': 'Event', start: '2026-03-02T00:00:00', showWithoutTime: true },
      ]));

      const [zero, task, allDay] = await getEvents(['z', 't', 'a']);

      expect(zero).toMatchObject({ duration: 'PT0S', utcEnd: '2026-03-02T08:00:00Z' });
      expect(task).not.toHaveProperty('duration');
      expect(allDay).not.toHaveProperty('duration');
    });

    it('should fetch events by id with singular JSCalendar 2.0 recurrence properties', async () => {
      // Stalwart (calcard) names the property `recurrenceRule` (singular,
      // single object) — requesting the RFC 8984 plural form returns no
      // recurrence data and repeating events vanish from the grid (#13).
      const events = [{ id: 'ev1', title: 'Meeting', start: '2026-03-29T10:00:00' }];
      mockRequest.mockResolvedValue(getAnswer(events));

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
      mockRequest.mockResolvedValue(getAnswer(events));

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
      mockRequest.mockResolvedValue(getAnswer(events));

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
      mockRequest.mockResolvedValue(getAnswer(list));

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
      mockRequest.mockResolvedValue(getAnswer(list));

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

  describe('refusals for the participant limit (Stalwart 1.0)', () => {
    // 1.0 enforces maxParticipantsPerEvent on every create and update, an
    // answer included; 0.16 advertises the limit without enforcing it.
    const refusal = {
      type: 'invalidProperties',
      description: 'An event cannot have more than 20 participants.',
      properties: ['participants'],
    };

    it('keeps the SetError type of a refused create', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/set', { notCreated: { 'new-event': refusal } }, '0']],
      });

      const error = await createEvent({ title: 'All hands' }, 'cal-1').catch((e) => e);

      expect(error).toBeInstanceOf(JMAPSetError);
      expect(jmapErrorType(error)).toBe('invalidProperties');
      expect(error.message).toBe('An event cannot have more than 20 participants.');
      expect(error.properties).toEqual(['participants']);
    });

    it('keeps the SetError type of a refused update and answer', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/set', { notUpdated: { ev1: refusal } }, '0']],
      });

      await expect(updateEvent('ev1', { title: 'All hands' })).rejects.toBeInstanceOf(JMAPSetError);
      const error = await rsvpEvent('ev1', 'me', 'accepted').catch((e) => e);
      expect(error).toBeInstanceOf(JMAPSetError);
      expect(error.message).toBe('An event cannot have more than 20 participants.');
    });
  });

  describe('maxParticipantsPerEvent', () => {
    const session = (calendars: Record<string, unknown>) => ({
      accounts: {
        'acc-1': { accountCapabilities: { 'urn:ietf:params:jmap:calendars': calendars } },
        shared: { accountCapabilities: { 'urn:ietf:params:jmap:calendars': {} } },
      },
    });
    const client = jmapClient as unknown as { isConnected?: boolean; currentSession?: unknown };

    it.each(['0.16.23', '1.0'])('reads the calendars capability of the account, else the primary one (Stalwart %s)', () => {
      client.isConnected = true;
      client.currentSession = session({ maxParticipantsPerEvent: 20 });
      try {
        expect(maxParticipantsPerEvent()).toBe(20);
        expect(maxParticipantsPerEvent('shared')).toBe(20);
        client.currentSession = session({});
        expect(maxParticipantsPerEvent()).toBeNull();
      } finally {
        delete client.isConnected;
        delete client.currentSession;
      }
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

    it('keeps the SetError type and description of a refused update (Stalwart 1.0 override rule)', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['CalendarEvent/set', {
          notUpdated: {
            ev1: {
              type: 'invalidProperties',
              description: 'organizerCalendarAddress cannot be set inside recurrenceOverrides.',
              properties: ['recurrenceOverrides'],
            },
          },
        }, '0']],
      });

      await expect(updateEvent('ev1', { title: 'x' })).rejects.toMatchObject({
        type: 'invalidProperties',
        message: 'organizerCalendarAddress cannot be set inside recurrenceOverrides.',
      });
    });
  });

  describe('findEventsByUid', () => {
    it('queries by uid, whatever the date, and fetches the matches', async () => {
      mockRequest
        .mockResolvedValueOnce({
          methodResponses: [['CalendarEvent/query', { ids: ['ev9'] }, '0']],
        })
        .mockResolvedValueOnce(getAnswer([{ id: 'ev9', uid: 'inv@example.com' }]));

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
