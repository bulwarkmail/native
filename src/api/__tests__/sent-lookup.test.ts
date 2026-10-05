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
  mockRequest.mockReset();
});

/** One lookup page: the query ids and the fetched records. */
function lookupResponse(ids: string[], list: Array<Record<string, unknown>>) {
  return {
    methodResponses: [
      ['Email/query', { ids }, 'q'],
      ['Email/get', { list }, 'g'],
    ],
  };
}
/** A full page of 200 unrelated messages, ids prefixed with `p`. */
function unrelatedPage(p: string) {
  const ids = Array.from({ length: 200 }, (_, i) => `${p}-${i}`);
  return lookupResponse(ids, ids.map((id) => ({ id, messageId: [`${id}@other.test`], keywords: {}, mailboxIds: { inbox: true } })));
}
const SINCE = '2026-09-27T09:50:00.000Z';
const queries = () => mockRequest.mock.calls.map((c) => (c[0] as Array<[string, Record<string, unknown>, string]>)[0][1]);

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
        position: 0,
        limit: 200,
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

  it('pages newest first and stops on the page with a match (page 3)', async () => {
    // Make page 3 full so only the match (not exhaustion) can stop the search.
    const page3Ids = ['hit', ...Array.from({ length: 199 }, (_, i) => `p3-${i}`)];
    mockRequest
      .mockResolvedValueOnce(unrelatedPage('p1'))
      .mockResolvedValueOnce(unrelatedPage('p2'))
      .mockResolvedValueOnce(lookupResponse(page3Ids, [{ id: 'hit', messageId: ['mid-1@x.test'], keywords: {}, mailboxIds: { sent: true } }]))
      .mockResolvedValue(unrelatedPage('more'));

    const result = await findCopiesByMessageId('mid-1@x.test', { accountId: 'a', since: SINCE });

    expect(result.copies.map((c) => c.id)).toEqual(['hit']);
    expect(queries().map((q) => q.position)).toEqual([0, 200, 400]);
  });

  it('stops when the window is exhausted', async () => {
    mockRequest
      .mockResolvedValueOnce(unrelatedPage('p1'))
      .mockResolvedValueOnce(lookupResponse(['last'], [{ id: 'last', messageId: ['no@x'], keywords: {}, mailboxIds: {} }]));
    const result = await findCopiesByMessageId('mid-1@x.test', { accountId: 'a', since: SINCE });
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ copies: [], complete: true });
  });

  it('stops after 2000 messages (10 queries) without a match and reports it incomplete', async () => {
    mockRequest.mockImplementation(async () => unrelatedPage(`p${mockRequest.mock.calls.length}`));
    const result = await findCopiesByMessageId('mid-1@x.test', { accountId: 'a', since: SINCE });
    expect(mockRequest).toHaveBeenCalledTimes(10);
    expect(queries().map((q) => q.position)).toEqual([0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800]);
    expect(result).toEqual({ copies: [], complete: false });
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
