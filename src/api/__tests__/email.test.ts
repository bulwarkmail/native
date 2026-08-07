import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the jmap-client module
vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    getAccountName: vi.fn(() => 'me@example.com'),
    getSharedMailAccounts: vi.fn(() => []),
    getMaxCallsInRequest: vi.fn(() => 16),
  },
}));

import { jmapClient } from '../jmap-client';
import {
  getMailboxes,
  getSharedMailboxes,
  queryEmails,
  getEmails,
  getFullEmail,
  getThread,
  setEmailKeywords,
  moveEmail,
  deleteEmail,
  searchEmails,
  sendEmail,
  saveDraft,
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

  describe('setEmailKeywords', () => {
    it('should update email keywords', async () => {
      mockRequest.mockResolvedValue({ methodResponses: [['Email/set', { updated: {} }, '0']] });

      await setEmailKeywords('e1', { $seen: true, $flagged: true });

      const call = mockRequest.mock.calls[0][0][0];
      expect(call[1].update).toEqual({ e1: { keywords: { $seen: true, $flagged: true } } });
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
          inReplyTo: '<msg-1@example.com>',
          references: '<msg-0@example.com> <msg-1@example.com>',
        },
        'identity-1',
        'sent-mb',
      );

      const emailCreate = mockRequest.mock.calls[0][0][0][1].create.draft;
      expect(emailCreate['header:In-Reply-To:asText']).toBe('<msg-1@example.com>');
      expect(emailCreate['header:References:asText']).toBe('<msg-0@example.com> <msg-1@example.com>');
    });
  });

  describe('saveDraft', () => {
    it('should create the draft in the drafts mailbox with the $draft keyword', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['Email/set', { created: { draft: { id: 'e-draft' } } }, '0']],
      });

      const result = await saveDraft(
        {
          from: [{ email: 'me@example.com' }],
          to: [{ email: 'you@example.com' }],
          subject: 'WIP',
          htmlBody: '<p>half-written</p>',
        },
        'drafts-mb',
      );

      expect(result).toEqual({ emailId: 'e-draft' });
      const setArgs = mockRequest.mock.calls[0][0][0][1];
      expect(setArgs.destroy).toBeUndefined();
      expect(setArgs.create.draft.mailboxIds).toEqual({ 'drafts-mb': true });
      expect(setArgs.create.draft.keywords).toEqual({ $draft: true, $seen: true });
    });

    it('should destroy the replaced draft in the same Email/set call', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [
          ['Email/set', { created: { draft: { id: 'e-new' } }, destroyed: ['e-old'] }, '0'],
        ],
      });

      await saveDraft(
        { from: [{ email: 'me@example.com' }], subject: '', textBody: 'note to self' },
        'drafts-mb',
        'e-old',
      );

      const setArgs = mockRequest.mock.calls[0][0][0][1];
      expect(setArgs.destroy).toEqual(['e-old']);
    });

    it('should allow a draft without recipients', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [['Email/set', { created: { draft: { id: 'e-draft' } } }, '0']],
      });

      await saveDraft(
        { from: [{ email: 'me@example.com' }], subject: 'no recipients yet', textBody: 'x' },
        'drafts-mb',
      );

      const emailCreate = mockRequest.mock.calls[0][0][0][1].create.draft;
      expect(emailCreate.to).toBeUndefined();
    });

    it('should throw when the server rejects the create', async () => {
      mockRequest.mockResolvedValue({
        methodResponses: [
          ['Email/set', { notCreated: { draft: { type: 'overQuota', description: 'Mailbox full' } } }, '0'],
        ],
      });

      await expect(
        saveDraft(
          { from: [{ email: 'me@example.com' }], subject: 'x', textBody: 'y' },
          'drafts-mb',
        ),
      ).rejects.toThrow('Mailbox full');
    });
  });
});
