import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    learnHoldLimit: vi.fn(),
    getSubmissionAccountIds: vi.fn(() => ['acc-1']),
    hasDelayedSend: vi.fn(() => true),
    // Not Stalwart: sends keep their submission record (see
    // email-submission-cleanup.test.ts for the Stalwart paths).
    hasAccountCapability: vi.fn(() => false),
    getMaxCallsInRequest: vi.fn(() => 16),
    getMaxObjectsInGet: vi.fn(() => 500),
    getMaxObjectsInSet: vi.fn(() => 500),
  },
}));

import { jmapClient } from '../jmap-client';
import {
  cancelScheduledSend, listScheduledEmails, RescheduleLostError, RescheduleRestoredError, rescheduleScheduledSend,
  sendEmail, SendUnconfirmedError,
} from '../email';
import { NoLongerScheduledError, ScheduleTooLateError } from '../jmap-result';

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

const ORIGINAL_AT = new Date(Date.now() + 3600_000).toISOString();
const LOOKUP = {
  methodResponses: [
    ['EmailSubmission/get', {
      list: [{
        id: 'sub-1',
        sendAt: ORIGINAL_AT,
        envelope: { mailFrom: { email: 'me@example.com' }, rcptTo: [{ email: 'to@example.com' }] },
      }],
    }, '0'],
    ['Email/get', { list: [{ id: 'e-1', to: [{ email: 'to@example.com' }] }] }, '1'],
    ['Mailbox/get', { list: [{ id: 'mb-drafts', role: 'drafts' }, { id: 'mb-sent', role: 'sent' }, { id: 'mb-in', role: 'inbox' }] }, '2'],
  ],
};
const REPLACED = [['EmailSubmission/set', {
  created: { replacement: { id: 'sub-2', sendAt: '2026-09-25T08:00:00Z' } },
}, '0']];
const set = (body: Record<string, unknown>) => ({ methodResponses: [['EmailSubmission/set', body, '0']] });
const CANCELLED = set({ updated: { 'sub-1': null } });
/** A confirmed cancel is followed by the destroy of the canceled record. */
const DESTROYED = (id: string) => set({ destroyed: [id] });
/** The EmailSubmission/set calls made, as [create ids, update ids, destroyed ids]. */
const setCalls = () => mockRequest.mock.calls
  .map((c) => c[0][0])
  .filter(([method]: [string]) => method === 'EmailSubmission/set')
  .map(([, args]: [string, { create?: object; update?: Record<string, unknown>; destroy?: string[] }]) => [
    Object.keys(args.create ?? {}),
    Object.keys(args.update ?? {}),
    args.destroy ?? [],
  ]);
/** The replacement create of the n-th EmailSubmission/set create call. */
const createdArgs = (n = 0) => mockRequest.mock.calls
  .map((c) => c[0][0])
  .filter(([method, args]: [string, { create?: object }]) => method === 'EmailSubmission/set' && args.create)[n][1];
const REFUSED = (description: string) => set({ notCreated: { replacement: { type: 'forbiddenToSend', description } } });

describe('rescheduleScheduledSend', () => {
  afterEach(() => {
    mockRequest.mockReset();
  });

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
      .mockResolvedValueOnce(CANCELLED)
      .mockResolvedValueOnce(DESTROYED('sub-1'))
      .mockResolvedValueOnce({ methodResponses: REPLACED });

    const result = await rescheduleScheduledSend(SCHEDULED, 7200);

    expect(result).toEqual({ emailSubmissionId: 'sub-2', sendAt: '2026-09-25T08:00:00Z' });
    const [lookup] = mockRequest.mock.calls[0][0];
    expect(lookup).toEqual([
      'EmailSubmission/get', { accountId: 'acc-1', ids: ['sub-1'], properties: ['envelope', 'sendAt', 'identityId'] }, '0',
    ]);
    expect(createdArgs().create.replacement.envelope).toEqual({
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
      .mockResolvedValueOnce(CANCELLED)
      .mockResolvedValueOnce(DESTROYED('sub-1'))
      .mockResolvedValueOnce({ methodResponses: REPLACED });

    await rescheduleScheduledSend(SCHEDULED, 60);

    expect(createdArgs().create.replacement.envelope).toEqual({
      mailFrom: { email: 'news@shop.example', parameters: { HOLDFOR: '60' } },
      rcptTo: [{ email: 'to@example.com' }, { email: 'cc@example.com' }, { email: 'bcc@example.com' }],
    });
  });

  // #1308: some servers refuse a second active submission for one Email, and
  // some undo onSuccessUpdateEmail on cancel, pulling the message back out of
  // Sent once the original went after its replacement.
  it('cancels the original and removes its record before it creates the replacement, which files the message in Sent', async () => {
    mockRequest
      .mockResolvedValueOnce(LOOKUP)
      .mockResolvedValueOnce(CANCELLED)
      .mockResolvedValueOnce(DESTROYED('sub-1'))
      .mockResolvedValueOnce({ methodResponses: REPLACED });

    await rescheduleScheduledSend(SCHEDULED, 7200);

    expect(setCalls()).toEqual([[[], ['sub-1'], []], [[], [], ['sub-1']], [['replacement'], [], []]]);
    expect(mockRequest.mock.calls[1][0][0][1].update).toEqual({ 'sub-1': { undoStatus: 'canceled' } });
    expect(createdArgs().onSuccessUpdateEmail).toEqual({
      '#replacement': { mailboxIds: { 'mb-sent': true }, 'keywords/$draft': null },
    });
  });

  it('sends now as a 1-second hold', async () => {
    mockRequest
      .mockResolvedValueOnce(LOOKUP)
      .mockResolvedValueOnce(CANCELLED)
      .mockResolvedValueOnce(DESTROYED('sub-1'))
      .mockResolvedValueOnce({ methodResponses: REPLACED });

    await rescheduleScheduledSend(SCHEDULED, 0);

    expect(createdArgs().create.replacement.envelope).toEqual({
      mailFrom: { email: 'me@example.com', parameters: { HOLDFOR: '1' } },
      rcptTo: [{ email: 'to@example.com' }],
    });
  });

  it('changes nothing when the original has already gone out', async () => {
    mockRequest
      .mockResolvedValueOnce(LOOKUP)
      .mockResolvedValueOnce(set({ notUpdated: { 'sub-1': { type: 'cannotUnsend', description: 'Already sent' } } }))
      .mockResolvedValueOnce({ methodResponses: [['EmailSubmission/get', { list: [{ id: 'sub-1', undoStatus: 'final' }] }, '0']] });

    const err = await rescheduleScheduledSend(SCHEDULED, 0).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(NoLongerScheduledError);
    expect(err).toMatchObject({ sent: true });
    // No replacement: it would send the message a second time.
    expect(setCalls()).toEqual([[[], ['sub-1'], []]]);
  });

  it('changes nothing and reports the failure when the cancel fails while the original is still due', async () => {
    mockRequest
      .mockResolvedValueOnce(LOOKUP)
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce({ methodResponses: [['EmailSubmission/get', { list: [{ id: 'sub-1', undoStatus: 'pending' }] }, '0']] });

    await expect(rescheduleScheduledSend(SCHEDULED, 7200)).rejects.toThrow('Network request failed');
    expect(setCalls()).toEqual([[[], ['sub-1'], []]]);
  });

  it('puts the original back at its old time, under a new id, when the replacement is refused', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(ORIGINAL_AT) - 1800_000);
    mockRequest
      .mockResolvedValueOnce(LOOKUP)
      .mockResolvedValueOnce(CANCELLED)
      .mockResolvedValueOnce(DESTROYED('sub-1'))
      .mockResolvedValueOnce(REFUSED('Quota exceeded'))
      .mockResolvedValueOnce(set({ created: { replacement: { id: 'sub-3' } } }));

    const err = await rescheduleScheduledSend(SCHEDULED, 7200).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RescheduleRestoredError);
    expect(err).toMatchObject({ restoredSubmissionId: 'sub-3', restoredSendAt: ORIGINAL_AT, message: 'Quota exceeded' });
    // Half an hour was left of the original hold.
    expect(createdArgs(1).create.replacement.envelope.mailFrom.parameters).toEqual({ HOLDFOR: '1800' });
    vi.mocked(Date.now).mockRestore();
  });

  describe('answers that never came', () => {
    const status = (undoStatus: string) => ({
      methodResponses: [['EmailSubmission/get', { list: [{ id: 'sub-1', undoStatus }] }, '0']],
    });
    const records = (list: Array<Record<string, unknown>>) => ({
      methodResponses: [
        ['EmailSubmission/query', { ids: list.map((s) => s.id) }, '0'],
        ['EmailSubmission/get', { list }, '1'],
      ],
    });
    const creates = () => setCalls().filter(([created]) => created.length > 0).length;

    it('goes on to the replacement when the cancel went through but its answer was lost', async () => {
      mockRequest
        .mockResolvedValueOnce(LOOKUP)
        .mockRejectedValueOnce(new Error('Request timed out'))
        .mockResolvedValueOnce(status('canceled'))
        .mockResolvedValueOnce(DESTROYED('sub-1'))
        .mockResolvedValueOnce({ methodResponses: REPLACED });

      const result = await rescheduleScheduledSend(SCHEDULED, 0);

      expect(result.emailSubmissionId).toBe('sub-2');
      // The canceled record goes, as after a confirmed cancel.
      expect(setCalls()).toEqual([[[], ['sub-1'], []], [[], [], ['sub-1']], [['replacement'], [], []]]);
    });

    it('still makes no replacement when the server refused the cancel and the original was cancelled elsewhere', async () => {
      mockRequest
        .mockResolvedValueOnce(LOOKUP)
        .mockResolvedValueOnce(set({ notUpdated: { 'sub-1': { type: 'invalidProperties' } } }))
        .mockResolvedValueOnce(status('canceled'));

      const err = await rescheduleScheduledSend(SCHEDULED, 0).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(NoLongerScheduledError);
      expect(creates()).toBe(0);
    });

    it('takes a replacement the server made for the answer that was lost, and does not put the original back', async () => {
      mockRequest
        .mockResolvedValueOnce(LOOKUP)
        .mockResolvedValueOnce(CANCELLED)
        .mockResolvedValueOnce(DESTROYED('sub-1'))
        .mockRejectedValueOnce(new Error('Request timed out'))
        .mockResolvedValueOnce(records([
          { id: 'sub-1', emailId: 'e-1', undoStatus: 'canceled' },
          { id: 'sub-2', emailId: 'e-1', undoStatus: 'final', sendAt: '2026-09-25T08:00:00Z' },
        ]));

      const result = await rescheduleScheduledSend(SCHEDULED, 0);

      expect(result).toEqual({ emailSubmissionId: 'sub-2', sendAt: '2026-09-25T08:00:00Z' });
      expect(creates()).toBe(1);
      const [query] = mockRequest.mock.calls.at(-1)![0];
      expect(query).toEqual(['EmailSubmission/query', { accountId: 'acc-1', filter: { emailIds: ['e-1'] } }, '0']);
    });

    it('puts the original back when the lost create left nothing on the server', async () => {
      mockRequest
        .mockResolvedValueOnce(LOOKUP)
        .mockResolvedValueOnce(CANCELLED)
        .mockResolvedValueOnce(DESTROYED('sub-1'))
        .mockRejectedValueOnce(new Error('Request timed out'))
        .mockResolvedValueOnce(records([{ id: 'sub-1', emailId: 'e-1', undoStatus: 'canceled' }]))
        .mockResolvedValueOnce(set({ created: { replacement: { id: 'sub-3' } } }));

      const err = await rescheduleScheduledSend(SCHEDULED, 7200).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(RescheduleRestoredError);
      expect(err).toMatchObject({ restoredSubmissionId: 'sub-3' });
    });

    it('counts a put-back the server made for the answer that was lost as restored, and leaves the message in Sent', async () => {
      mockRequest
        .mockResolvedValueOnce(LOOKUP)
        .mockResolvedValueOnce(CANCELLED)
        .mockResolvedValueOnce(DESTROYED('sub-1'))
        .mockResolvedValueOnce(REFUSED('Quota exceeded'))
        .mockRejectedValueOnce(new Error('Network request failed'))
        .mockResolvedValueOnce(records([{ id: 'sub-3', emailId: 'e-1', undoStatus: 'pending', sendAt: ORIGINAL_AT }]));

      const err = await rescheduleScheduledSend(SCHEDULED, 7200).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(RescheduleRestoredError);
      expect(err).toMatchObject({ restoredSubmissionId: 'sub-3', restoredSendAt: ORIGINAL_AT });
      expect(mockRequest.mock.calls.some((c) => c[0][0][0] === 'Email/set')).toBe(false);
    });
  });

  // A group send's undo entry carried the login's own identity id, which
  // names nothing in the group account: both creates were refused and the
  // message went back to Drafts unsent.
  it("submits the replacement and the put-back through the original's identity, not the caller's", async () => {
    const lookup = structuredClone(LOOKUP);
    (lookup.methodResponses[0][1] as { list: Array<Record<string, unknown>> }).list[0].identityId = 'grp-identity';
    mockRequest
      .mockResolvedValueOnce(lookup)
      .mockResolvedValueOnce(CANCELLED)
      .mockResolvedValueOnce(DESTROYED('sub-1'))
      .mockResolvedValueOnce(REFUSED('Quota exceeded'))
      .mockResolvedValueOnce(set({ created: { replacement: { id: 'sub-3' } } }));

    await rescheduleScheduledSend({ ...SCHEDULED, identityId: 'own-identity', accountId: 'grp-1' }, 0).catch(() => undefined);

    expect(createdArgs(0).create.replacement.identityId).toBe('grp-identity');
    expect(createdArgs(1).create.replacement.identityId).toBe('grp-identity');
  });

  it("keeps the caller's identity when the server does not name one", async () => {
    mockRequest
      .mockResolvedValueOnce(LOOKUP)
      .mockResolvedValueOnce(CANCELLED)
      .mockResolvedValueOnce(DESTROYED('sub-1'))
      .mockResolvedValueOnce({ methodResponses: REPLACED });

    await rescheduleScheduledSend(SCHEDULED, 0);

    expect(createdArgs().create.replacement.identityId).toBe('id-1');
  });

  it('moves the message back to Drafts when neither the replacement nor the original can be made', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockRequest
      .mockResolvedValueOnce(LOOKUP)
      .mockResolvedValueOnce(CANCELLED)
      .mockResolvedValueOnce(DESTROYED('sub-1'))
      .mockResolvedValueOnce(REFUSED('Quota exceeded'))
      .mockResolvedValueOnce(REFUSED('Quota exceeded'))
      .mockResolvedValueOnce({ methodResponses: [['Email/set', { updated: { 'e-1': null } }, '0']] });

    const err = await rescheduleScheduledSend(SCHEDULED, 7200).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RescheduleLostError);
    expect(err).toMatchObject({ inDrafts: true });
    const [, restore] = mockRequest.mock.calls.at(-1)![0][0];
    expect(restore.update).toEqual({
      'e-1': { 'mailboxIds/mb-drafts': true, 'keywords/$draft': true, 'keywords/$seen': true, 'mailboxIds/mb-sent': null },
    });
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

  // #1019: an answer without the submission confirms nothing. The draft
  // stays, and so does the copy, which may be the one that went out.
  it('reports a send the server did not confirm as unconfirmed, and keeps the draft', async () => {
    mockRequest.mockResolvedValueOnce({
      methodResponses: [
        ['Email/set', { created: { draft: { id: 'e-new' } } }, '0'],
      ],
    });

    await expect(sendEmail(OUTGOING, 'identity-1', 'sent-mb', undefined, {
      draftsMailboxId: 'drafts-mb', draftId: 'old-draft',
    })).rejects.toBeInstanceOf(SendUnconfirmedError);
    // No destroy of the old draft version, nor of the copy.
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('still fails when the message could not be created', async () => {
    mockRequest.mockResolvedValueOnce({
      methodResponses: [
        ['error', { type: 'serverFail', description: 'Disk full' }, '0'],
        ['EmailSubmission/set', { notCreated: { 'sub-1': { type: 'invalidProperties' } } }, '1'],
      ],
    });

    await expect(sendEmail(OUTGOING, 'identity-1', 'sent-mb')).rejects.toThrow('Disk full');
    // Nothing was created, so there is nothing to remove.
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  describe('a refused submission', () => {
    const destroyCalls = () => mockRequest.mock.calls
      .map((c) => c[0][0])
      .filter(([method, args]: [string, { destroy?: string[] }]) => method === 'Email/set' && args.destroy)
      .map(([, args]: [string, { accountId: string; destroy: string[] }]) => [args.accountId, args.destroy]);

    it('removes the copy it created in Drafts, so a retry leaves no stray draft', async () => {
      mockRequest
        .mockResolvedValueOnce({
          methodResponses: [
            ['Email/set', { created: { draft: { id: 'e-new' } } }, '0'],
            ['EmailSubmission/set', { notCreated: { 'sub-1': { type: 'forbiddenToSend', description: 'Quota exceeded' } } }, '1'],
          ],
        })
        .mockResolvedValueOnce({ methodResponses: [['Email/set', { destroyed: ['e-new'] }, '0']] });

      await expect(sendEmail(OUTGOING, 'identity-1', 'sent-mb', undefined, {
        draftsMailboxId: 'drafts-mb', draftId: 'old-draft', accountId: 'shared-1',
      })).rejects.toThrow('Quota exceeded');

      // Only the unsent copy goes; the previous draft version stays.
      expect(destroyCalls()).toEqual([['shared-1', ['e-new']]]);
    });

    it('removes the copy when the submission call failed as a whole', async () => {
      mockRequest
        .mockResolvedValueOnce({
          methodResponses: [
            ['Email/set', { created: { draft: { id: 'e-new' } } }, '0'],
            ['error', { type: 'invalidArguments', description: 'Invalid envelope' }, '1'],
          ],
        })
        .mockResolvedValueOnce({ methodResponses: [['Email/set', { destroyed: ['e-new'] }, '0']] });

      await expect(sendEmail(OUTGOING, 'identity-1', 'sent-mb', undefined, { draftsMailboxId: 'drafts-mb' }))
        .rejects.toThrow('Invalid envelope');
      expect(destroyCalls()).toEqual([['acc-1', ['e-new']]]);
    });

    it('still reports the refusal when the copy cannot be removed', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      mockRequest
        .mockResolvedValueOnce({
          methodResponses: [
            ['Email/set', { created: { draft: { id: 'e-new' } } }, '0'],
            ['EmailSubmission/set', { notCreated: { 'sub-1': { type: 'forbiddenFrom', description: 'Not your address' } } }, '1'],
          ],
        })
        .mockRejectedValueOnce(new Error('Network request failed'));

      await expect(sendEmail(OUTGOING, 'identity-1', 'sent-mb', undefined, { draftsMailboxId: 'drafts-mb' }))
        .rejects.toThrow('Not your address');
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });
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

  it('turns a refused reschedule into ScheduleTooLateError, with the original put back', async () => {
    mockRequest
      .mockResolvedValueOnce(LOOKUP)
      .mockResolvedValueOnce(CANCELLED)
      .mockResolvedValueOnce(DESTROYED('sub-1'))
      .mockResolvedValueOnce({
        methodResponses: [['EmailSubmission/set', { notCreated: { replacement: HOLD_REJECTED } }, '0']],
      })
      .mockResolvedValueOnce(set({ created: { replacement: { id: 'sub-3' } } }));

    const err = await rescheduleScheduledSend(SCHEDULED, 5 * 24 * 3600).catch((e) => e);

    expect(err).toBeInstanceOf(RescheduleRestoredError);
    expect((err as RescheduleRestoredError).reason).toBeInstanceOf(ScheduleTooLateError);
    expect(jmapClient.learnHoldLimit).toHaveBeenCalledWith(172_800);
    // The original goes at its old time again, under a new id.
    expect(setCalls()).toEqual([[[], ['sub-1'], []], [[], [], ['sub-1']], [['replacement'], [], []], [['replacement'], [], []]]);
    mockRequest.mockReset();
  });
});

describe('scheduled sends in shared accounts (webmail #874)', () => {
  const FUTURE = new Date(Date.now() + 3600_000).toISOString();
  const LATER = new Date(Date.now() + 7200_000).toISOString();
  const byAccount: Record<string, { submissions: unknown[]; emails: unknown[] } | Error> = {};

  beforeEach(() => {
    (jmapClient.getSubmissionAccountIds as ReturnType<typeof vi.fn>).mockReturnValue(['acc-1', 'grp-1', 'grp-2']);
    // grp-2 advertises submission but can't hold mail.
    (jmapClient.hasDelayedSend as ReturnType<typeof vi.fn>).mockImplementation((id: string) => id !== 'grp-2');
    byAccount['acc-1'] = {
      submissions: [{ id: 's-own', emailId: 'e-own', identityId: 'i-own', sendAt: LATER, undoStatus: 'pending' }],
      emails: [{ id: 'e-own', subject: 'Own' }],
    };
    byAccount['grp-1'] = {
      submissions: [
        { id: 's-grp', emailId: 'e-grp', identityId: 'i-grp', sendAt: FUTURE, undoStatus: 'pending' },
        { id: 's-done', emailId: 'e-done', identityId: 'i-grp', sendAt: FUTURE, undoStatus: 'final' },
      ],
      emails: [{ id: 'e-grp', subject: 'Team' }],
    };
    mockRequest.mockImplementation(async (calls: Array<[string, { accountId: string }, string]>) => {
      const [method, args] = calls[0];
      const data = byAccount[args.accountId];
      if (data instanceof Error) throw data;
      if (!data) throw new Error(`unexpected account ${args.accountId}`);
      if (method === 'EmailSubmission/query') {
        return { methodResponses: [[method, { ids: (data.submissions as Array<{ id: string }>).map((s) => s.id) }, '0']] };
      }
      if (method === 'EmailSubmission/get') return { methodResponses: [[method, { list: data.submissions }, '0']] };
      if (method === 'Email/get') return { methodResponses: [[method, { list: data.emails }, '0']] };
      throw new Error(`unexpected ${method}`);
    });
  });

  afterEach(() => {
    mockRequest.mockReset();
    (jmapClient.getSubmissionAccountIds as ReturnType<typeof vi.fn>).mockReturnValue(['acc-1']);
    (jmapClient.hasDelayedSend as ReturnType<typeof vi.fn>).mockReturnValue(true);
  });

  it('lists the pending sends of every account that can hold mail, tagged with their account', async () => {
    const list = await listScheduledEmails();

    expect(list.map((s) => [s.accountId, s.emailSubmissionId, s.subject])).toEqual([
      ['grp-1', 's-grp', 'Team'],
      ['acc-1', 's-own', 'Own'],
    ]);
    const asked = mockRequest.mock.calls.map((c) => c[0][0][1].accountId);
    expect(asked).not.toContain('grp-2');
  });

  it("keeps the user's own scheduled sends when a shared account fails", async () => {
    byAccount['grp-1'] = new Error('forbidden');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const list = await listScheduledEmails();

    expect(list.map((s) => s.emailSubmissionId)).toEqual(['s-own']);
    warn.mockRestore();
  });

  it('still fails when the primary account fails', async () => {
    byAccount['acc-1'] = new Error('server down');

    await expect(listScheduledEmails()).rejects.toThrow('server down');
  });

  it('cancels and reschedules in the account holding the submission', async () => {
    mockRequest.mockReset();
    mockRequest
      .mockResolvedValueOnce({ methodResponses: [['EmailSubmission/set', { updated: { 's-grp': null } }, '0']] })
      .mockResolvedValueOnce(DESTROYED('s-grp'));
    await cancelScheduledSend('s-grp', 'grp-1');
    // The cancel, then the destroy of the canceled record.
    expect(mockRequest.mock.calls.map((c) => c[0][0][1].accountId)).toEqual(['grp-1', 'grp-1']);

    mockRequest
      .mockResolvedValueOnce(LOOKUP)
      .mockResolvedValueOnce(set({ updated: { 's-grp': null } }))
      .mockResolvedValueOnce(DESTROYED('s-grp'))
      .mockResolvedValueOnce(set({ created: { replacement: { id: 's-new', sendAt: FUTURE } } }));
    await rescheduleScheduledSend({ ...SCHEDULED, emailSubmissionId: 's-grp', accountId: 'grp-1' }, 0);
    expect(mockRequest.mock.calls.slice(2).map((c) => c[0][0][1].accountId)).toEqual(['grp-1', 'grp-1', 'grp-1', 'grp-1']);
  });
});
