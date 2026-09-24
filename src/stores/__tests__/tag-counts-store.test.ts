import { describe, it, expect, vi, beforeEach } from 'vitest';

// PF6: every drawer open sent 14 Email/query calls for the tag badges, even
// when nothing had changed. The counts are now cached and fetched again only
// after an Email change was reported.

vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    accountId: 'c',
    getMaxCallsInRequest: () => 16,
    request: vi.fn(async (calls: Array<[string, Record<string, unknown>, string]>) => ({
      methodResponses: calls.map(([name, args, callId]) => [
        name,
        { ids: [], total: 'operator' in (args.filter as object) ? 1 : 3 },
        callId,
      ]),
    })),
  },
}));

import { jmapClient } from '../../api/jmap-client';
import { useTagCountsStore } from '../tag-counts-store';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;
const TAGS = ['red', 'blue', 'green', 'work', 'home', 'todo', 'later'];

beforeEach(() => {
  mockRequest.mockClear();
  useTagCountsStore.setState({ counts: {}, login: null, key: null, generation: 0, fetchedAt: -1 });
});

describe('tag counts cache (PF6)', () => {
  it('fetches the 7 tags in one request, then serves the cache', async () => {
    const { ensure } = useTagCountsStore.getState();
    await ensure('me', TAGS, [undefined]);

    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest.mock.calls[0][0]).toHaveLength(14);
    expect(useTagCountsStore.getState().counts.red).toEqual({ id: 'red', total: 3, unread: 1 });

    // The drawer opens again: nothing changed, nothing is sent.
    await ensure('me', TAGS, [undefined]);
    await ensure('me', TAGS, [undefined]);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('fetches again after an Email change', async () => {
    const { ensure, invalidate } = useTagCountsStore.getState();
    await ensure('me', TAGS, [undefined]);
    invalidate();
    await ensure('me', TAGS, [undefined]);
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('shares one request between overlapping opens', async () => {
    const { ensure } = useTagCountsStore.getState();
    await Promise.all([ensure('me', TAGS, [undefined]), ensure('me', TAGS, [undefined])]);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('stays stale when a change lands while the counts are in flight', async () => {
    const { ensure, invalidate } = useTagCountsStore.getState();
    const first = ensure('me', TAGS, [undefined]);
    invalidate();
    await first;
    await ensure('me', TAGS, [undefined]);
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('fetches for other tags, other accounts or another login', async () => {
    const { ensure } = useTagCountsStore.getState();
    await ensure('me', TAGS, [undefined]);
    await ensure('me', [...TAGS, 'new'], [undefined]);
    await ensure('me', [...TAGS, 'new'], [undefined, 'team']);
    expect(mockRequest).toHaveBeenCalledTimes(1 + 1 + 2);

    // Another login's badges are dropped at once, not shown meanwhile.
    const other = ensure('someone-else', TAGS, [undefined]);
    expect(useTagCountsStore.getState().counts).toEqual({});
    await other;
    expect(useTagCountsStore.getState().counts.red).toBeDefined();
  });

  it('keeps the old counts when the fetch fails and retries next time', async () => {
    const { ensure, invalidate } = useTagCountsStore.getState();
    await ensure('me', TAGS, [undefined]);
    invalidate();
    mockRequest.mockRejectedValueOnce(new Error('offline'));
    await ensure('me', TAGS, [undefined]);
    expect(useTagCountsStore.getState().counts.red).toEqual({ id: 'red', total: 3, unread: 1 });

    await ensure('me', TAGS, [undefined]);
    expect(mockRequest).toHaveBeenCalledTimes(3);
  });
});
