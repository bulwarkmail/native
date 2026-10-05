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
import {
  destroyDraftCopies,
  findCopiesByMessageId,
  findSubmissionsForEmails,
  resolveSendMailboxes,
  type EmailCopy,
} from '../sent-lookup';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

/** A lookup response: per mailbox, the query ids and the fetched records. */
function lookupResponse(perMailbox: Array<{ ids: string[]; list: Array<Record<string, unknown>> }>) {
  return {
    methodResponses: perMailbox.flatMap((m, i) => [
      ['Email/query', { ids: m.ids }, `q${i}`],
      ['Email/get', { list: m.list }, `g${i}`],
    ]),
  };
}

describe('findCopiesByMessageId', () => {
  it('queries each mailbox since the given time and compares Message-ID client-side (request shape)', async () => {
    mockRequest.mockResolvedValueOnce(lookupResponse([
      { ids: ['e1', 'e2'], list: [
        { id: 'e1', messageId: ['mid-1@x.test'], keywords: { $seen: true }, mailboxIds: { sent: true } },
        { id: 'e2', messageId: ['other@x.test'], keywords: {}, mailboxIds: { sent: true } },
      ] },
      { ids: ['e3'], list: [
        { id: 'e3', messageId: ['<mid-1@x.test>'], keywords: { $draft: true }, mailboxIds: { drafts: true } },
      ] },
    ]));

    const result = await findCopiesByMessageId('mid-1@x.test', {
      accountId: 'shared-1',
      mailboxIds: ['sent', 'drafts'],
      since: '2026-10-04T09:50:00.000Z',
    });

    expect(mockRequest).toHaveBeenCalledTimes(1);
    const calls = mockRequest.mock.calls[0][0] as Array<[string, Record<string, unknown>, string]>;
    expect(calls).toEqual([
      ['Email/query', {
        accountId: 'shared-1',
        filter: { inMailbox: 'sent', after: '2026-10-04T09:50:00.000Z' },
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit: 200,
      }, 'q0'],
      ['Email/get', {
        accountId: 'shared-1',
        '#ids': { resultOf: 'q0', name: 'Email/query', path: '/ids' },
        properties: ['id', 'messageId', 'keywords', 'mailboxIds'],
      }, 'g0'],
      ['Email/query', {
        accountId: 'shared-1',
        filter: { inMailbox: 'drafts', after: '2026-10-04T09:50:00.000Z' },
        sort: [{ property: 'receivedAt', isAscending: false }],
        limit: 200,
      }, 'q1'],
      ['Email/get', {
        accountId: 'shared-1',
        '#ids': { resultOf: 'q1', name: 'Email/query', path: '/ids' },
        properties: ['id', 'messageId', 'keywords', 'mailboxIds'],
      }, 'g1'],
    ]);
    // No JMAP `header` filter (Stalwart 0.16 does not match it).
    expect(JSON.stringify(calls)).not.toContain('header');
    expect(result.complete).toBe(true);
    expect(result.copies.map((c) => c.id)).toEqual(['e1', 'e3']);
  });

  it('reports an incomplete lookup when a mailbox page is full', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `e${i}`);
    mockRequest.mockResolvedValueOnce(lookupResponse([
      { ids, list: ids.map((id) => ({ id, messageId: ['x@y'], keywords: {}, mailboxIds: { sent: true } })) },
    ]));
    const result = await findCopiesByMessageId('mid-1@x.test', { accountId: 'a', mailboxIds: ['sent'], since: '2026-10-04T00:00:00Z' });
    expect(result.complete).toBe(false);
    expect(result.copies).toEqual([]);
  });

  it('throws when the server answers a method with an error', async () => {
    mockRequest.mockResolvedValueOnce({ methodResponses: [
      ['error', { type: 'serverFail' }, 'q0'],
      ['error', { type: 'serverFail' }, 'g0'],
    ] });
    await expect(findCopiesByMessageId('m@x', { accountId: 'a', mailboxIds: ['sent'], since: '2026-10-04T00:00:00Z' }))
      .rejects.toThrow();
  });

  it('throws when the request fails', async () => {
    mockRequest.mockRejectedValueOnce(new TypeError('Network request failed'));
    await expect(findCopiesByMessageId('m@x', { accountId: 'a', mailboxIds: ['sent'], since: '2026-10-04T00:00:00Z' }))
      .rejects.toThrow('Network request failed');
  });

  it('ignores records without a messageId array and over-long values', async () => {
    mockRequest.mockResolvedValueOnce(lookupResponse([
      { ids: ['e1', 'e2', 'e3'], list: [
        { id: 'e1', messageId: null, keywords: {}, mailboxIds: { sent: true } },
        { id: 'e2', messageId: [`${'<'.repeat(200_000)}mid-1@x.test`], keywords: {}, mailboxIds: { sent: true } },
        { id: 'e3', messageId: 'mid-1@x.test', keywords: {}, mailboxIds: { sent: true } },
      ] },
    ]));
    const start = Date.now();
    const result = await findCopiesByMessageId('mid-1@x.test', { accountId: 'a', mailboxIds: ['sent'], since: '2026-10-04T00:00:00Z' });
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

  it('throws on a method error', async () => {
    mockRequest.mockResolvedValueOnce({ methodResponses: [['error', { type: 'unknownMethod' }, '0']] });
    await expect(findSubmissionsForEmails(['e3'], 'a')).rejects.toThrow();
  });
});

describe('destroyDraftCopies', () => {
  const copy = (over: Partial<EmailCopy>): EmailCopy => ({
    id: 'e', messageId: ['mid-1@x.test'], keywords: { $draft: true }, mailboxIds: { drafts: true }, ...over,
  });

  it('destroys only $draft copies whose Message-ID matches, in the given account', async () => {
    mockRequest.mockResolvedValueOnce({ methodResponses: [['Email/set', { destroyed: ['d1'] }, '0']] });
    await destroyDraftCopies([
      copy({ id: 'd1' }),
      copy({ id: 'sent1', keywords: { $seen: true } }),
      copy({ id: 'other', messageId: ['someone-else@x.test'] }),
    ], 'mid-1@x.test', 'shared-1');
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest.mock.calls[0][0]).toEqual([['Email/set', { accountId: 'shared-1', destroy: ['d1'] }, '0']]);
  });

  it('makes no request when nothing qualifies', async () => {
    await destroyDraftCopies([copy({ id: 'sent1', keywords: {} })], 'mid-1@x.test', 'a');
    expect(mockRequest).not.toHaveBeenCalled();
  });
});
