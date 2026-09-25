import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const h = vi.hoisted(() => ({ session: null as unknown, maxCalls: 16 }));

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    getMaxObjectsInGet: () => 500,
    getMaxCallsInRequest: () => h.maxCalls,
    get currentSession() {
      return h.session;
    },
  },
}));

import { jmapClient } from '../jmap-client';
import { queryExpandedEvents } from '../calendar';
import { useSettingsStore } from '../../stores/settings-store';
import {
  calendarAccountCapability,
  createStalwartCalendarMock,
  expandingQueryAnswer,
  localSeconds,
  tooManyOccurrences,
  type RangeOccurrence,
  type StalwartCalendarMock,
  type StalwartVersion,
} from './stalwart-calendar-mock';

// An expanded range may span at most maxExpandedQueryDuration (the account's
// calendars capability, an iCalendar duration). Stalwart 1.0 enforces it
// with expandDurationTooLarge; every 0.16 advertises 365 days and never
// checks. A longer range goes out in chunks a day shorter than the limit,
// sharing a second at each border. Too many occurrences in one query
// (cannotCalculateOccurrences on 1.0, invalidArguments on 0.16) halve the
// chunk, down to about a week; past that the device expands the range.

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;
const DAY = 86_400;

// 777 days, about the longest window the month view scrolls to.
const WINDOW = { after: '2025-01-01T00:00:00Z', before: '2027-02-16T23:59:59Z' };
const occurrences: RangeOccurrence[] = [
  { id: 'o-first', start: '2025-01-02T09:00:00', seconds: 3600 },
  // Across the first border (2025-12-31T00:00:00): found by both chunks.
  { id: 'o-across', start: '2025-12-30T23:30:00', seconds: 3600 },
  // Zero-length, exactly on that border: only the overlap finds it.
  { id: 'o-border', start: '2025-12-31T00:00:00', seconds: 0 },
  { id: 'o-middle', start: '2026-07-01T09:00:00', seconds: 3600 },
  { id: 'o-late', start: '2027-02-10T09:00:00', seconds: 3600 },
  // Outside the window.
  { id: 'o-after', start: '2027-02-17T09:00:00', seconds: 3600 },
];
const IN_WINDOW = ['o-first', 'o-across', 'o-border', 'o-middle', 'o-late'];

let server: StalwartCalendarMock;

function connect(
  version: StalwartVersion,
  options: {
    maxExpandedQueryDuration?: string | null;
    maxSpanSeconds?: number;
    maxInstances?: number;
    maxCallsInRequest?: number;
    occurrences?: RangeOccurrence[];
  } = {},
): void {
  const capability = calendarAccountCapability(
    version,
    options.maxExpandedQueryDuration === undefined ? 'P52W1D' : options.maxExpandedQueryDuration,
  );
  h.session = { accounts: { 'acc-1': { accountCapabilities: { 'urn:ietf:params:jmap:calendars': capability } } } };
  h.maxCalls = options.maxCallsInRequest ?? 16;
  server = createStalwartCalendarMock({
    version,
    answer: expandingQueryAnswer(version, { seriesId: 'series', occurrences: options.occurrences ?? occurrences, ...options }),
  });
  mockRequest.mockImplementation(server.request);
}

const bounds = () => server.queries().map((q) => {
  const filter = q.args.filter as { after: string; before: string };
  return [filter.after, filter.before];
});
const spansInDays = () => bounds().map(([after, before]) => (localSeconds(before) - localSeconds(after)) / DAY);

beforeEach(() => {
  vi.clearAllMocks();
  // The bounds are LocalDateTimes in the calendar's zone.
  useSettingsStore.setState({ calendarTimeZone: 'UTC' });
});

afterEach(() => {
  useSettingsStore.setState({ calendarTimeZone: 'auto' });
});

describe.each(['P365D', 'P52W1D', 'PT8760H'])('with maxExpandedQueryDuration %s', (duration) => {
  it('splits a 777-day window into three chunks sent in one request on Stalwart 1.0', async () => {
    connect('1.0', { maxExpandedQueryDuration: duration });

    const ids = await queryExpandedEvents(WINDOW.after, WINDOW.before);

    expect(bounds()).toEqual([
      ['2025-01-01T00:00:00', '2025-12-31T00:00:00'],
      ['2025-12-30T23:59:59', '2026-12-29T23:59:59'],
      ['2026-12-29T23:59:58', '2027-02-16T23:59:59'],
    ]);
    for (const days of spansInDays()) expect(days).toBeLessThanOrEqual(364);
    expect(new Set(server.queries().map((q) => q.request)).size).toBe(1);
    // Each query is one FilterCondition, the only form 1.0 expands.
    for (const query of server.queries()) {
      expect(Object.keys(query.args.filter as object).sort()).toEqual(['after', 'before']);
    }
    // Each occurrence once, the border ones included.
    expect(ids?.slice().sort()).toEqual([...IN_WINDOW].sort());
  });
});

describe('expanded ranges longer than maxExpandedQueryDuration', () => {
  it('gets the same occurrences from 0.16, which advertises the limit but does not enforce it', async () => {
    connect('0.16');

    const ids = await queryExpandedEvents(WINDOW.after, WINDOW.before);

    expect(bounds()).toHaveLength(3);
    expect(ids?.slice().sort()).toEqual([...IN_WINDOW].sort());
  });

  it('asks for two chunks for a 365-day window, like a refresh of a year, on Stalwart 1.0', async () => {
    connect('1.0');

    await queryExpandedEvents('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z');

    expect(bounds()).toEqual([
      ['2026-01-01T00:00:00', '2026-12-31T00:00:00'],
      ['2026-12-30T23:59:59', '2027-01-01T00:00:00'],
    ]);
  });

  it('sends a window within the limit as one query on Stalwart 1.0', async () => {
    connect('1.0');

    await queryExpandedEvents('2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z');

    expect(bounds()).toEqual([['2026-09-01T00:00:00', '2026-10-01T00:00:00']]);
  });

  it('halves a chunk the server finds too long on Stalwart 1.0', async () => {
    // The server enforces less than it advertises.
    connect('1.0', { maxSpanSeconds: 200 * DAY });

    const ids = await queryExpandedEvents(WINDOW.after, WINDOW.before);

    // The two 364-day chunks are refused and halved; the 49-day one is not.
    expect(spansInDays().filter((days) => days > 200)).toHaveLength(2);
    expect(spansInDays().filter((days) => days <= 200)).toHaveLength(5);
    expect(ids?.slice().sort()).toEqual([...IN_WINDOW].sort());
  });

  it('splits when refused even without the capability on Stalwart 1.0', async () => {
    connect('1.0', { maxExpandedQueryDuration: null });

    const ids = await queryExpandedEvents(WINDOW.after, WINDOW.before);

    // One query for the whole window, refused; its halves (388.5 days),
    // refused; their halves.
    expect(bounds()[0]).toEqual(['2025-01-01T00:00:00', '2027-02-16T23:59:59']);
    expect(bounds()).toHaveLength(1 + 2 + 4);
    expect(ids?.slice().sort()).toEqual([...IN_WINDOW].sort());
  });

  it.each<[StalwartVersion]>([['0.16'], ['1.0']])(
    'halves chunks that expand to too many occurrences on Stalwart %s',
    async (version) => {
      // Only a chunk holding at most two occurrences is answered.
      connect(version, { maxInstances: 2 });

      const ids = await queryExpandedEvents(WINDOW.after, WINDOW.before);

      expect(server.queries().length).toBeGreaterThan(3);
      expect(ids?.slice().sort()).toEqual([...IN_WINDOW].sort());
    },
  );

  it.each<[StalwartVersion]>([['0.16'], ['1.0']])(
    'leaves the range to the device when even a week expands to too many occurrences on Stalwart %s',
    async (version) => {
      connect(version);
      server = createStalwartCalendarMock({
        version,
        answer: (call) => (call.method === 'CalendarEvent/query' ? ['error', tooManyOccurrences(version)] : undefined),
      });
      mockRequest.mockImplementation(server.request);

      expect(await queryExpandedEvents('2026-09-01T00:00:00Z', '2026-09-30T23:59:59Z')).toBeNull();

      // 30 days, halved to 15, 7.5 and 3.75: a chunk of a week or less that
      // is still refused gives the whole range up.
      const levels = [30, 15, 15, 7.5, 7.5, 7.5, 7.5, ...Array(8).fill(3.75)];
      expect(spansInDays()).toHaveLength(levels.length);
      spansInDays().forEach((days, i) => expect(days).toBeCloseTo(levels[i], 0));
    },
  );

  it('sends as many chunks per request as maxCallsInRequest allows on Stalwart 1.0', async () => {
    connect('1.0', { maxCallsInRequest: 2 });

    await queryExpandedEvents(WINDOW.after, WINDOW.before);

    const [first] = server.queries();
    expect(server.queries().map((q) => q.request)).toEqual([first.request, first.request, first.request + 1]);
  });

  it('pages through a chunk that holds more than one page of occurrences on Stalwart 1.0', async () => {
    const busy: RangeOccurrence[] = Array.from({ length: 1500 }, (_, i) => ({
      id: `busy-${i}`,
      start: new Date(Date.UTC(2025, 0, 2) + i * 3600_000).toISOString().slice(0, 19),
      seconds: 1800,
    }));
    connect('1.0', { occurrences: [...busy, ...occurrences] });

    const ids = await queryExpandedEvents(WINDOW.after, WINDOW.before);

    expect(ids).toHaveLength(1500 + IN_WINDOW.length);
    expect(server.queries().map((q) => q.args.position)).toEqual([0, 0, 0, 1000]);
  });

  it('reports a refusal it cannot split as a failure on Stalwart 1.0', async () => {
    connect('1.0');
    server = createStalwartCalendarMock({
      version: '1.0',
      answer: (call) => (call.method === 'CalendarEvent/query'
        ? ['error', { type: 'invalidArguments', description: 'The filter must be a single FilterCondition when expanding recurrences' }]
        : undefined),
    });
    mockRequest.mockImplementation(server.request);

    await expect(queryExpandedEvents(WINDOW.after, WINDOW.before)).rejects.toThrow(/single FilterCondition/);
    expect(server.queries()).toHaveLength(3);
  });
});
