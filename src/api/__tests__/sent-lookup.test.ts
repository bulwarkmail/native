import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'primary',
    request: vi.fn(),
    getMaxObjectsInGet: vi.fn(() => 500),
    getMaxObjectsInSet: vi.fn(() => 500),
  },
}));

import { jmapClient } from '../jmap-client';
import { findCopiesByMessageId, findSubmissionsForEmails, resolveSendMailboxes } from '../sent-lookup';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

/** A lookup response: the query ids (and total) and the fetched records. */
function lookupResponse(ids: string[], list: Array<Record<string, unknown>>, total: number | null = ids.length) {
  return {
    methodResponses: [
      ['Email/query', total === null ? { ids } : { ids, total }, 'q'],
      ['Email/get', { list }, 'g'],
    ],
  };
}
const SINCE = '2026-09-27T09:50:00.000Z';

describe('findCopiesByMessageId', () => {
  it('queries the whole account since the given time and compares Message-ID client-side (request shape)', async () => {
    mockRequest.mockResolvedValueOnce(lookupResponse(['e1', 'e2', 'e3'], [
      { id: 'e1', messageId: ['mid-1@x.test'], keywords: { $seen: true }, mailboxIds: { sent: true } },
      { id: 'e2', messageId: ['other@x.test'], keywords: {}, mailboxIds: { sent: true } },
      { id: 'e3', messageId: ['<mid-1@x.test>'], keywords: { $draft: true }, mailboxIds: { drafts: true } },
    ]));

    const result = await findCopiesByMessageId('mid-1@x.test', { accountId: 'shared-1', since: SINCE });

    expect(mockRequest).toHaveBeenCalledTimes(1);
    const calls = mockRequest.mock.calls[0][0] as Array<[string, Record<string, unknown>, string]>;
    expect(calls).toEqual([
      ['Email/query', {
        accountId: 'shared-1',
        filter: { after: SINCE },
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit: 200,
        calculateTotal: true,
      }, 'q'],
      ['Email/get', {
        accountId: 'shared-1',
        '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
        properties: ['id', 'messageId', 'keywords', 'mailboxIds'],
      }, 'g'],
    ]);
    // No JMAP `header` filter (Stalwart 0.16 does not match it), no mailbox restriction.
    expect(JSON.stringify(calls)).not.toContain('header');
    expect(JSON.stringify(calls)).not.toContain('inMailbox');
    expect(result.complete).toBe(true);
    expect(result.copies.map((c) => c.id)).toEqual(['e1', 'e3']);
  });

  it('reports an incomplete lookup when the total exceeds the ids read', async () => {
    mockRequest.mockResolvedValueOnce(lookupResponse(['e1'], [
      { id: 'e1', messageId: ['x@y'], keywords: {}, mailboxIds: { sent: true } },
    ], 5000));
    const result = await findCopiesByMessageId('mid-1@x.test', { accountId: 'a', since: SINCE });
    expect(result.complete).toBe(false);
    expect(result.copies).toEqual([]);
  });

  it('without a total, only a short page counts as complete', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `e${i}`);
    mockRequest.mockResolvedValueOnce(lookupResponse(ids, [], null));
    expect((await findCopiesByMessageId('m@x', { accountId: 'a', since: SINCE })).complete).toBe(false);
    mockRequest.mockResolvedValueOnce(lookupResponse(['e1'], [], null));
    expect((await findCopiesByMessageId('m@x', { accountId: 'a', since: SINCE })).complete).toBe(true);
  });

  it('throws when the server answers a method with an error', async () => {
    mockRequest.mockResolvedValueOnce({ methodResponses: [
      ['error', { type: 'serverFail' }, 'q'],
      ['error', { type: 'serverFail' }, 'g'],
    ] });
    await expect(findCopiesByMessageId('m@x', { accountId: 'a', since: SINCE })).rejects.toThrow();
  });

  it('throws when the request fails', async () => {
    mockRequest.mockRejectedValueOnce(new TypeError('Network request failed'));
    await expect(findCopiesByMessageId('m@x', { accountId: 'a', since: SINCE })).rejects.toThrow('Network request failed');
  });

  it('ignores records without a messageId array and over-long values', async () => {
    mockRequest.mockResolvedValueOnce(lookupResponse(['e1', 'e2', 'e3'], [
      { id: 'e1', messageId: null, keywords: {}, mailboxIds: { sent: true } },
      { id: 'e2', messageId: [`${'<'.repeat(200_000)}mid-1@x.test`], keywords: {}, mailboxIds: { sent: true } },
      { id: 'e3', messageId: 'mid-1@x.test', keywords: {}, mailboxIds: { sent: true } },
    ]));
    const start = Date.now();
    const result = await findCopiesByMessageId('mid-1@x.test', { accountId: 'a', since: SINCE });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result.copies).toEqual([]);
  });
});

describe('resolveSendMailboxes', () => {
  it('reads Sent and Drafts by role for the given account', async () => {
    mockRequest.mockResolvedValueOnce({ methodResponses: [
      ['Mailbox/get', { list: [
        { id: 'm-in', role: 'inbox' },
        { id: 'm-sent', role: 'sent' },
        { id: 'm-drafts', role: 'drafts' },
      ] }, '0'],
    ] });
    await expect(resolveSendMailboxes('shared-1')).resolves.toEqual({ sentId: 'm-sent', draftsId: 'm-drafts' });
    expect(mockRequest.mock.calls[0][0]).toEqual([
      ['Mailbox/get', { accountId: 'shared-1', properties: ['id', 'role'] }, '0'],
    ]);
  });
});

describe('findSubmissionsForEmails', () => {
  it('queries submissions for the given email ids in the given account', async () => {
    mockRequest.mockResolvedValueOnce({ methodResponses: [
      ['EmailSubmission/query', { ids: ['s1'] }, '0'],
      ['EmailSubmission/get', { list: [{ id: 's1', emailId: 'e3', undoStatus: 'final' }] }, '1'],
    ] });
    await expect(findSubmissionsForEmails(['e3'], 'shared-1')).resolves.toEqual([
      { id: 's1', emailId: 'e3', undoStatus: 'final' },
    ]);
    const [calls, using] = mockRequest.mock.calls[0];
    expect(calls[0]).toEqual(['EmailSubmission/query', { accountId: 'shared-1', filter: { emailIds: ['e3'] } }, '0']);
    expect(calls[1][1]).toMatchObject({ accountId: 'shared-1', '#ids': { resultOf: '0', name: 'EmailSubmission/query', path: '/ids' } });
    expect(using).toContain('urn:ietf:params:jmap:submission');
  });

  it('keeps only submissions whose emailId was asked for', async () => {
    mockRequest.mockResolvedValueOnce({ methodResponses: [
      ['EmailSubmission/query', { ids: ['s1', 's2'] }, '0'],
      ['EmailSubmission/get', { list: [
        { id: 's1', emailId: 'unrelated', undoStatus: 'final' },
        { id: 's2', emailId: 'e3', undoStatus: 'final' },
      ] }, '1'],
    ] });
    await expect(findSubmissionsForEmails(['e3'], 'a')).resolves.toEqual([{ id: 's2', emailId: 'e3', undoStatus: 'final' }]);
  });

  it('throws on a method error', async () => {
    mockRequest.mockResolvedValueOnce({ methodResponses: [['error', { type: 'unknownMethod' }, '0']] });
    await expect(findSubmissionsForEmails(['e3'], 'a')).rejects.toThrow();
  });
});
