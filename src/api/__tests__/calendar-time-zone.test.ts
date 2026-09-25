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
import {
  getCalendars,
  getEvents,
  queryEvents,
  queryExpandedEvents,
  resetSyntheticIdSupport,
  resetTimeZoneChecks,
} from '../calendar';
import { useSettingsStore } from '../../stores/settings-store';
import {
  createStalwartCalendarMock,
  type StalwartCalendarMock,
  type StalwartVersion,
} from './stalwart-calendar-mock';

// Stalwart 1.0 fails every CalendarEvent/get and /query whose `timeZone` its
// time zone database lacks: invalidArguments "Invalid timeZone \"X\""
// (jmap-proto/src/object/calendar_event.rs). It matches IANA names
// case-sensitively and knows no offsets, so a zone the phone's Intl accepts
// can be refused. 0.16 reads such a zone as UTC, so the calendar kept
// working there; on 1.0 it would show nothing but an error.

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;
// Intl accepts it; Stalwart 1.0 does not.
const ODD_ZONE = 'europe/berlin';

const SINGLE = {
  id: 'd', '@type': 'Event', uid: 'single@example.com', title: 'One off',
  start: '2026-09-01T09:00:00', duration: 'PT30M', calendarIds: { cal: true },
};

let server: StalwartCalendarMock;
let warn: ReturnType<typeof vi.spyOn>;

function serve(version: StalwartVersion): void {
  server = createStalwartCalendarMock({ version, objects: { d: SINGLE }, unknownTimeZones: [ODD_ZONE] });
  mockRequest.mockImplementation(server.request);
}

const zonesOf = (calls: { args: Record<string, unknown> }[]) => calls.map((call) => call.args.timeZone);
const reads = () => server.calls.filter((call) => call.callId !== 'time-zone-probe'
  && (call.method === 'CalendarEvent/get' || call.method === 'CalendarEvent/query'));

beforeEach(() => {
  vi.clearAllMocks();
  resetSyntheticIdSupport();
  resetTimeZoneChecks();
  useSettingsStore.setState({ calendarTimeZone: ODD_ZONE });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  useSettingsStore.setState({ calendarTimeZone: 'auto' });
  warn.mockRestore();
});

describe('a time zone Stalwart 1.0 does not know', () => {
  it('is checked with the first calendar list, and reads ask in UTC from then on, on Stalwart 1.0', async () => {
    serve('1.0');

    await getCalendars();
    const [first] = mockRequest.mock.calls[0];
    expect(first).toContainEqual(['CalendarEvent/get', { accountId: 'acc-1', ids: [], properties: ['id'], timeZone: ODD_ZONE }, 'time-zone-probe']);

    const ids = await queryEvents(['cal'], '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z');
    const events = await getEvents(ids);

    expect(events.map((e) => e.id)).toEqual(['d']);
    expect(zonesOf(reads())).toEqual(['UTC', 'UTC', 'UTC']);
    // The bounds are UTC wall clocks now, the same instants.
    expect((server.queries()[0].args.filter as { conditions: Record<string, string>[] }).conditions[1])
      .toEqual({ after: '2026-09-01T00:00:00', before: '2026-09-02T00:00:00' });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('repeats a read refused before any check, once, in UTC, and remembers it on Stalwart 1.0', async () => {
    serve('1.0');

    expect(await queryEvents(['cal'], '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z')).toEqual(['d']);
    expect(zonesOf(server.queries())).toEqual([ODD_ZONE, 'UTC']);

    await queryEvents(['cal'], '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z');
    expect(zonesOf(server.queries())).toEqual([ODD_ZONE, 'UTC', 'UTC']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('expands a range in UTC after a refusal on Stalwart 1.0', async () => {
    serve('1.0');

    await queryExpandedEvents('2026-09-01T00:00:00Z', '2026-09-30T00:00:00Z');

    const [refused, repeated] = server.queries();
    expect(refused.args.timeZone).toBe(ODD_ZONE);
    expect(repeated.args).toMatchObject({
      timeZone: 'UTC',
      filter: { after: '2026-09-01T00:00:00', before: '2026-09-30T00:00:00' },
    });
  });

  it('keeps asking in the zone on 0.16, which reads an unknown zone as UTC', async () => {
    serve('0.16');

    await getCalendars();
    await getEvents(await queryEvents(['cal'], '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z'));

    expect(zonesOf(reads())).toEqual([ODD_ZONE, ODD_ZONE, ODD_ZONE]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps a zone Stalwart 1.0 knows', async () => {
    useSettingsStore.setState({ calendarTimeZone: 'Europe/Berlin' });
    serve('1.0');

    await getCalendars();
    await queryEvents(['cal'], '2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z');

    expect(zonesOf(reads())).toEqual(['Europe/Berlin']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('checks the zone again after a calendar list that failed on Stalwart 1.0', async () => {
    serve('1.0');
    mockRequest.mockRejectedValueOnce(new Error('Network request failed'));

    await expect(getCalendars()).rejects.toThrow('Network request failed');
    await getCalendars();

    expect(mockRequest.mock.calls[1][0].some((call: [string, unknown, string]) => call[2] === 'time-zone-probe')).toBe(true);
  });

  it('sends no check for UTC', async () => {
    useSettingsStore.setState({ calendarTimeZone: 'UTC' });
    serve('1.0');

    await getCalendars();

    expect(mockRequest.mock.calls[0][0].some((call: [string, unknown, string]) => call[2] === 'time-zone-probe')).toBe(false);
  });
});
