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
import { findCopiesByMessageId, findSubmissionsForEmails, hasMessageId, resolveSendMailboxes } from '../sent-lookup';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockRequest.mockReset();
});

/** One lookup page: the query ids (and total, when given) and the fetched records. */
function lookupResponse(ids: string[], list: Array<Record<string, unknown>>, total?: number) {
  return {
    methodResponses: [
      ['Email/query', total === undefined ? { ids } : { ids, total }, 'q'],
      ['Email/get', { list }, 'g'],
    ],
  };
}
/** A page of `n` unrelated messages, ids prefixed with `p`. */
function unrelatedPage(p: string, n = 200, total?: number) {
  const ids = Array.from({ length: n }, (_, i) => `${p}-${i}`);
  return lookupResponse(ids, ids.map((id) => ({ id, messageId: [`${id}@other.test`], keywords: {}, mailboxIds: { inbox: true } })), total);
}
const hit = (id: string, over: Record<string, unknown> = {}) =>
  ({ id, messageId: ['mid-1@x.test'], from: [{ email: 'me@x.test' }], keywords: {}, mailboxIds: { sent: true }, ...over });
const SINCE = '2026-09-27T09:50:00.000Z';
const queries = () => mockRequest.mock.calls.map((c) => (c[0] as Array<[string, Record<string, unknown>, string]>)[0][1]);

describe('findCopiesByMessageId', () => {
  it('queries the whole account since the given time and compares Message-ID client-side (request shape)', async () => {
    mockRequest.mockResolvedValueOnce(lookupResponse(['e1', 'e2', 'e3'], [
      { id: 'e1', messageId: ['mid-1@x.test'], keywords: { $seen: true }, mailboxIds: { sent: true } },
      { id: 'e2', messageId: ['other@x.test'], keywords: {}, mailboxIds: { sent: true } },
      { id: 'e3', messageId: ['<mid-1@x.test>'], keywords: { $draft: true }, mailboxIds: { drafts: true } },
    ], 3));

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
        calculateTotal: true,
      }, 'q'],
      ['Email/get', {
        accountId: 'shared-1',
        '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
        properties: ['id', 'messageId', 'from', 'keywords', 'mailboxIds'],
      }, 'g'],
    ]);
    // No JMAP `header` filter (Stalwart 0.16 does not match it), no mailbox restriction.
    expect(JSON.stringify(calls)).not.toContain('header');
    expect(JSON.stringify(calls)).not.toContain('inMailbox');
    expect(result.complete).toBe(true);
    expect(result.proven).toBe(false);
    expect(result.copies.map((c) => c.id)).toEqual(['e1', 'e3']);
  });

  it('pages newest first and stops on the page where isProof holds (page 3)', async () => {
    mockRequest
      .mockResolvedValueOnce(unrelatedPage('p1'))
      .mockResolvedValueOnce(unrelatedPage('p2'))
      .mockResolvedValueOnce(lookupResponse(['h', ...Array.from({ length: 199 }, (_, i) => `p3-${i}`)], [hit('h')]))
      .mockResolvedValue(unrelatedPage('more'));
    const isProof = vi.fn(async () => true);

    const result = await findCopiesByMessageId('mid-1@x.test', { accountId: 'a', since: SINCE, isProof });

    expect(result.proven).toBe(true);
    expect(result.copies.map((c) => c.id)).toEqual(['h']);
    expect(isProof).toHaveBeenCalledTimes(1);
    expect(queries().map((q) => q.position)).toEqual([0, 200, 400]);
  });

  it('keeps paging past a match that is not proof (an echo or forgery)', async () => {
    mockRequest
      .mockResolvedValueOnce(lookupResponse(['echo', ...Array.from({ length: 199 }, (_, i) => `p1-${i}`)], [hit('echo', { mailboxIds: { inbox: true } })]))
      .mockResolvedValueOnce(lookupResponse(['real', 'z'], [hit('real')], 202));
    const isProof = vi.fn(async (m: Array<{ id: string }>) => m.some((c) => c.id === 'real'));

    const result = await findCopiesByMessageId('mid-1@x.test', { accountId: 'a', since: SINCE, isProof });

    expect(result.proven).toBe(true);
    expect(result.copies.map((c) => c.id)).toEqual(['echo', 'real']);
    expect(isProof.mock.calls.map((c) => c[0].map((x: { id: string }) => x.id))).toEqual([['echo'], ['real']]);
  });

  it('advances by the ids returned: a short page is not the end (server page cap below 200)', async () => {
    mockRequest
      .mockResolvedValueOnce(unrelatedPage('p1', 50, 120))
      .mockResolvedValueOnce(unrelatedPage('p2', 50, 120))
      .mockResolvedValueOnce(lookupResponse(['h', 'x1'], [hit('h')], 120));
    const result = await findCopiesByMessageId('mid-1@x.test', { accountId: 'a', since: SINCE, isProof: async () => true });
    expect(result.proven).toBe(true);
    expect(queries().map((q) => q.position)).toEqual([0, 50, 100]);
  });

  it('ends at the total, or at an empty page', async () => {
    mockRequest
      .mockResolvedValueOnce(unrelatedPage('p1', 200, 201))
      .mockResolvedValueOnce(unrelatedPage('p2', 1, 201));
    expect(await findCopiesByMessageId('mid-1@x.test', { accountId: 'a', since: SINCE }))
      .toEqual({ copies: [], complete: true, proven: false });
    expect(mockRequest).toHaveBeenCalledTimes(2);

    mockRequest.mockReset();
    mockRequest
      .mockResolvedValueOnce(unrelatedPage('p1', 30))
      .mockResolvedValueOnce(lookupResponse([], []));
    expect((await findCopiesByMessageId('mid-1@x.test', { accountId: 'a', since: SINCE })).complete).toBe(true);
    expect(queries().map((q) => q.position)).toEqual([0, 30]);
  });

  it('dedupes a message seen on two pages (the window shifted)', async () => {
    mockRequest
      .mockResolvedValueOnce(lookupResponse(['h', 'a1'], [hit('h')]))
      .mockResolvedValueOnce(lookupResponse(['h', 'a2'], [hit('h')]))
      .mockResolvedValueOnce(lookupResponse([], []));
    const isProof = vi.fn(async () => false);
    const result = await findCopiesByMessageId('mid-1@x.test', { accountId: 'a', since: SINCE, isProof });
    expect(result.copies.map((c) => c.id)).toEqual(['h']);
    expect(isProof).toHaveBeenCalledTimes(1);
  });

  it('stops after 2000 messages (10 queries) without proof and reports it incomplete', async () => {
    mockRequest.mockImplementation(async () => unrelatedPage(`p${mockRequest.mock.calls.length}`));
    const result = await findCopiesByMessageId('mid-1@x.test', { accountId: 'a', since: SINCE, isProof: async () => false });
    expect(mockRequest).toHaveBeenCalledTimes(10);
    expect(queries().map((q) => q.position)).toEqual([0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800]);
    expect(result).toEqual({ copies: [], complete: false, proven: false });
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
    ], 3));
    const start = Date.now();
    const result = await findCopiesByMessageId('mid-1@x.test', { accountId: 'a', since: SINCE });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(result.copies).toEqual([]);
  });
});

describe('hasMessageId', () => {
  it('ignores angle brackets and surrounding space on either side', () => {
    expect(hasMessageId({ messageId: ['<abc@x.test>'] }, 'abc@x.test')).toBe(true);
    expect(hasMessageId({ messageId: ['abc@x.test'] }, '<abc@x.test>')).toBe(true);
    expect(hasMessageId({ messageId: [' <abc@x.test> '] }, 'abc@x.test')).toBe(true);
  });

  it('compares case exactly (a different case is not the same message)', () => {
    expect(hasMessageId({ messageId: ['ABC@x.test'] }, 'abc@x.test')).toBe(false);
  });

  it('is false for a missing or non-array messageId, or an empty target', () => {
    expect(hasMessageId({ messageId: null }, 'abc@x.test')).toBe(false);
    expect(hasMessageId({ messageId: 'abc@x.test' }, 'abc@x.test')).toBe(false);
    expect(hasMessageId({ messageId: [''] }, '')).toBe(false);
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
      ['EmailSubmission/get', { list: [{ id: 's1', emailId: 'e3', identityId: 'i1', undoStatus: 'final' }] }, '1'],
    ] });
    await expect(findSubmissionsForEmails(['e3'], 'shared-1')).resolves.toEqual([
      { id: 's1', emailId: 'e3', identityId: 'i1', undoStatus: 'final' },
    ]);
    const [calls, using] = mockRequest.mock.calls[0];
    expect(calls[0]).toEqual(['EmailSubmission/query', { accountId: 'shared-1', filter: { emailIds: ['e3'] } }, '0']);
    expect(calls[1][1]).toEqual({
      accountId: 'shared-1',
      '#ids': { resultOf: '0', name: 'EmailSubmission/query', path: '/ids' },
      properties: ['id', 'emailId', 'identityId', 'undoStatus'],
    });
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
