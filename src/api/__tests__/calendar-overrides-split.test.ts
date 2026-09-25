import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    getMaxObjectsInGet: () => 500,
    getMaxCallsInRequest: () => 16,
  },
}));

import { jmapClient } from '../jmap-client';
import { JMAPMethodError } from '../jmap-result';
import {
  findEventsByUid,
  getEventIdentities,
  getEvents,
  hydrateExpandedOccurrences,
  resetSyntheticIdSupport,
} from '../calendar';
import {
  OVERRIDES_WITH_UTC_ERROR,
  asksForOverridesWithUtc,
  createStalwartCalendarMock,
  type StalwartCalendarMock,
  type StalwartVersion,
} from './stalwart-calendar-mock';

// Stalwart 1.0 fails a CalendarEvent/get that asks for recurrenceOverrides
// together with utcStart or utcEnd - the whole call, before any id is read.
// Every get the app sends must keep them apart: a stored event gets its
// overrides from a second get in the same request, a server-expanded
// occurrence from its base event. 0.16 accepts either, and must get the same
// events back as before.

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

const SERIES = {
  id: 'b', '@type': 'Event', uid: 'series@example.com', title: 'Daily standup', baseEventId: 'b',
  start: '2026-09-07T10:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin',
  utcStart: '2026-09-07T08:00:00Z', utcEnd: '2026-09-07T09:00:00Z', showWithoutTime: false,
  recurrenceRule: { frequency: 'daily', count: 5 },
  recurrenceOverrides: { '2026-09-10T10:00:00': { excluded: true } },
  participants: { org: { '@type': 'Participant', calendarAddress: 'mailto:org@example.com', roles: { owner: true } } },
  calendarIds: { cal: true },
};
const SINGLE = {
  id: 'd', '@type': 'Event', uid: 'single@example.com', title: 'One off', baseEventId: 'd',
  start: '2026-09-08T09:00:00', duration: 'PT30M', timeZone: 'Europe/Berlin',
  utcStart: '2026-09-08T07:00:00Z', utcEnd: '2026-09-08T07:30:00Z', calendarIds: { other: true },
};
const OCCURRENCE = {
  ...SERIES, id: 'maaaaab', baseEventId: 'b', recurrenceRule: null, recurrenceOverrides: null,
  start: '2026-09-08T10:00:00', utcStart: '2026-09-08T08:00:00Z', utcEnd: '2026-09-08T09:00:00Z',
  recurrenceId: '2026-09-08T10:00:00', recurrenceIdTimeZone: 'Europe/Berlin',
};

describe.each<StalwartVersion>(['0.16', '1.0'])('calendar reads on Stalwart %s', (version) => {
  let server: StalwartCalendarMock;

  beforeEach(() => {
    vi.clearAllMocks();
    resetSyntheticIdSupport();
    server = createStalwartCalendarMock({
      version,
      objects: { b: SERIES, d: SINGLE },
      occurrences: { maaaaab: OCCURRENCE },
    });
    mockRequest.mockImplementation(server.request);
  });

  afterEach(() => {
    // The invariant: no get ever asks for both.
    expect(server.gets().filter((call) => asksForOverridesWithUtc(call.args))).toEqual([]);
  });

  it(`reads a stored event with its overrides from a second get in the same request on Stalwart ${version}`, async () => {
    const [series] = await getEvents(['b']);

    expect(series.utcStart).toBe('2026-09-07T08:00:00Z');
    expect(series.recurrenceRules).toEqual([{ frequency: 'daily', count: 5 }]);
    expect(series.recurrenceOverrides).toEqual({ '2026-09-10T10:00:00': { excluded: true } });
    const [main, overrides] = server.gets();
    expect(main.args.properties).toContain('utcStart');
    expect(main.args.properties).not.toContain('recurrenceOverrides');
    expect(overrides.args).toMatchObject({ ids: ['b'], properties: ['id', 'recurrenceOverrides'] });
    expect(overrides.request).toBe(main.request);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it(`never asks for overrides of server-expanded occurrences on Stalwart ${version}`, async () => {
    const [occurrence] = await getEvents(['maaaaab'], undefined, { expanded: true });

    expect(occurrence.utcStart).toBe('2026-09-08T08:00:00Z');
    expect(server.gets()).toHaveLength(1);
    expect(server.gets()[0].args.properties).toEqual(expect.arrayContaining(['baseEventId', 'recurrenceIdTimeZone']));
    expect(server.gets()[0].args.properties).not.toContain('recurrenceOverrides');
  });

  it(`gives an expanded occurrence its series' overrides from a get without utc* on Stalwart ${version}`, async () => {
    const occurrences = await getEvents(['maaaaab'], undefined, { expanded: true });
    const [hydrated] = await hydrateExpandedOccurrences(occurrences);

    expect(hydrated.recurrenceOverrides).toEqual({ '2026-09-10T10:00:00': { excluded: true } });
    expect(hydrated.recurrenceRules).toEqual([{ frequency: 'daily', count: 5 }]);
    const hydration = server.gets()[1];
    expect(hydration.args.ids).toEqual(['b']);
    expect(hydration.args.properties).not.toContain('utcStart');
    // The series' title, place and description fill reply stubs.
    expect(hydration.args.properties).toEqual(expect.arrayContaining(['title', 'locations', 'description']));
  });

  it(`finds an invitation outside the loaded window by UID on Stalwart ${version}`, async () => {
    const [found] = await findEventsByUid('series@example.com');

    expect(found.id).toBe('b');
    expect(found.participants?.org.calendarAddress).toBe('mailto:org@example.com');
    expect(found.recurrenceOverrides).toEqual({ '2026-09-10T10:00:00': { excluded: true } });
  });

  it(`reads only ids, UIDs and calendars for a UID look-up, in one get, on Stalwart ${version}`, async () => {
    const identities = await getEventIdentities(['b', 'd']);

    expect(identities).toEqual([
      { id: 'b', uid: 'series@example.com', calendarIds: { cal: true } },
      { id: 'd', uid: 'single@example.com', calendarIds: { other: true } },
    ]);
    expect(server.gets()).toHaveLength(1);
    expect(server.gets()[0].args.properties).toEqual(['id', 'uid', 'calendarIds']);
    expect(await getEventIdentities([])).toEqual([]);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it(`reads every batch of maxObjectsInGet with its own overrides on Stalwart ${version}`, async () => {
    const many = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`e${i}`, {
      ...SINGLE, id: `e${i}`, uid: `e${i}@example.com`,
      recurrenceOverrides: i === 500 ? { '2026-09-09T09:00:00': { title: 'Last' } } : null,
    }]));
    server = createStalwartCalendarMock({ version, objects: many });
    mockRequest.mockImplementation(server.request);

    const events = await getEvents(Object.keys(many));

    expect(events).toHaveLength(501);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(events[500].recurrenceOverrides).toEqual({ '2026-09-09T09:00:00': { title: 'Last' } });
  });
});

describe('a refused calendar read', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fails the read instead of passing an error answer for no events on Stalwart 1.0', async () => {
    // What every read got on 1.0 before the split.
    mockRequest.mockResolvedValue({ methodResponses: [['error', { ...OVERRIDES_WITH_UTC_ERROR }, '0']] });

    const failure = getEvents(['b']);
    await expect(failure).rejects.toBeInstanceOf(JMAPMethodError);
    await expect(failure).rejects.toMatchObject({ type: 'invalidArguments', message: OVERRIDES_WITH_UTC_ERROR.description });
  });

  it('fails the read when only the overrides get is refused on Stalwart 1.0', async () => {
    const server = createStalwartCalendarMock({
      version: '1.0',
      objects: { b: SERIES },
      answer: (call) => (call.callId === '1' ? ['error', { type: 'serverFail' }] : undefined),
    });
    mockRequest.mockImplementation(server.request);

    await expect(getEvents(['b'])).rejects.toMatchObject({ type: 'serverFail' });
  });

  it('fails the read when the server leaves the overrides get unanswered', async () => {
    mockRequest.mockResolvedValue({ methodResponses: [['CalendarEvent/get', { list: [SERIES] }, '0']] });

    await expect(getEvents(['b'])).rejects.toMatchObject({ type: 'missingResponse' });
  });
});
