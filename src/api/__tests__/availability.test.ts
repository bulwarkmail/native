import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    request: vi.fn(),
    hasCapability: vi.fn(),
    session: { accounts: { 'acc-1': {} } },
  },
}));

import { jmapClient } from '../jmap-client';
import { getPrincipalAvailability, createAvailabilityLoader, loadAttendeeAvailability } from '../availability';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;
const mockHas = jmapClient.hasCapability as ReturnType<typeof vi.fn>;
const range = { start: new Date('2026-10-06T00:00:00Z'), end: new Date('2026-10-07T00:00:00Z') };

beforeEach(() => {
  vi.clearAllMocks();
  mockHas.mockReturnValue(true);
});

describe('getPrincipalAvailability', () => {
  it('sends the explicit account, no details, and the availability capability', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['Principal/getAvailability', { list: [
        { utcStart: '2026-10-06T10:00:00Z', utcEnd: '2026-10-06T11:00:00Z', busyStatus: 'confirmed' },
        { utcStart: '2026-10-06T12:00:00Z', utcEnd: '2026-10-06T13:00:00Z' },
      ] }, '0']],
    });
    const out = await getPrincipalAvailability({ accountId: 'acc-1', principalId: 'p1', ...range, gen: 3 });
    const [calls, using, opts] = mockRequest.mock.calls[0];
    expect(calls).toEqual([['Principal/getAvailability', {
      accountId: 'acc-1', id: 'p1', utcStart: '2026-10-06T00:00:00Z', utcEnd: '2026-10-07T00:00:00Z', showDetails: false,
    }, '0']]);
    expect(using).toContain('urn:ietf:params:jmap:principals:availability');
    expect(opts).toEqual({ gen: 3 });
    expect(out).toEqual([
      { utcStart: '2026-10-06T10:00:00Z', utcEnd: '2026-10-06T11:00:00Z', busyStatus: 'confirmed' },
      { utcStart: '2026-10-06T12:00:00Z', utcEnd: '2026-10-06T13:00:00Z', busyStatus: null },
    ]);
  });

  it('throws on a method error', async () => {
    mockRequest.mockResolvedValue({ methodResponses: [['error', { description: 'nope' }, '0']] });
    await expect(getPrincipalAvailability({ accountId: 'acc-1', principalId: 'p1', ...range })).rejects.toThrow('nope');
  });

  it('throws without a request when the server lacks the capability', async () => {
    mockHas.mockReturnValue(false);
    await expect(getPrincipalAvailability({ accountId: 'acc-1', principalId: 'p1', ...range })).rejects.toThrow();
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe('createAvailabilityLoader', () => {
  it('asks once per participant and range, even concurrently, and again for a new range', async () => {
    const fetchOne = vi.fn().mockResolvedValue([]);
    const loader = createAvailabilityLoader(fetchOne);
    await Promise.all([loader.load('p1', range), loader.load('p1', range)]);
    await loader.load('p1', range);
    expect(fetchOne).toHaveBeenCalledTimes(1);
    await loader.load('p1', { start: range.end, end: new Date('2026-10-08T00:00:00Z') });
    await loader.load('p2', range);
    expect(fetchOne).toHaveBeenCalledTimes(3);
  });

  it('reports a failure as unknown (null) and does not retry it', async () => {
    const fetchOne = vi.fn().mockRejectedValue(new Error('boom'));
    const loader = createAvailabilityLoader(fetchOne);
    expect(await loader.load('p1', range)).toBeNull();
    expect(await loader.load('p1', range)).toBeNull();
    expect(fetchOne).toHaveBeenCalledTimes(1);
  });
});

describe('loadAttendeeAvailability', () => {
  const window = { start: new Date('2026-10-06T10:00:00Z'), end: new Date('2026-10-06T11:00:00Z') };
  it('makes no request without a principal and reports free, busy, unknown', async () => {
    const fetchOne = vi.fn(async (id: string) => id === 'p1'
      ? [{ utcStart: '2026-10-06T10:30:00Z', utcEnd: '2026-10-06T12:00:00Z', busyStatus: null }]
      : id === 'p2' ? [] : Promise.reject(new Error('x')));
    const out = await loadAttendeeAvailability({
      emails: ['a@x.com', 'b@x.com', 'ext@y.com', 'bad@x.com'],
      principalIdByEmail: new Map([['a@x.com', 'p1'], ['b@x.com', 'p2'], ['bad@x.com', 'p3']]),
      range, window, loader: createAvailabilityLoader(fetchOne),
    });
    expect(fetchOne).toHaveBeenCalledTimes(3);
    expect(fetchOne.mock.calls.map((c) => c[0]).sort()).toEqual(['p1', 'p2', 'p3']);
    expect(out['a@x.com'].status).toBe('busy');
    expect(out['b@x.com'].status).toBe('free');
    expect(out['ext@y.com'].status).toBe('unknown');
    expect(out['bad@x.com'].status).toBe('unknown');
  });
});
