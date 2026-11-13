import { describe, it, expect, vi, beforeEach } from 'vitest';

// Sending a phishing report (#124): one message to the admin's address with
// the original attached unchanged, from the login's own account, and no copy
// kept (onSuccessDestroyEmail in place of the move to Sent).

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-own',
    username: 'alice@example.org',
    request: vi.fn(),
    learnHoldLimit: vi.fn(),
    getSubmissionAccountIds: vi.fn(() => ['acc-own']),
    hasDelayedSend: vi.fn(() => true),
    hasAccountCapability: vi.fn(() => false),
    getMaxCallsInRequest: vi.fn(() => 16),
    getMaxObjectsInGet: vi.fn(() => 500),
    getMaxObjectsInSet: vi.fn(() => 500),
    getMaxSizeUpload: vi.fn(() => 50_000_000),
    getAccountCapability: vi.fn(),
  },
}));
vi.mock('../identity', () => ({
  getIdentities: vi.fn(async () => [
    { id: 'id-team', name: 'Team', email: 'team@example.org', mayDelete: true },
    { id: 'id-me', name: 'Alice', email: 'alice@example.org', mayDelete: false },
  ]),
}));
vi.mock('../blob', () => ({ uploadBytes: vi.fn(async () => ({ blobId: 'blob-arf' })) }));
vi.mock('../../lib/email-export', () => ({
  fetchBlobBytes: vi.fn(async () => new TextEncoder().encode('From: bad@phish.example\r\n\r\nclick\r\n')),
}));

import { jmapClient } from '../jmap-client';
import { uploadBytes } from '../blob';
import { fetchBlobBytes } from '../../lib/email-export';
import { markAsSpam } from '../email';
import { sendPhishingReport } from '../phishing-report';
import type { Email } from '../types';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

const ORIGINAL = {
  id: 'e1', blobId: 'blob-orig', size: 1234, subject: 'Your account is locked', receivedAt: '2026-11-12T09:00:00Z',
  from: [{ email: 'bad@phish.example' }], keywords: {}, mailboxIds: { inbox: true },
} as unknown as Email;

const SENT = {
  methodResponses: [
    ['Email/set', { created: { draft: { id: 'e-report' } } }, '0'],
    ['EmailSubmission/set', { created: { 'sub-1': { id: 's-1' } } }, '1'],
    ['Email/set', { destroyed: ['e-report'] }, '1'],
  ],
};

function call(name: string, n = 0): Record<string, any> {
  const calls = mockRequest.mock.calls.flatMap(([c]) => c as Array<[string, Record<string, any>, string]>);
  return calls.filter(([method]) => method === name)[n]![1];
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequest.mockResolvedValue(SENT);
});

describe('a forwarded report', () => {
  it('attaches the original by its blob, from the login\'s own address, and keeps no copy', async () => {
    await sendPhishingReport(ORIGINAL, {
      sourceAccountId: 'acc-own',
      setup: { address: 'security@example.org', format: 'forward' },
      stagingMailboxId: 'drafts',
      appVersion: '0.1.95',
    });
    const create = call('Email/set').create.draft;
    expect(create.from).toEqual([{ name: 'Alice', email: 'alice@example.org' }]);
    expect(create.to).toEqual([{ email: 'security@example.org' }]);
    expect(create.subject).toBe('Phishing: Your account is locked');
    expect(create.bodyValues.text.value).toContain('Reported as phishing by Alice <alice@example.org>');
    expect(create.attachments).toEqual([expect.objectContaining({
      blobId: 'blob-orig', type: 'message/rfc822', size: 1234, disposition: 'attachment',
    })]);
    expect(create.attachments[0].name).toMatch(/\.eml$/);
    expect(create.mailboxIds).toEqual({ drafts: true });
    const submission = call('EmailSubmission/set');
    expect(submission.create['sub-1'].identityId).toBe('id-me');
    expect(submission.onSuccessDestroyEmail).toEqual(['#sub-1']);
    expect(submission.onSuccessUpdateEmail).toBeUndefined();
    expect(mockRequest.mock.calls.flatMap(([c]) => c).some(([m]: [string]) => m === 'Blob/copy')).toBe(false);
  });

  it('copies the blob of a shared mailbox\'s message to the sending account first', async () => {
    mockRequest.mockResolvedValueOnce({ methodResponses: [['Blob/copy', { copied: { 'blob-orig': 'blob-copy' } }, '0']] });
    await sendPhishingReport(ORIGINAL, {
      sourceAccountId: 'grp-1',
      setup: { address: 'security@example.org', format: 'forward' },
      stagingMailboxId: 'drafts',
      appVersion: '0.1.95',
    });
    expect(call('Blob/copy')).toEqual({ fromAccountId: 'grp-1', accountId: 'acc-own', blobIds: ['blob-orig'] });
    expect(call('Email/set').create.draft.attachments[0].blobId).toBe('blob-copy');
  });

  it('throws when the server refuses the submission, and removes the copy it made', async () => {
    mockRequest.mockResolvedValueOnce({
      methodResponses: [
        ['Email/set', { created: { draft: { id: 'e-report' } } }, '0'],
        ['EmailSubmission/set', { notCreated: { 'sub-1': { type: 'forbiddenFrom' } } }, '1'],
      ],
    });
    mockRequest.mockResolvedValueOnce({ methodResponses: [['Email/set', { destroyed: ['e-report'] }, '0']] });
    await expect(sendPhishingReport(ORIGINAL, {
      sourceAccountId: 'acc-own',
      setup: { address: 'security@example.org', format: 'forward' },
      stagingMailboxId: 'drafts',
      appVersion: '0.1.95',
    })).rejects.toThrow();
    expect(call('Email/set', 1).destroy).toEqual(['e-report']);
  });
});

describe('an ARF report', () => {
  it('downloads the original from its own account, uploads the report and submits it raw, with no copy', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [
        ['Email/import', { created: { draft: { id: 'e-report' } } }, '0'],
        ['EmailSubmission/set', { created: { 'sub-1': { id: 's-1' } } }, '1'],
      ],
    });
    await sendPhishingReport(ORIGINAL, {
      sourceAccountId: 'grp-1',
      setup: { address: 'security@example.org', format: 'arf' },
      stagingMailboxId: 'drafts',
      appVersion: '0.1.95',
    });
    expect(fetchBlobBytes).toHaveBeenCalledWith('blob-orig', 'message.eml', 'message/rfc822', 'grp-1');
    const [bytes, type, accountId] = (uploadBytes as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(type).toBe('message/rfc822');
    expect(accountId).toBe('acc-own');
    const text = new TextDecoder().decode(bytes as Uint8Array);
    expect(text).toContain('report-type=feedback-report');
    expect(text).toContain('User-Agent: Bulwark/0.1.95');
    expect(text).toContain('From: bad@phish.example\r\n\r\nclick\r\n');
    expect(call('Email/import').emails.draft).toEqual(expect.objectContaining({ blobId: 'blob-arf', mailboxIds: { drafts: true } }));
    const submission = call('EmailSubmission/set');
    expect(submission.create['sub-1'].envelope.rcptTo).toEqual([{ email: 'security@example.org' }]);
    expect(submission.onSuccessDestroyEmail).toEqual(['#sub-1']);
  });

  it('is refused before downloading a message too big for the server\'s upload limit', async () => {
    (jmapClient.getMaxSizeUpload as ReturnType<typeof vi.fn>).mockReturnValueOnce(1000);
    await expect(sendPhishingReport(ORIGINAL, {
      sourceAccountId: 'acc-own',
      setup: { address: 'security@example.org', format: 'arf' },
      stagingMailboxId: 'drafts',
      appVersion: '0.1.95',
    })).rejects.toThrow(/too big/);
    expect(fetchBlobBytes).not.toHaveBeenCalled();
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe('markAsSpam', () => {
  it('sets a report\'s further keywords with $junk', async () => {
    mockRequest.mockResolvedValue({ methodResponses: [['Email/set', { updated: { e1: null } }, '0']] });
    await markAsSpam(['e1'], 'junk', 'acc-own', { markRead: true, keywords: ['$phishing'] });
    expect(call('Email/set').update.e1).toEqual({
      mailboxIds: { junk: true },
      'keywords/$junk': true,
      'keywords/$notjunk': null,
      'keywords/$seen': true,
      'keywords/$phishing': true,
    });
  });
});
