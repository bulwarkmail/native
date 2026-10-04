import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    learnHoldLimit: vi.fn(),
    getSubmissionAccountIds: vi.fn(() => ['acc-1']),
    hasDelayedSend: vi.fn(() => true),
    getMaxCallsInRequest: vi.fn(() => 16),
    getMaxObjectsInGet: vi.fn(() => 500),
    getMaxObjectsInSet: vi.fn(() => 500),
  },
}));

import { jmapClient } from '../jmap-client';
import { sendEmail } from '../email';
import {
  formatRejectedRecipients,
  RecipientsRejectedError,
  rejectedRecipients,
  SendUnconfirmedError,
} from '../jmap-result';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

const OUTGOING = {
  from: [{ email: 'me@example.com' }],
  to: [{ email: 'you@example.com' }],
  subject: 'Hello',
  textBody: 'Hi there',
};

/** Resolves the send request: the created message and submission, then `extra`. */
function respond(extra: unknown[]) {
  mockRequest.mockResolvedValueOnce({
    methodResponses: [
      ['Email/set', { created: { draft: { id: 'email-9' } } }, '0'],
      ['EmailSubmission/set', { created: { 'sub-1': { id: 'sub-9' } } }, '1'],
      ...extra,
    ],
  });
}

/** Ids of every Email/set destroy the code under test issued. */
function destroyedIds(): string[] {
  return mockRequest.mock.calls.flatMap(([calls]) =>
    (calls as [string, { destroy?: string[] }][])
      .filter(([method]) => method === 'Email/set')
      .flatMap(([, args]) => args.destroy ?? []),
  );
}

const REFUSED = [['EmailSubmission/get', { list: [{ deliveryStatus: {
  'gone@example.com': { delivered: 'no', smtpReply: '550 5.1.1 No such user' },
} }] }, 'deliveryStatus']];
const DESTROYED = { methodResponses: [['Email/set', { destroyed: ['email-9'] }, '0']] };

describe('sendEmail delivery confirmation', () => {
  it('asks for the new submission deliveryStatus in the send request', async () => {
    respond([['EmailSubmission/get', { list: [{ id: 'sub-9', deliveryStatus: {} }] }, 'deliveryStatus']]);
    await sendEmail(OUTGOING, 'id-1', 'sent-1');
    expect(mockRequest.mock.calls[0][0][2]).toEqual(
      ['EmailSubmission/get', { accountId: 'acc-1', ids: ['#sub-1'], properties: ['deliveryStatus'] }, 'deliveryStatus'],
    );
  });

  it('returns the refused recipients when the others were accepted', async () => {
    respond([['EmailSubmission/get', { list: [{ deliveryStatus: {
      'ok@example.com': { delivered: 'queued', smtpReply: '250 2.1.5 OK' },
      'gone@example.com': { delivered: 'no', smtpReply: '550 5.1.1 No such user' },
    } }] }, 'deliveryStatus']]);
    const result = await sendEmail(OUTGOING, 'id-1', 'sent-1');
    expect(result.rejectedRecipients).toEqual([{ email: 'gone@example.com', smtpReply: '550 5.1.1 No such user' }]);
  });

  it('fails the send, removes the filed copy and keeps the old draft when every recipient was refused', async () => {
    respond(REFUSED);
    mockRequest.mockResolvedValueOnce(DESTROYED);
    const err = await sendEmail(OUTGOING, 'id-1', 'sent-1', undefined, { draftId: 'draft-1' }).catch((e) => e);
    expect(err).toBeInstanceOf(RecipientsRejectedError);
    expect(destroyedIds()).toEqual(['email-9']); // never 'draft-1'
  });

  it('also fails a held send whose recipients were all refused', async () => {
    respond(REFUSED);
    mockRequest.mockResolvedValueOnce(DESTROYED);
    const err = await sendEmail(OUTGOING, 'id-1', 'sent-1', 30, { draftId: 'draft-1' }).catch((e) => e);
    expect(err).toBeInstanceOf(RecipientsRejectedError);
    expect(destroyedIds()).toEqual(['email-9']);
  });

  it('throws SendUnconfirmedError when the response has no EmailSubmission/set', async () => {
    mockRequest.mockResolvedValueOnce({ methodResponses: [['Email/set', { created: { draft: { id: 'email-9' } } }, '0']] });
    await expect(sendEmail(OUTGOING, 'id-1', 'sent-1')).rejects.toBeInstanceOf(SendUnconfirmedError);
    expect(destroyedIds()).toEqual([]); // the copy may be the only record that it went out
  });

  it('keeps the old draft too when the send is unconfirmed', async () => {
    mockRequest.mockResolvedValueOnce({ methodResponses: [['Email/set', { created: { draft: { id: 'email-9' } } }, '0']] });
    await expect(sendEmail(OUTGOING, 'id-1', 'sent-1', undefined, { draftId: 'draft-1' })).rejects.toBeInstanceOf(SendUnconfirmedError);
    expect(destroyedIds()).toEqual([]);
  });

  it('drops the old draft when only some recipients were refused', async () => {
    respond([['EmailSubmission/get', { list: [{ deliveryStatus: {
      'ok@example.com': { delivered: 'queued', smtpReply: '250 2.1.5 OK' },
      'gone@example.com': { delivered: 'no', smtpReply: '550 5.1.1 No such user' },
    } }] }, 'deliveryStatus']]);
    mockRequest.mockResolvedValueOnce({ methodResponses: [['Email/set', { destroyed: ['draft-1'] }, '0']] });
    await sendEmail(OUTGOING, 'id-1', 'sent-1', undefined, { draftId: 'draft-1' });
    expect(destroyedIds()).toEqual(['draft-1']);
  });

  it('treats a missing or failed read-back as a plain success', async () => {
    respond([['error', { type: 'unknownMethod' }, 'deliveryStatus']]);
    await expect(sendEmail(OUTGOING, 'id-1', 'sent-1')).resolves.toMatchObject({ emailSubmissionId: 'sub-9' });
    respond([]);
    await expect(sendEmail(OUTGOING, 'id-1', 'sent-1')).resolves.toMatchObject({ emailSubmissionId: 'sub-9' });
  });

  // Regression guard: native already reported notCreated before the read-back existed.
  it('reports a refused submission by its own error, not the dangling read-back', async () => {
    mockRequest.mockResolvedValueOnce({ methodResponses: [
      ['Email/set', { created: { draft: { id: 'email-9' } } }, '0'],
      ['EmailSubmission/set', { notCreated: { 'sub-1': { type: 'forbiddenFrom', description: 'Not allowed' } } }, '1'],
      ['error', { type: 'invalidResultReference' }, 'deliveryStatus'],
    ] });
    mockRequest.mockResolvedValueOnce(DESTROYED);
    await expect(sendEmail(OUTGOING, 'id-1', 'sent-1')).rejects.toThrow('Not allowed');
  });
});

describe('rejectedRecipients', () => {
  it('reports nothing refused for an empty or missing map', () => {
    expect(rejectedRecipients({})).toEqual({ rejected: [], all: false });
    expect(rejectedRecipients(undefined)).toEqual({ rejected: [], all: false });
  });

  it('flags all when every recipient was refused', () => {
    const r = rejectedRecipients({ 'a@x': { delivered: 'no', smtpReply: ' 550 gone ' } });
    expect(r).toEqual({ rejected: [{ email: 'a@x', smtpReply: '550 gone' }], all: true });
  });

  it('does not flag all when one was accepted', () => {
    const r = rejectedRecipients({ 'a@x': { delivered: 'no' }, 'b@y': { delivered: 'queued' } });
    expect(r.all).toBe(false);
    expect(r.rejected).toHaveLength(1);
  });
});

describe('formatRejectedRecipients', () => {
  it('joins recipients with their replies', () => {
    expect(formatRejectedRecipients([
      { email: 'a@x', smtpReply: '550 5.1.2 No' },
      { email: 'b@y', smtpReply: '' },
    ])).toBe('a@x (550 5.1.2 No), b@y');
  });
});
