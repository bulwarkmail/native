import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'c',
    request: vi.fn(),
    getMaxCallsInRequest: vi.fn(() => 16),
    currentSession: { capabilities: {} as Record<string, unknown> },
    hasAccountCapability: vi.fn(() => true),
  },
}));

import { jmapClient } from '../jmap-client';
import { fetchTagCounts, KEYWORDS_CAPABILITY } from '../tag-counts';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;
const mockMaxCalls = jmapClient.getMaxCallsInRequest as ReturnType<typeof vi.fn>;

// Answers every Email/query with `totals[accountId][callId prefix]`, or an
// error for an account listed in `failing`.
function answer(totals: Record<string, { total: number; unread: number }>, failing: string[] = []) {
  mockRequest.mockImplementation(async (calls: Array<[string, Record<string, unknown>, string]>) => ({
    methodResponses: calls.map(([, args, callId]) => {
      const accountId = args.accountId as string;
      if (failing.includes(accountId)) return ['error', { type: 'forbidden' }, callId];
      const unread = 'operator' in (args.filter as object);
      return ['Email/query', { ids: [], total: unread ? totals[accountId].unread : totals[accountId].total }, callId];
    }),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMaxCalls.mockReturnValue(16);
  jmapClient.currentSession!.capabilities = {};
});

describe('fetchTagCounts', () => {
  it('counts the own account alone by default', async () => {
    answer({ c: { total: 2, unread: 1 } });

    expect(await fetchTagCounts(['red'])).toEqual([{ id: 'red', total: 2, unread: 1 }]);
    const calls = mockRequest.mock.calls[0][0];
    expect(calls).toEqual([
      ['Email/query', { accountId: 'c', filter: { hasKeyword: '$label:red' }, limit: 1, calculateTotal: true }, 't0:red'],
      ['Email/query', {
        accountId: 'c',
        filter: { operator: 'AND', conditions: [{ hasKeyword: '$label:red' }, { notKeyword: '$seen' }] },
        limit: 1,
        calculateTotal: true,
      }, 'u0:red'],
    ]);
  });

  it('sums a tag over the own and the team account in one request (#1038)', async () => {
    answer({ c: { total: 2, unread: 1 }, team: { total: 2, unread: 2 } });

    const counts = await fetchTagCounts(['red', 'blue'], [undefined, 'team']);

    expect(counts).toEqual([
      { id: 'red', total: 4, unread: 3 },
      { id: 'blue', total: 4, unread: 3 },
    ]);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest.mock.calls[0][0].map((c: unknown[]) => (c[1] as { accountId: string }).accountId))
      .toEqual(['c', 'c', 'c', 'c', 'team', 'team', 'team', 'team']);
  });

  it('packs the calls into requests of maxCallsInRequest', async () => {
    mockMaxCalls.mockReturnValue(4);
    answer({ c: { total: 1, unread: 0 }, team: { total: 1, unread: 1 } });

    await fetchTagCounts(['red', 'blue', 'green'], [undefined, 'team']);

    expect(mockRequest.mock.calls.map((c) => c[0].length)).toEqual([4, 4, 4]);
  });

  it('lets an account that fails count nothing', async () => {
    answer({ c: { total: 2, unread: 1 } }, ['team']);

    expect(await fetchTagCounts(['red'], [undefined, 'team'])).toEqual([{ id: 'red', total: 2, unread: 1 }]);
  });

  // The tag view leaves Trash and Junk out; its badge counted them (#1156).
  it("leaves each account's Trash and Junk out of the counts", async () => {
    mockRequest.mockImplementation(async (calls: Array<[string, Record<string, unknown>, string]>) => ({
      methodResponses: calls.map(([, , callId]) => ['Email/query', { ids: [], total: 1 }, callId]),
    }));

    await fetchTagCounts(['red'], [undefined, 'team'], { '': ['trash', 'junk'], team: ['t-trash'] });

    const filters = mockRequest.mock.calls[0][0].map((c: unknown[]) => (c[1] as { filter: unknown }).filter);
    expect(filters).toEqual([
      { operator: 'AND', conditions: [{ hasKeyword: '$label:red' }, { inMailboxOtherThan: ['trash', 'junk'] }] },
      { operator: 'AND', conditions: [{ hasKeyword: '$label:red' }, { notKeyword: '$seen' }, { inMailboxOtherThan: ['trash', 'junk'] }] },
      { operator: 'AND', conditions: [{ hasKeyword: '$label:red' }, { inMailboxOtherThan: ['t-trash'] }] },
      { operator: 'AND', conditions: [{ hasKeyword: '$label:red' }, { notKeyword: '$seen' }, { inMailboxOtherThan: ['t-trash'] }] },
    ]);
  });

  // One Keyword/get where the server counts keywords (#1399), else the queries.
  it('asks Keyword/get when the server counts keywords, and falls back to queries when it fails', async () => {
    jmapClient.currentSession!.capabilities = { [KEYWORDS_CAPABILITY]: { supportsCounts: true } };
    mockRequest.mockImplementation(async (calls: Array<[string, Record<string, unknown>, string]>) => {
      if (calls[0][0] === 'Keyword/get') {
        return { methodResponses: [['Keyword/get', { list: [{ id: '$LABEL:Red', total: 7, unread: 3 }] }, '0']] };
      }
      return { methodResponses: calls.map(([, , callId]) => ['Email/query', { ids: [], total: 1 }, callId]) };
    });

    expect(await fetchTagCounts(['red', 'blue'])).toEqual([
      { id: 'red', total: 7, unread: 3 },
      { id: 'blue', total: 0, unread: 0 },
    ]);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest.mock.calls[0][0][0]).toEqual(['Keyword/get', { accountId: 'c', ids: ['$label:red', '$label:blue'] }, '0']);

    mockRequest.mockClear();
    mockRequest.mockImplementation(async (calls: Array<[string, Record<string, unknown>, string]>) => (
      calls[0][0] === 'Keyword/get'
        ? { methodResponses: [['error', { type: 'unknownMethod' }, '0']] }
        : { methodResponses: calls.map(([, , callId]) => ['Email/query', { ids: [], total: 2 }, callId]) }
    ));
    expect(await fetchTagCounts(['red'])).toEqual([{ id: 'red', total: 2, unread: 2 }]);

    // Without supportsCounts nothing asks Keyword/get.
    jmapClient.currentSession!.capabilities = { [KEYWORDS_CAPABILITY]: {} };
    mockRequest.mockClear();
    await fetchTagCounts(['red']);
    expect(mockRequest.mock.calls[0][0][0][0]).toBe('Email/query');
  });
});
