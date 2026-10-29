import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ session: null as unknown }));

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    getMaxObjectsInGet: () => 500,
    getMaxCallsInRequest: () => 16,
    get currentSession() {
      return h.session;
    },
  },
}));

import { jmapClient } from '../jmap-client';
import { queryEvents, queryExpandedEvents, resetTimeZoneChecks } from '../calendar';
import { useSettingsStore } from '../../stores/settings-store';

// Stalwart 0.16 cannot place a range bound whose wall clock names no instant
// in the request's zone (the hour the clocks skip) or two (the hour they
// repeat): an expanded query fails with "Both 'after' and 'before' filters
// are required when expanding recurrences", a plain one drops the bound
// (live on 0.16.27). Such a bound goes out moved out of the range.

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

function connect(maxExpandedQueryDuration = 'P52W1D'): void {
  h.session = {
    apiUrl: 'https://mail.example.org/jmap/',
    accounts: { 'acc-1': { accountCapabilities: { 'urn:ietf:params:jmap:calendars': { maxExpandedQueryDuration } } } },
  };
  mockRequest.mockImplementation(async (calls: [string, unknown, string][]) => ({
    methodResponses: calls.map(([name, , id]) => [name, { ids: [] }, id]),
  }));
}

const bounds = () => mockRequest.mock.calls.flatMap(([calls]) =>
  (calls as [string, { filter?: Record<string, unknown> }, string][])
    .filter(([name]) => name === 'CalendarEvent/query')
    .map(([, args]) => {
      const filter = args.filter as { after?: string; before?: string; conditions?: { after?: string; before?: string }[] };
      const range = filter.conditions?.find((c) => 'after' in c) ?? filter;
      return [range.after, range.before];
    }));

beforeEach(() => {
  vi.clearAllMocks();
  resetTimeZoneChecks();
});

afterEach(() => {
  useSettingsStore.setState({ calendarTimeZone: 'auto' });
  h.session = null;
});

describe('range bounds next to a change of the clocks', () => {
  // Havana turns the clocks back from 01:00 to 00:00 on 7 November 2027:
  // the week from that Sunday starts at a midnight that happens twice.
  const HAVANA_WEEK = { after: '2027-11-07T04:00:00.000Z', before: '2027-11-14T05:00:00.000Z' };

  it('moves an expanded query\'s start out of the hour that repeats', async () => {
    useSettingsStore.setState({ calendarTimeZone: 'America/Havana' });
    connect();

    await queryExpandedEvents(HAVANA_WEEK.after, HAVANA_WEEK.before);

    expect(bounds()).toEqual([['2027-11-06T23:45:00', '2027-11-14T00:00:00']]);
  });

  it('moves a plain query\'s start out of the hour that repeats', async () => {
    useSettingsStore.setState({ calendarTimeZone: 'America/Havana' });
    connect();

    await queryEvents(['cal-1'], HAVANA_WEEK.after, HAVANA_WEEK.before);

    expect(bounds()).toEqual([['2027-11-06T23:45:00', '2027-11-14T00:00:00']]);
  });

  it('keeps chunk borders out of the hour the clocks skip, still overlapping', async () => {
    // Santiago skips from 00:00 to 01:00 on 5 September 2027. With a limit
    // of two days the chunks are a day long and their borders fall at 00:30.
    useSettingsStore.setState({ calendarTimeZone: 'America/Santiago' });
    connect('P2D');

    await queryExpandedEvents('2027-09-04T04:30:00.000Z', '2027-09-06T04:30:00.000Z');

    expect(bounds()).toEqual([
      ['2027-09-04T00:30:00', '2027-09-05T01:00:00'],
      ['2027-09-04T23:59:59', '2027-09-06T00:29:59'],
      ['2027-09-06T00:29:58', '2027-09-06T01:30:00'],
    ]);
  });

  it('leaves bounds that name one instant as they are', async () => {
    useSettingsStore.setState({ calendarTimeZone: 'Europe/Berlin' });
    connect();

    // Berlin turns the clocks back at 03:00; its midnights are unique.
    await queryExpandedEvents('2027-10-30T22:00:00.000Z', '2027-11-06T23:00:00.000Z');

    expect(bounds()).toEqual([['2027-10-31T00:00:00', '2027-11-07T00:00:00']]);
  });
});
