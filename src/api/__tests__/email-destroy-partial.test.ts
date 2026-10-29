import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    getMaxObjectsInGet: vi.fn(() => 500),
    getMaxObjectsInSet: vi.fn(() => 2),
  },
}));

import { jmapClient } from '../jmap-client';
import { destroyEmails } from '../email';
import { failedIdsOf } from '../jmap-result';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('destroyEmails', () => {
  it('sends every slice and names only the refused messages', async () => {
    mockRequest.mockImplementation(async ([[, args]]: Array<[string, { destroy: string[] }, string]>) => {
      const refused: string[] = args.destroy.filter((id) => id === 'e2');
      const gone: string[] = args.destroy.filter((id) => id === 'e4');
      return {
        methodResponses: [['Email/set', {
          destroyed: args.destroy.filter((id) => !refused.includes(id) && !gone.includes(id)),
          notDestroyed: Object.fromEntries([
            ...refused.map((id) => [id, { type: 'forbidden' }]),
            ...gone.map((id) => [id, { type: 'notFound' }]),
          ]),
        }, '0']],
      };
    });
    const err = await destroyEmails(['e1', 'e2', 'e3', 'e4']).then(() => null, (e: unknown) => e);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    // A message that is already gone counts as deleted.
    expect(failedIdsOf(err)).toEqual(['e2']);
  });
});
