import { describe, it, expect, vi, beforeEach } from 'vitest';

// Sending an uploaded raw message (#58): a signed or encrypted PGP / S/MIME
// message is added with Email/import and submitted like any other, and the
// envelope names every recipient, Bcc included, since the raw headers don't.

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    learnHoldLimit: vi.fn(),
    getSubmissionAccountIds: vi.fn(() => ['acc-1']),
    hasDelayedSend: vi.fn(() => true),
    hasAccountCapability: vi.fn(() => false),
    getMaxCallsInRequest: vi.fn(() => 16),
    getMaxObjectsInGet: vi.fn(() => 500),
    getMaxObjectsInSet: vi.fn(() => 500),
    getAccountCapability: vi.fn(),
  },
}));

import { jmapClient } from '../jmap-client';
import { sendEmail } from '../email';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

const OUTGOING = {
  from: [{ email: 'me@example.com' }],
  to: [{ email: 'you@example.com' }],
  bcc: [{ email: 'hidden@example.com' }],
  subject: 'Secret',
  textBody: 'not sent as is',
};

beforeEach(() => {
  vi.clearAllMocks();
  mockRequest.mockResolvedValue({
    methodResponses: [
      ['Email/import', { created: { draft: { id: 'e-raw' } } }, '0'],
      ['EmailSubmission/set', { created: { 'sub-1': { id: 's-1' } } }, '1'],
    ],
  });
});

describe('sendEmail with a raw blob', () => {
  it('imports the blob into Drafts, submits it with every recipient in the envelope and files it in Sent', async () => {
    const result = await sendEmail(OUTGOING, 'id-1', 'sent', undefined, { draftsMailboxId: 'drafts', rawBlobId: 'blob-raw' });
    const calls = mockRequest.mock.calls[0][0] as Array<[string, Record<string, any>, string]>;
    expect(calls.find(([name]) => name === 'Email/set')).toBeUndefined();
    const [, importArgs] = calls.find(([name]) => name === 'Email/import')!;
    expect(importArgs.emails.draft).toEqual({ blobId: 'blob-raw', mailboxIds: { drafts: true }, keywords: { $seen: true, $draft: true } });
    const submission = calls.find(([name]) => name === 'EmailSubmission/set')![1];
    expect(submission.create['sub-1'].emailId).toBe('#draft');
    expect(submission.create['sub-1'].envelope).toEqual({
      mailFrom: { email: 'me@example.com' },
      rcptTo: [{ email: 'you@example.com' }, { email: 'hidden@example.com' }],
    });
    expect(submission.onSuccessUpdateEmail['#sub-1'].mailboxIds).toEqual({ sent: true });
    expect(result.emailId).toBe('e-raw');
    expect(result.emailSubmissionId).toBe('s-1');
  });

  it('reports an import the server refused', async () => {
    mockRequest.mockResolvedValueOnce({
      methodResponses: [
        ['Email/import', { notCreated: { draft: { type: 'invalidEmail', description: 'bad message' } } }, '0'],
        ['EmailSubmission/set', { notCreated: { 'sub-1': { type: 'invalidProperties' } } }, '1'],
      ],
    });
    await expect(sendEmail(OUTGOING, 'id-1', 'sent', undefined, { rawBlobId: 'blob-raw' })).rejects.toThrow(/bad message/);
  });
});
