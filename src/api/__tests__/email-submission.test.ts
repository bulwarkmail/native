import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    learnHoldLimit: vi.fn(),
    getMaxCallsInRequest: vi.fn(() => 16),
    getMaxObjectsInGet: vi.fn(() => 500),
    getMaxObjectsInSet: vi.fn(() => 500),
  },
}));

import { jmapClient } from '../jmap-client';
import { rescheduleScheduledSend, sendEmail } from '../email';
import { ScheduleTooLateError } from '../jmap-result';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

const SCHEDULED = {
  emailSubmissionId: 'sub-1',
  emailId: 'e-1',
  identityId: 'id-1',
  from: [{ email: 'news@shop.example' }],
  to: [{ email: 'to@example.com' }],
};

const REPLACED = [['EmailSubmission/set', {
  updated: { 'sub-1': null },
  created: { replacement: { id: 'sub-2', sendAt: '2026-09-25T08:00:00Z' } },
}, '0']];

describe('rescheduleScheduledSend', () => {
  it('keeps Cc, Bcc and the envelope sender of the held submission (B19)', async () => {
    mockRequest
      .mockResolvedValueOnce({
        methodResponses: [
          ['EmailSubmission/get', {
            list: [{
              id: 'sub-1',
              envelope: {
                mailFrom: { email: 'me@example.com', parameters: { HOLDFOR: '3600' } },
                rcptTo: [
                  { email: 'to@example.com', parameters: null },
                  { email: 'cc@example.com', parameters: null },
                  { email: 'bcc@example.com', parameters: null },
                ],
              },
            }],
          }, '0'],
          ['Email/get', { list: [{ id: 'e-1', to: [{ email: 'to@example.com' }], cc: [{ email: 'cc@example.com' }] }] }, '1'],
        ],
      })
      .mockResolvedValueOnce({ methodResponses: REPLACED });

    const result = await rescheduleScheduledSend(SCHEDULED, 7200);

    expect(result).toEqual({ emailSubmissionId: 'sub-2', sendAt: '2026-09-25T08:00:00Z' });
    const [lookup] = mockRequest.mock.calls[0][0];
    expect(lookup).toEqual(['EmailSubmission/get', { accountId: 'acc-1', ids: ['sub-1'], properties: ['envelope'] }, '0']);
    const args = mockRequest.mock.calls[1][0][0][1];
    expect(args.update).toEqual({ 'sub-1': { undoStatus: 'canceled' } });
    expect(args.create.replacement.envelope).toEqual({
      mailFrom: { email: 'me@example.com', parameters: { HOLDFOR: '7200' } },
      rcptTo: [{ email: 'to@example.com' }, { email: 'cc@example.com' }, { email: 'bcc@example.com' }],
    });
  });

  it("falls back to the message's To, Cc and Bcc when the submission has no envelope", async () => {
    mockRequest
      .mockResolvedValueOnce({
        methodResponses: [
          ['EmailSubmission/get', { list: [{ id: 'sub-1', envelope: null }] }, '0'],
          ['Email/get', {
            list: [{
              id: 'e-1',
              to: [{ email: 'to@example.com' }],
              cc: [{ name: 'Cc', email: 'cc@example.com' }],
              bcc: [{ email: ' bcc@example.com ' }],
            }],
          }, '1'],
        ],
      })
      .mockResolvedValueOnce({ methodResponses: REPLACED });

    await rescheduleScheduledSend(SCHEDULED, 60);

    expect(mockRequest.mock.calls[1][0][0][1].create.replacement.envelope).toEqual({
      mailFrom: { email: 'news@shop.example', parameters: { HOLDFOR: '60' } },
      rcptTo: [{ email: 'to@example.com' }, { email: 'cc@example.com' }, { email: 'bcc@example.com' }],
    });
  });

  it('sends now without a lookup and lets the server derive the envelope', async () => {
    mockRequest.mockResolvedValueOnce({ methodResponses: REPLACED });

    await rescheduleScheduledSend(SCHEDULED, 0);

    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest.mock.calls[0][0][0][1].create.replacement).toEqual({ emailId: 'e-1', identityId: 'id-1' });
  });
});

describe('sendEmail', () => {
  const OUTGOING = {
    from: [{ email: 'me@example.com' }],
    to: [{ email: 'you@example.com' }],
    subject: 'Hello',
    textBody: 'Hi',
  };

  it('reports a failed post-send filing as a warning, not a failed send (B23)', async () => {
    // Stalwart answers the implicit onSuccessUpdateEmail Email/set with a
    // method error after the submission was created: the mail went out.
    mockRequest.mockResolvedValueOnce({
      methodResponses: [
        ['Email/set', { created: { draft: { id: 'e-new' } } }, '0'],
        ['EmailSubmission/set', { created: { 'sub-1': { id: 's-1', sendAt: '2026-09-24T10:00:30Z' } } }, '1'],
        ['error', { type: 'forbidden', description: 'You do not have access to this mailbox' }, '1'],
      ],
    });

    const result = await sendEmail(OUTGOING, 'identity-1', 'sent-mb', 30, { draftsMailboxId: 'drafts-mb' });

    expect(result).toMatchObject({
      scheduled: true,
      emailId: 'e-new',
      emailSubmissionId: 's-1',
      sendAt: '2026-09-24T10:00:30Z',
      filingWarning: 'You do not have access to this mailbox',
    });
  });

  it('still fails when the submission itself was refused', async () => {
    mockRequest.mockResolvedValueOnce({
      methodResponses: [
        ['Email/set', { created: { draft: { id: 'e-new' } } }, '0'],
        ['error', { type: 'invalidArguments', description: 'Invalid envelope' }, '1'],
      ],
    });

    await expect(sendEmail(OUTGOING, 'identity-1', 'sent-mb', undefined, { draftsMailboxId: 'drafts-mb' }))
      .rejects.toThrow('Invalid envelope');
  });

  it('still fails when the message could not be created', async () => {
    mockRequest.mockResolvedValueOnce({
      methodResponses: [
        ['error', { type: 'serverFail', description: 'Disk full' }, '0'],
        ['EmailSubmission/set', { notCreated: { 'sub-1': { type: 'invalidProperties' } } }, '1'],
      ],
    });

    await expect(sendEmail(OUTGOING, 'identity-1', 'sent-mb')).rejects.toThrow('Disk full');
  });
});

describe('hold-limit rejections', () => {
  const HOLD_REJECTED = {
    type: 'forbiddenMailFrom',
    description: 'Server rejected MAIL-FROM: 501 5.5.4 Requested hold time exceeds maximum of 172800 seconds.',
  };

  it('turns a refused send-later into ScheduleTooLateError and learns the limit', async () => {
    mockRequest.mockResolvedValueOnce({
      methodResponses: [
        ['Email/set', { created: { draft: { id: 'e-new' } } }, '0'],
        ['EmailSubmission/set', { notCreated: { 'sub-1': HOLD_REJECTED } }, '1'],
      ],
    });

    const err = await sendEmail(
      { from: [{ email: 'me@example.com' }], to: [{ email: 'you@example.com' }], subject: 'Later', textBody: 'x' },
      'identity-1',
      'sent-mb',
      5 * 24 * 3600,
      { draftsMailboxId: 'drafts-mb' },
    ).catch((e) => e);

    expect(err).toBeInstanceOf(ScheduleTooLateError);
    expect(err.maxSeconds).toBe(172_800);
    expect(jmapClient.learnHoldLimit).toHaveBeenCalledWith(172_800);
  });

  it('keeps other submission errors as they are', async () => {
    mockRequest.mockResolvedValueOnce({
      methodResponses: [
        ['Email/set', { created: { draft: { id: 'e-new' } } }, '0'],
        ['EmailSubmission/set', { notCreated: { 'sub-1': { type: 'forbiddenFrom', description: 'Not your address' } } }, '1'],
      ],
    });

    const err = await sendEmail(
      { from: [{ email: 'me@example.com' }], to: [{ email: 'you@example.com' }], subject: 'Now', textBody: 'x' },
      'identity-1',
      'sent-mb',
    ).catch((e) => e);

    expect(err).not.toBeInstanceOf(ScheduleTooLateError);
    expect(err.message).toBe('Not your address');
    expect(jmapClient.learnHoldLimit).not.toHaveBeenCalled();
  });

  it('turns a refused reschedule into ScheduleTooLateError', async () => {
    mockRequest
      .mockResolvedValueOnce({
        methodResponses: [
          ['EmailSubmission/get', { list: [{ id: 'sub-1', envelope: { mailFrom: { email: 'me@example.com' }, rcptTo: [{ email: 'to@example.com' }] } }] }, '0'],
          ['Email/get', { list: [] }, '1'],
        ],
      })
      .mockResolvedValueOnce({
        methodResponses: [['EmailSubmission/set', { updated: { 'sub-1': null }, notCreated: { replacement: HOLD_REJECTED } }, '0']],
      });

    const err = await rescheduleScheduledSend(SCHEDULED, 5 * 24 * 3600).catch((e) => e);

    expect(err).toBeInstanceOf(ScheduleTooLateError);
    expect(jmapClient.learnHoldLimit).toHaveBeenCalledWith(172_800);
  });
});
