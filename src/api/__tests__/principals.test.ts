import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    hasCapability: vi.fn(),
    getMaxObjectsInGet: vi.fn(() => 500),
  },
}));

import { jmapClient } from '../jmap-client';
import { getPrincipals } from '../principals';
import { getPrincipals as getPrincipalsFromFiles } from '../files';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;
const mockHasCapability = jmapClient.hasCapability as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockHasCapability.mockReturnValue(true);
});

describe('principals loader', () => {
  it('is the same function Files uses', () => {
    expect(getPrincipalsFromFiles).toBe(getPrincipals);
  });

  it('returns email and description and queries the Principal capability', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [
        ['Principal/query', { ids: ['p1'] }, '0'],
        ['Principal/get', { list: [{ id: 'p1', name: 'dana', type: 'individual', email: 'dana@x.com', description: 'Dana D' }] }, '1'],
      ],
    });
    const list = await getPrincipals();
    expect(list).toEqual([{ id: 'p1', name: 'dana', type: 'individual', email: 'dana@x.com', description: 'Dana D' }]);
    expect(mockRequest.mock.calls[0][1]).toContain('urn:ietf:params:jmap:principals');
  });

  it('returns empty without the principals capability', async () => {
    mockHasCapability.mockReturnValue(false);
    expect(await getPrincipals()).toEqual([]);
    expect(mockRequest).not.toHaveBeenCalled();
  });
});
