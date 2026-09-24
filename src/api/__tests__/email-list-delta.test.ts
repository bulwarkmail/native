import { describe, it, expect, vi, beforeEach } from 'vitest';

// PF7: the incremental refresh was Email/queryChanges, then Email/changes,
// then Email/get, then Thread/get, one round trip each.

vi.mock('../jmap-client', () => ({
  jmapClient: { accountId: 'acc-1', request: vi.fn() },
}));

import { jmapClient } from '../jmap-client';
import { getEmailListDelta } from '../email';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;
const sort = [{ property: 'receivedAt', isAscending: false }];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getEmailListDelta', () => {
  it('asks for the query diff, the Email changes, the added rows and their threads in one request', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [
        ['Email/queryChanges', {
          oldQueryState: 'q-1', newQueryState: 'q-2', total: 7,
          removed: ['e2'], added: [{ id: 'n1', index: 0 }],
        }, 'qc'],
        ['Email/changes', {
          oldState: 's-1', newState: 's-2', hasMoreChanges: false,
          created: ['n1'], updated: ['e2'], destroyed: [],
        }, 'ch'],
        ['Email/get', { state: 's-2', list: [{ id: 'n1', threadId: 't1' }] }, 'get'],
        ['Thread/get', { list: [{ id: 't1', emailIds: ['x', 'n1'] }] }, 'th'],
      ],
    });

    const delta = await getEmailListDelta('mb-1', 'q-1', 's-1', { sort, threads: true });

    expect(mockRequest).toHaveBeenCalledTimes(1);
    const [calls] = mockRequest.mock.calls[0];
    expect(calls).toEqual([
      ['Email/queryChanges', {
        accountId: 'acc-1', filter: { inMailbox: 'mb-1' }, sort, sinceQueryState: 'q-1', calculateTotal: true,
      }, 'qc'],
      ['Email/changes', { accountId: 'acc-1', sinceState: 's-1' }, 'ch'],
      ['Email/get', expect.objectContaining({
        accountId: 'acc-1',
        '#ids': { resultOf: 'qc', name: 'Email/queryChanges', path: '/added/*/id' },
      }), 'get'],
      ['Thread/get', {
        accountId: 'acc-1',
        '#ids': { resultOf: 'get', name: 'Email/get', path: '/list/*/threadId' },
      }, 'th'],
    ]);
    expect(delta).toEqual({
      queryChanges: { oldQueryState: 'q-1', newQueryState: 'q-2', total: 7, removed: ['e2'], added: [{ id: 'n1', index: 0 }] },
      changes: { oldState: 's-1', newState: 's-2', hasMoreChanges: false, created: ['n1'], updated: ['e2'], destroyed: [] },
      added: [{ id: 'n1', threadId: 't1' }],
      addedFetched: true,
      threads: [{ id: 't1', emailIds: ['x', 'n1'] }],
    });
  });

  it('targets a shared folder\'s account and leaves Thread/get out without threading', async () => {
    mockRequest.mockResolvedValue({ methodResponses: [] });
    await getEmailListDelta('s-inbox', 'q-1', 's-1', { accountId: 'grp-1' });
    const [calls] = mockRequest.mock.calls[0];
    expect(calls.map((c: [string]) => c[0])).toEqual(['Email/queryChanges', 'Email/changes', 'Email/get']);
    expect(calls.every((c: [string, { accountId: string }]) => c[1].accountId === 'grp-1')).toBe(true);
  });

  it('reports each part that failed on its own', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [
        ['error', { type: 'cannotCalculateChanges' }, 'qc'],
        ['Email/changes', { oldState: 's-1', newState: 's-2', created: [], updated: [], destroyed: [] }, 'ch'],
        ['error', { type: 'invalidResultReference' }, 'get'],
      ],
    });

    const delta = await getEmailListDelta('mb-1', 'q-1', 's-1');

    expect(delta.queryChanges).toBeNull();
    expect(delta.changes?.newState).toBe('s-2');
    expect(delta.addedFetched).toBe(false);

    mockRequest.mockResolvedValue({
      methodResponses: [
        ['Email/queryChanges', { newQueryState: 'q-2', added: [{ id: 'n1', index: 0 }] }, 'qc'],
        ['error', { type: 'cannotCalculateChanges' }, 'ch'],
        ['error', { type: 'requestTooLarge' }, 'get'],
      ],
    });
    const second = await getEmailListDelta('mb-1', 'q-1', 's-1');
    expect(second.queryChanges?.added).toEqual([{ id: 'n1', index: 0 }]);
    expect(second.changes).toBeNull();
    expect(second.addedFetched).toBe(false);
  });
});
