import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the jmap-client module
vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
  },
}));

import { jmapClient } from '../jmap-client';
import {
  getMailboxes,
  queryEmails,
  getEmails,
  getFullEmail,
  getThread,
  setEmailKeywords,
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

      expect(result).toEqual(mailboxes);
      expect(mockRequest).toHaveBeenCalledWith(
        [['Mailbox/get', { accountId: 'acc-1' }, '0']],
      );
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
});
