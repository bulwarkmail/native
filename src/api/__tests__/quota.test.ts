import { describe, it, expect, vi } from 'vitest';

// Storage usage counted against hardLimit even where the server set a lower
// softLimit, from which writes already fail (RFC 9425 4.1, webmail #1242).

const quotas: Record<string, unknown>[] = [];
vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'a1',
    currentSession: { capabilities: { 'urn:ietf:params:jmap:quota': {} } },
    request: vi.fn(async () => ({ methodResponses: [['Quota/get', { list: quotas }, '0']] })),
  },
}));

import { fetchMailQuota, toMailQuota } from '../quota';

describe('mail quota', () => {
  it('counts against softLimit when it is below hardLimit (#1242)', async () => {
    quotas.splice(0, quotas.length, {
      id: 'q', resourceType: 'octets', scope: 'account', used: 900, softLimit: 1000, hardLimit: 1200, warnLimit: 800,
    });
    await expect(fetchMailQuota()).resolves.toEqual({ used: 900, total: 1000, hardLimit: 1200, warnAt: 800 });
  });

  it('keeps hardLimit when there is no lower softLimit', () => {
    expect(toMailQuota([{ id: 'q', resourceType: 'octets', used: 1, hardLimit: 10, softLimit: null }])).toEqual({ used: 1, total: 10 });
    expect(toMailQuota([{ id: 'q', resourceType: 'octets', used: 1, hardLimit: 10, softLimit: 20 }])).toEqual({ used: 1, total: 10 });
    expect(toMailQuota([{ id: 'q', resourceType: 'mail', used: 1, limit: 5 }])).toEqual({ used: 1, total: 5 });
  });
});
