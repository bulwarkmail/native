import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'u',
    request: vi.fn(),
    currentSession: { apiUrl: 'https://mail.example/jmap/' } as unknown,
    hasCapability: vi.fn(() => true),
    getAccountCapability: vi.fn(() => ({ currentUserPrincipalId: 'u' })),
    getMaxCallsInRequest: vi.fn(() => 16),
  },
}));

vi.mock('../files', () => ({
  listPrincipals: vi.fn(),
}));

import { jmapClient } from '../jmap-client';
import { listPrincipals } from '../files';
import {
  checkAvailabilityAccess,
  getPrincipalsAvailability,
  lookUpAvailabilityStatuses,
  mayGetAvailability,
  resetAvailabilityCaches,
  supportsAvailability,
} from '../calendar-availability';
import { editorAvailabilityWindow, availabilityFor } from '../../lib/calendar-free-busy';

// Ported from the webmail's lib/jmap/__tests__/free-busy.test.ts and the
// availability cases of components/calendar/__tests__/participant-availability.test.tsx.

type Call = [string, Record<string, unknown>, string];
const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;
const mockHasCapability = jmapClient.hasCapability as ReturnType<typeof vi.fn>;
const mockMaxCalls = jmapClient.getMaxCallsInRequest as ReturnType<typeof vi.fn>;
const mockListPrincipals = listPrincipals as ReturnType<typeof vi.fn>;

const DIRECTORY = {
  status: 'ok',
  principals: [
    { id: 'a', type: 'individual', name: 'Alice', email: 'alice@example.org' },
    { id: 'b', type: 'individual', name: 'Bob', email: 'Bob@example.org' },
    { id: 'c', type: 'individual', name: 'Carol', email: 'carol@example.org' },
  ],
};

// The busy periods each principal has on the server.
let busy: Record<string, Array<{ utcStart: string; utcEnd: string; busyStatus?: string }>> = {};
let refuse: Record<string, string> = {};

function answerAvailability(calls: Call[]) {
  return {
    methodResponses: calls.map(([method, args, id]) => {
      if (method !== 'Principal/getAvailability') return ['error', { type: 'unknownMethod' }, id];
      const pid = args.id as string;
      if (refuse[pid]) return ['error', { type: refuse[pid] }, id];
      return ['Principal/getAvailability', { list: busy[pid] ?? [] }, id];
    }),
  };
}

const start = new Date('2027-03-10T09:00:00Z');
const end = new Date('2027-03-10T10:00:00Z');

beforeEach(() => {
  resetAvailabilityCaches();
  mockRequest.mockReset();
  mockRequest.mockImplementation(async (calls: Call[]) => answerAvailability(calls));
  mockHasCapability.mockImplementation(() => true);
  mockMaxCalls.mockReturnValue(16);
  mockListPrincipals.mockReset();
  mockListPrincipals.mockResolvedValue(DIRECTORY);
  busy = {};
  refuse = {};
});

describe('free/busy statuses of the invited attendees', () => {
  it('tells busy, tentative, free, no busy times and outside users apart', async () => {
    busy = {
      a: [{ utcStart: '2027-03-10T09:30:00Z', utcEnd: '2027-03-10T11:00:00Z', busyStatus: 'confirmed' }],
      b: [{ utcStart: '2027-03-10T08:00:00Z', utcEnd: '2027-03-10T09:15:00Z', busyStatus: 'tentative' }],
      // Busy only after the event: free for its window.
      c: [{ utcStart: '2027-03-10T10:00:00Z', utcEnd: '2027-03-10T11:00:00Z' }],
    };
    const statuses = await lookUpAvailabilityStatuses(
      ['alice@example.org', 'bob@example.org', 'carol@example.org', 'dave@elsewhere.net'],
      start,
      end,
    );
    expect(statuses).toEqual({
      'alice@example.org': 'busy',
      'bob@example.org': 'tentative',
      'carol@example.org': 'free',
      'dave@elsewhere.net': 'unknown',
    });
  });

  it('says no busy times rather than available for an empty answer', async () => {
    const statuses = await lookUpAvailabilityStatuses(['alice@example.org'], start, end);
    expect(statuses).toEqual({ 'alice@example.org': 'no_busy_times' });
  });

  it('asks for the whole local days, without event details, and in one request', async () => {
    await lookUpAvailabilityStatuses(['alice@example.org', 'bob@example.org'], start, end);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    const [calls, using] = mockRequest.mock.calls[0] as [Call[], string[]];
    expect(using).toContain('urn:ietf:params:jmap:principals:availability');
    expect(calls.map((c) => c[1].id)).toEqual(['a', 'b']);
    for (const [, args] of calls) {
      expect(args.showDetails).toBe(false);
      expect(args.utcStart).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
      expect(new Date(args.utcStart as string).getTime()).toBeLessThanOrEqual(start.getTime());
      expect(new Date(args.utcEnd as string).getTime()).toBeGreaterThanOrEqual(end.getTime());
    }
  });

  it('answers a move within the same day from the cache', async () => {
    await lookUpAvailabilityStatuses(['alice@example.org'], start, end);
    await lookUpAvailabilityStatuses(['alice@example.org'], new Date('2027-03-10T13:00:00Z'), new Date('2027-03-10T14:00:00Z'));
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('splits the lookups across requests by maxCallsInRequest', async () => {
    mockMaxCalls.mockReturnValue(2);
    const result = await getPrincipalsAvailability(['a', 'b', 'c'], start, end);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(Object.keys(result)).toEqual(['a', 'b', 'c']);
  });

  it('stops asking for a minute after the server rate-limits', async () => {
    refuse = { a: 'rateLimit' };
    expect(await lookUpAvailabilityStatuses(['alice@example.org'], start, end)).toEqual({ 'alice@example.org': 'error' });
    refuse = {};
    expect(await lookUpAvailabilityStatuses(['alice@example.org'], start, end)).toEqual({ 'alice@example.org': 'error' });
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('gives up on free/busy when Stalwart 1.0 has directory queries off', async () => {
    mockListPrincipals.mockResolvedValue({ status: 'restricted', directoryQueriesOff: true, principals: [] });
    expect(await lookUpAvailabilityStatuses(['alice@example.org'], start, end)).toBeNull();
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('gives up on free/busy when a lookup is refused as forbidden', async () => {
    refuse = { a: 'forbidden' };
    expect(await lookUpAvailabilityStatuses(['alice@example.org'], start, end)).toBeNull();
  });

  it('cannot call an address unknown when the directory listing was incomplete', async () => {
    mockListPrincipals.mockResolvedValue({ status: 'error', principals: DIRECTORY.principals.slice(0, 1) });
    expect(await lookUpAvailabilityStatuses(['zed@example.org'], start, end)).toEqual({ 'zed@example.org': 'error' });
  });

  it('counts a failed request as unknown, never as available', async () => {
    mockRequest.mockRejectedValue(new Error('offline'));
    expect(await lookUpAvailabilityStatuses(['alice@example.org'], start, end)).toEqual({ 'alice@example.org': 'error' });
  });
});

describe('whether free/busy is offered', () => {
  it('needs the principals:availability capability', () => {
    mockHasCapability.mockImplementation((urn: string) => urn !== 'urn:ietf:params:jmap:principals:availability');
    expect(supportsAvailability()).toBe(false);
  });

  it('reads mayGetAvailability from the user\'s own principal (1.0)', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['Principal/get', {
        list: [{ id: 'u', capabilities: { 'urn:ietf:params:jmap:calendars': { mayGetAvailability: false } } }],
      }, '0']],
    });
    expect(await mayGetAvailability()).toBe(false);
  });

  it('goes ahead on an empty calendars capability (0.16)', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['Principal/get', { list: [{ id: 'u', capabilities: { 'urn:ietf:params:jmap:calendars': {} } }] }, '0']],
    });
    expect(await mayGetAvailability()).toBe(true);
  });

  it('asks once per session', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['Principal/get', { list: [{ id: 'u', capabilities: {} }] }, '0']],
    });
    await Promise.all([checkAvailabilityAccess(), checkAvailabilityAccess()]);
    await checkAvailabilityAccess();
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });
});

describe('the event window of the editor', () => {
  it('spans the whole days of an all-day event, its inclusive last day included', () => {
    const window = editorAvailabilityWindow({
      allDay: true,
      start: new Date(2027, 2, 10, 15, 0),
      end: new Date(2027, 2, 11, 15, 0),
    })!;
    expect(window.end.getTime() - window.start.getTime()).toBe(2 * 86_400_000 - 1000);
  });

  it('has no window while the end is before the start', () => {
    expect(editorAvailabilityWindow({ allDay: false, start: new Date(2027, 2, 10, 10), end: new Date(2027, 2, 10, 9) })).toBeNull();
  });

  it('lets an unavailable overlap win over a tentative one', () => {
    expect(availabilityFor([
      { utcStart: '2027-03-10T09:00:00Z', utcEnd: '2027-03-10T09:30:00Z', busyStatus: 'tentative' },
      { utcStart: '2027-03-10T09:30:00Z', utcEnd: '2027-03-10T10:00:00Z', busyStatus: 'unavailable' },
    ], start, end)).toBe('busy');
  });
});
