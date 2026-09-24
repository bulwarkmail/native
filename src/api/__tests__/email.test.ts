import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the jmap-client module
vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    getAccountName: vi.fn(() => 'me@example.com'),
    getSharedMailAccounts: vi.fn(() => []),
    getMaxCallsInRequest: vi.fn(() => 16),
    getMaxObjectsInGet: vi.fn(() => 500),
    getMaxObjectsInSet: vi.fn(() => 500),
  },
}));

import { jmapClient } from '../jmap-client';
import {
  getMailboxes,
  getSharedMailboxes,
  queryEmails,
  queryEmailPage,
  queryEmailPagesAcrossAccounts,
  getEmails,
  getFullEmail,
  getThread,
  patchKeywordsForEmails,
  patchKeywordsPerEmail,
  moveEmail,
  deleteEmail,
  searchEmails,
  sendEmail,
} from '../email';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('email operations', () => {
  describe('getMailboxes', () => {
    it('should fetch all mailboxes', async () => {
      const mailboxes = [
        { id: 'mb-1', name: 'Inbox', role: 'inbox', totalEmails: 10, unreadEmails: 3 },
        { id: 'mb-2', name: 'Sent', role: 'sent', totalEmails: 5, unreadEmails: 0 },
      ];
      mockRequest.mockResolvedValue({
        methodResponses: [['Mailbox/get', { list: mailboxes }, '0']],
      });

      const result = await getMailboxes();

      // Own folders keep their raw ids and pick up ownership metadata.
      expect(result).toEqual(mailboxes.map((m) => ({
        ...m,
        accountId: 'acc-1',
        accountName: 'me@example.com',
        isShared: false,
      })));
      expect(mockRequest).toHaveBeenCalledWith(
        [['Mailbox/get', { accountId: 'acc-1' }, '0']],
      );
    });
  });

  describe('getSharedMailboxes', () => {
    const mockShared = jmapClient.getSharedMailAccounts as ReturnType<typeof vi.fn>;

    it('returns nothing when the session has no shared accounts', async () => {
      mockShared.mockReturnValue([]);

      expect(await getSharedMailboxes()).toEqual([]);
      expect(mockRequest).not.toHaveBeenCalled();
    });

    it('prefixes ids and parent links per owning account', async () => {
      mockShared.mockReturnValue([{ id: 'grp-1', name: 'Support' }]);
      mockRequest.mockResolvedValue({
        methodResponses: [['Mailbox/get', {
          list: [
            { id: 'mb-1', name: 'Inbox', role: 'inbox', totalEmails: 4, unreadEmails: 2 },
            { id: 'mb-2', name: 'Escalations', parentId: 'mb-1', totalEmails: 1, unreadEmails: 0 },
          ],
        }, '0']],
      });

      const result = await getSharedMailboxes();

      expect(mockRequest).toHaveBeenCalledWith(
        [['Mailbox/get', { accountId: 'grp-1' }, '0']],
      );
      expect(result).toEqual([
        {
          id: 'grp-1:mb-1',
          originalId: 'mb-1',
          name: 'Inbox',
          role: 'inbox',
          parentId: undefined,
          totalEmails: 4,
          unreadEmails: 2,
          accountId: 'grp-1',
          accountName: 'Support',
          isShared: true,
        },
        {
          id: 'grp-1:mb-2',
          originalId: 'mb-2',
          name: 'Escalations',
          parentId: 'grp-1:mb-1',
          totalEmails: 1,
          unreadEmails: 0,
          accountId: 'grp-1',
          accountName: 'Support',
          isShared: true,
        },
      ]);
    });

    it('maps each response back to its account and skips the ones that errored', async () => {
      mockShared.mockReturnValue([
        { id: 'grp-1', name: 'Support' },
        { id: 'grp-2', name: 'Sales' },
      ]);
      mockRequest.mockResolvedValue({
        methodResponses: [
          ['error', { type: 'accountNotFound' }, '0'],
          ['Mailbox/get', { list: [{ id: 'mb-9', name: 'Inbox', role: 'inbox' }] }, '1'],
        ],
      });

      const result = await getSharedMailboxes();

      expect(result.map((m) => m.id)).toEqual(['grp-2:mb-9']);
      expect(result[0].accountName).toBe('Sales');
    });

    it('chunks requests to maxCallsInRequest', async () => {
      mockShared.mockReturnValue([
        { id: 'grp-1', name: 'Support' },
        { id: 'grp-2', name: 'Sales' },
        { id: 'grp-3', name: 'Billing' },
      ]);
      (jmapClient.getMaxCallsInRequest as ReturnType<typeof vi.fn>).mockReturnValue(2);
      mockRequest.mockResolvedValue({ methodResponses: [] });

      await getSharedMailboxes();

      expect(mockRequest).toHaveBeenCalledTimes(2);
      expect(mockRequest.mock.calls[0][0]).toHaveLength(2);
      expect(mockRequest.mock.calls[1][0]).toHaveLength(1);
    });
  });

  describe('queryEmails', () => {
    it('should query emails with default options', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['Email/query', { ids: ['e1', 'e2'], total: 2 }, '0']],
      });

      const result = await queryEmails('mb-1');

      expect(result).toEqual({ ids: ['e1', 'e2'], total: 2 });
      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].filter).toEqual({ inMailbox: 'mb-1' });
      expect(call[1].limit).toBe(50);
      expect(call[1].position).toBe(0);
    });

    it('should support custom sort and limit', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['Email/query', { ids: ['e1'], total: 1 }, '0']],
      });

      await queryEmails('mb-1', {
        limit: 10,
        sort: [{ property: 'subject', isAscending: true }],
      });

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].limit).toBe(10);
      expect(call[1].sort).toEqual([{ property: 'subject', isAscending: true }]);
    });

    it('should merge additional filter options', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['Email/query', { ids: [], total: 0 }, '0']],
      });

      await queryEmails('mb-1', {
        filter: { hasKeyword: '$flagged' },
      });

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].filter).toEqual({ inMailbox: 'mb-1', hasKeyword: '$flagged' });
    });

    it('should AND-wrap a FilterOperator instead of spreading it', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['Email/query', { ids: [], total: 0 }, '0']],
      });

      const userFilter = {
        operator: 'AND',
        conditions: [{ inMailbox: 'mb-1' }, { notKeyword: '$seen' }],
      };
      await queryEmails('mb-1', { filter: userFilter });

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].filter).toEqual({
        operator: 'AND',
        conditions: [{ inMailbox: 'mb-1' }, userFilter],
      });
    });
  });

  describe('queryEmailPage', () => {
    it('chains Email/query, Email/get and Thread/get in one request', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [
          ['Email/query', { ids: ['e2', 'e1'], total: 7, queryState: 'q-1' }, '0'],
          // Email/get may answer in another order than the query's.
          ['Email/get', { list: [{ id: 'e1', threadId: 't1' }, { id: 'e2', threadId: 't1' }], state: 's-1' }, '1'],
          ['Thread/get', { list: [{ id: 't1', emailIds: ['e1', 'e2', 'e3'] }] }, '2'],
        ],
      });

      const result = await queryEmailPage('mb-1', { limit: 25, position: 50, threads: true });

      expect(mockRequest).toHaveBeenCalledTimes(1);
      const calls = mockRequest.mock.calls[0][0];
      expect(calls).toEqual([
        ['Email/query', expect.objectContaining({
          accountId: 'acc-1', filter: { inMailbox: 'mb-1' }, position: 50, limit: 25, calculateTotal: true,
        }), '0'],
        ['Email/get', expect.objectContaining({
          accountId: 'acc-1',
          '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' },
        }), '1'],
        ['Thread/get', {
          accountId: 'acc-1',
          '#ids': { resultOf: '1', name: 'Email/get', path: '/list/*/threadId' },
        }, '2'],
      ]);
      expect(calls[1][1].properties).toContain('preview');
      expect(calls[1][1].properties).not.toContain('bodyStructure');
      expect(result).toEqual({
        ids: ['e2', 'e1'],
        total: 7,
        queryState: 'q-1',
        list: [{ id: 'e2', threadId: 't1' }, { id: 'e1', threadId: 't1' }],
        state: 's-1',
        threads: [{ id: 't1', emailIds: ['e1', 'e2', 'e3'] }],
      });
    });

    it('asks several accounts for a folder-less page in one request (#1082)', async () => {
      (jmapClient.getMaxCallsInRequest as ReturnType<typeof vi.fn>).mockReturnValueOnce(16);
      mockRequest.mockResolvedValue({
        methodResponses: [
          ['Email/query', { ids: ['e1'], total: 3 }, '0:q'],
          ['Email/get', { list: [{ id: 'e1', threadId: 't1' }] }, '0:g'],
          ['Thread/get', { list: [{ id: 't1', emailIds: ['e1'] }] }, '0:t'],
          ['error', { type: 'forbidden' }, '1:q'],
          ['error', { type: 'invalidResultReference' }, '1:g'],
          ['error', { type: 'invalidResultReference' }, '1:t'],
        ],
      });
      const sort = [{ property: 'receivedAt', isAscending: false }];

      const pages = await queryEmailPagesAcrossAccounts(
        [{ position: 2, sort }, { accountId: 'grp-1', position: 0, sort }],
        { limit: 25, filter: { text: 'zephyr*' }, threads: true },
      );

      expect(mockRequest).toHaveBeenCalledTimes(1);
      const calls = mockRequest.mock.calls[0][0];
      expect(calls.map((c: unknown[]) => [c[0], (c[1] as { accountId: string }).accountId, c[2]])).toEqual([
        ['Email/query', 'acc-1', '0:q'], ['Email/get', 'acc-1', '0:g'], ['Thread/get', 'acc-1', '0:t'],
        ['Email/query', 'grp-1', '1:q'], ['Email/get', 'grp-1', '1:g'], ['Thread/get', 'grp-1', '1:t'],
      ]);
      expect(calls[0][1]).toMatchObject({ filter: { text: 'zephyr*' }, position: 2, limit: 25, sort });
      expect(calls[4][1]['#ids']).toEqual({ resultOf: '1:q', name: 'Email/query', path: '/ids' });
      expect(pages[0]).toEqual({
        accountId: undefined, ok: true, total: 3,
        list: [{ id: 'e1', threadId: 't1' }], threads: [{ id: 't1', emailIds: ['e1'] }],
      });
      expect(pages[1]).toMatchObject({ accountId: 'grp-1', ok: false, error: { type: 'forbidden' } });
    });

    it('splits the accounts over requests by maxCallsInRequest', async () => {
      (jmapClient.getMaxCallsInRequest as ReturnType<typeof vi.fn>).mockReturnValueOnce(4);
      mockRequest.mockImplementation(async (calls: Array<[string, Record<string, unknown>, string]>) => ({
        methodResponses: calls.map(([name, , id]) => (name === 'Email/query'
          ? [name, { ids: [], total: 0 }, id]
          : [name, { list: [] }, id])),
      }));
      const sort = [{ property: 'receivedAt', isAscending: false }];

      const pages = await queryEmailPagesAcrossAccounts(
        [{ position: 0, sort }, { accountId: 'g1', position: 0, sort }, { accountId: 'g2', position: 0, sort }],
        { limit: 10 },
      );

      // Two calls per account without threads: two accounts fit in one request.
      expect(mockRequest.mock.calls.map((c) => c[0].length)).toEqual([4, 2]);
      expect(pages.map((p) => p.ok)).toEqual([true, true, true]);
      mockRequest.mockReset();
    });

    it('leaves Thread/get out unless asked, and targets a shared account', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [
          ['Email/query', { ids: [], total: 0, queryState: 'q-1' }, '0'],
          ['Email/get', { list: [], state: 's-1' }, '1'],
        ],
      });

      const result = await queryEmailPage('mb-1', { accountId: 'grp-1' });

      const calls = mockRequest.mock.calls[0][0];
      expect(calls.map((c: unknown[]) => c[0])).toEqual(['Email/query', 'Email/get']);
      expect(calls[0][1].accountId).toBe('grp-1');
      expect(calls[1][1].accountId).toBe('grp-1');
      // An empty page still reports the Email state.
      expect(result).toMatchObject({ list: [], state: 's-1', threads: [] });
    });

    it('keeps the page when Thread/get fails, and fails with the query', async () => {
      mockRequest.mockResolvedValueOnce({
        methodResponses: [
          ['Email/query', { ids: ['e1'], total: 1 }, '0'],
          ['Email/get', { list: [{ id: 'e1', threadId: 't1' }], state: 's-1' }, '1'],
          ['error', { type: 'serverFail' }, '2'],
        ],
      });
      const result = await queryEmailPage('mb-1', { threads: true });
      expect(result.list).toEqual([{ id: 'e1', threadId: 't1' }]);
      expect(result.threads).toEqual([]);

      mockRequest.mockResolvedValueOnce({
        methodResponses: [
          ['error', { type: 'unsupportedSort' }, '0'],
          ['error', { type: 'invalidResultReference' }, '1'],
          ['error', { type: 'invalidResultReference' }, '2'],
        ],
      });
      await expect(queryEmailPage('mb-1', { threads: true })).rejects.toMatchObject({ type: 'unsupportedSort' });
    });

    it('caps the page at the server\'s maxObjectsInGet', async () => {
      (jmapClient.getMaxObjectsInGet as ReturnType<typeof vi.fn>).mockReturnValueOnce(100);
      mockRequest.mockResolvedValue({
        methodResponses: [
          ['Email/query', { ids: [], total: 0 }, '0'],
          ['Email/get', { list: [], state: 's-1' }, '1'],
        ],
      });

      await queryEmailPage('mb-1', { limit: 250 });

      expect(mockRequest.mock.calls[0][0][0][1].limit).toBe(100);
    });
  });

  describe('getEmails', () => {
    it('should fetch emails by id with list properties', async () => {
      const emails = [{ id: 'e1', subject: 'Test' }];
      mockRequest.mockResolvedValue({
        methodResponses: [['Email/get', { list: emails }, '0']],
      });

      const result = await getEmails(['e1']);

      expect(result).toEqual(emails);
      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].ids).toEqual(['e1']);
      expect(call[1].properties).toContain('subject');
      expect(call[1].properties).toContain('preview');
      expect(call[1].properties).not.toContain('bodyStructure');
    });
  });

  describe('getFullEmail', () => {
    it('should fetch full email with body values', async () => {
      const email = { id: 'e1', subject: 'Test', htmlBody: [{ partId: 'html' }] };
      mockRequest.mockResolvedValue({
        methodResponses: [['Email/get', { list: [email] }, '0']],
      });

      const result = await getFullEmail('e1');

      expect(result).toEqual(email);
      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].fetchHTMLBodyValues).toBe(true);
      expect(call[1].fetchTextBodyValues).toBe(true);
      expect(call[1].properties).toContain('bodyStructure');
    });
  });

  describe('getThread', () => {
    it('should fetch thread by id', async () => {
      const thread = { id: 't1', emailIds: ['e1', 'e2'] };
      mockRequest.mockResolvedValue({
        methodResponses: [['Thread/get', { list: [thread] }, '0']],
      });

      const result = await getThread('t1');
      expect(result).toEqual(thread);
    });
  });

  describe('keyword patches', () => {
    // A whole `keywords` map on update replaces it and erased stars and tags
    // the local copy didn't have; only per-keyword pointers may go out.
    it('patches only the named keywords, clearing with null', async () => {
      mockRequest.mockResolvedValue({ methodResponses: [['Email/set', { updated: { e1: null, e2: null } }, '0']] });

      await patchKeywordsForEmails(['e1', 'e2'], { $seen: true, $flagged: false, '$label:work/clients': null }, 'grp-1');

      expect(mockRequest).toHaveBeenCalledTimes(1);
      expect(mockRequest.mock.calls[0][0]).toEqual([['Email/set', {
        accountId: 'grp-1',
        update: {
          e1: { 'keywords/$seen': true, 'keywords/$flagged': null, 'keywords/$label:work~1clients': null },
          e2: { 'keywords/$seen': true, 'keywords/$flagged': null, 'keywords/$label:work~1clients': null },
        },
      }, '0']]);
    });

    it('applies a separate patch to each message in one Email/set', async () => {
      mockRequest.mockResolvedValue({ methodResponses: [['Email/set', { updated: { e1: null, e2: null } }, '0']] });

      await patchKeywordsPerEmail([
        { id: 'e1', patch: { $junk: null, $notjunk: true } },
        { id: 'e2', patch: { $junk: null, $notjunk: null } },
      ]);

      expect(mockRequest).toHaveBeenCalledTimes(1);
      expect(mockRequest.mock.calls[0][0]).toEqual([['Email/set', {
        accountId: 'acc-1',
        update: {
          e1: { 'keywords/$junk': null, 'keywords/$notjunk': true },
          e2: { 'keywords/$junk': null, 'keywords/$notjunk': null },
        },
      }, '0']]);
    });
  });

  describe('moveEmail', () => {
    it('should move email between mailboxes using path patches', async () => {
      mockRequest.mockResolvedValue({ methodResponses: [['Email/set', { updated: {} }, '0']] });

      await moveEmail('e1', 'inbox', 'archive');

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].update.e1).toEqual({
        'mailboxIds/inbox': null,
        'mailboxIds/archive': true,
      });
    });
  });

  describe('deleteEmail', () => {
    it('should move to trash if not already in trash', async () => {
      mockRequest.mockResolvedValue({ methodResponses: [['Email/set', { updated: {} }, '0']] });

      await deleteEmail('e1', 'trash', 'inbox');

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].update.e1).toEqual({
        'mailboxIds/inbox': null,
        'mailboxIds/trash': true,
      });
    });

    it('should permanently destroy if already in trash', async () => {
      mockRequest.mockResolvedValue({ methodResponses: [['Email/set', { destroyed: ['e1'] }, '0']] });

      await deleteEmail('e1', 'trash', 'trash');

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].destroy).toEqual(['e1']);
    });
  });

  describe('searchEmails', () => {
    it('should search with text filter', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['Email/query', { ids: ['e1'] }, '0']],
      });

      const result = await searchEmails('test query');

      expect(result).toEqual(['e1']);
      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].filter).toEqual({ text: 'test* query*' });
    });

    it('should include mailbox filter if specified', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['Email/query', { ids: [] }, '0']],
      });

      await searchEmails('query', 'mb-1');

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].filter).toEqual({ text: 'query*', inMailbox: 'mb-1' });
    });
  });

  describe('sendEmail', () => {
    it('should create email and submission in one request', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [
          ['Email/set', { created: { draft: { id: 'e-new' } } }, '0'],
          ['EmailSubmission/set', { created: { 'sub-1': { id: 's-1' } } }, '1'],
        ],
      });

      await sendEmail(
        {
          from: [{ email: 'me@example.com' }],
          to: [{ email: 'you@example.com' }],
          subject: 'Hello',
          textBody: 'Hi there',
        },
        'identity-1',
        'sent-mb',
      );

      expect(mockRequest).toHaveBeenCalledTimes(1);
      const calls = mockRequest.mock.calls[0][0];
      expect(calls).toHaveLength(2);
      expect(calls[0][0]).toBe('Email/set');
      expect(calls[1][0]).toBe('EmailSubmission/set');
      expect(calls[1][1].create['sub-1'].emailId).toBe('#draft');
    });

    it('should use htmlBody when provided', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [
          ['Email/set', { created: { draft: { id: 'e-new' } } }, '0'],
          ['EmailSubmission/set', { created: { 'sub-1': { id: 's-1' } } }, '1'],
        ],
      });

      await sendEmail(
        {
          from: [{ email: 'me@example.com' }],
          to: [{ email: 'you@example.com' }],
          subject: 'Hello',
          htmlBody: '<p>Hi there</p>',
        },
        'identity-1',
        'sent-mb',
      );

      const emailCreate = mockRequest.mock.calls[0][0][0][1].create.draft;
      expect(emailCreate.htmlBody).toEqual([{ partId: 'html', type: 'text/html' }]);
      expect(emailCreate.bodyValues).toEqual({ html: { value: '<p>Hi there</p>' } });
    });

    it('should set reply headers when inReplyTo is provided', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [
          ['Email/set', { created: { draft: { id: 'e-new' } } }, '0'],
          ['EmailSubmission/set', { created: { 'sub-1': { id: 's-1' } } }, '1'],
        ],
      });

      await sendEmail(
        {
          from: [{ email: 'me@example.com' }],
          to: [{ email: 'you@example.com' }],
          subject: 'Re: Hello',
          textBody: 'replying',
          inReplyTo: ['<msg-1@example.com>'],
          references: ['<msg-0@example.com>', '<msg-1@example.com>'],
        },
        'identity-1',
        'sent-mb',
      );

      const emailCreate = mockRequest.mock.calls[0][0][0][1].create.draft;
      // RFC 8621 §4.1.2.3: JMAP arrays of bare msg-ids, brackets stripped.
      expect(emailCreate.inReplyTo).toEqual(['msg-1@example.com']);
      expect(emailCreate.references).toEqual(['msg-0@example.com', 'msg-1@example.com']);
      expect(emailCreate['header:In-Reply-To:asText']).toBeUndefined();
    });
  });
});
