import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    learnHoldLimit: vi.fn(),
    getSubmissionAccountIds: vi.fn(() => ['acc-1']),
    hasDelayedSend: vi.fn(() => true),
    // The server no longer offers any extension: sendEmail must not care.
    supportsSubmissionExtension: vi.fn(() => false),
    getMaxCallsInRequest: vi.fn(() => 16),
    getMaxObjectsInGet: vi.fn(() => 500),
    getMaxObjectsInSet: vi.fn(() => 500),
  },
}));

import { jmapClient } from '../jmap-client';
import {
  buildSubmissionEnvelope, cancelScheduledSend, listScheduledEmails, rescheduleScheduledSend, sendEmail,
  submissionEnvelopeParameters,
} from '../email';
import {
  RecipientsRejectedError, ScheduleTooLateError, SendRefusedError, SendUnconfirmedError,
} from '../jmap-result';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  // A failing test must not leave queued answers for the next one.
  mockRequest.mockReset();
});

const SCHEDULED = {
  emailSubmissionId: 'sub-1',
  emailId: 'e-1',
  identityId: 'id-1',
  from: [{ email: 'news@shop.example' }],
  to: [{ email: 'to@example.com' }],
};

const LOOKUP = {
  methodResponses: [
    ['EmailSubmission/get', {
      list: [{ id: 'sub-1', envelope: { mailFrom: { email: 'me@example.com' }, rcptTo: [{ email: 'to@example.com' }] } }],
    }, '0'],
  ],
};
const REPLACED = [['EmailSubmission/set', {
  created: { replacement: { id: 'sub-2', sendAt: '2026-09-25T08:00:00Z' } },
}, '0']];
const set = (body: Record<string, unknown>) => ({ methodResponses: [['EmailSubmission/set', body, '0']] });
const CANCELLED = set({ updated: { 'sub-1': null } });
/** The EmailSubmission/set calls made, as [create ids, update ids]. */
const setCalls = () => mockRequest.mock.calls
  .map((c) => c[0][0])
  .filter(([method]: [string]) => method === 'EmailSubmission/set')
  .map(([, args]: [string, { create?: object; update?: Record<string, unknown> }]) => [
    Object.keys(args.create ?? {}),
    Object.keys(args.update ?? {}),
  ]);

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
        ],
      })
      .mockResolvedValueOnce({ methodResponses: REPLACED })
      .mockResolvedValueOnce(CANCELLED);

    const result = await rescheduleScheduledSend(SCHEDULED, 7200);

    expect(result).toEqual({ emailSubmissionId: 'sub-2', sendAt: '2026-09-25T08:00:00Z' });
    const [lookup] = mockRequest.mock.calls[0][0];
    expect(lookup).toEqual(['EmailSubmission/get', { accountId: 'acc-1', ids: ['sub-1'], properties: ['envelope'] }, '0']);
    const args = mockRequest.mock.calls[1][0][0][1];
    expect(args.create.replacement.envelope).toEqual({
      mailFrom: { email: 'me@example.com', parameters: { HOLDFOR: '7200' } },
      rcptTo: [{ email: 'to@example.com' }, { email: 'cc@example.com' }, { email: 'bcc@example.com' }],
    });
  });

  it.each([
    ['has no envelope', { id: 'sub-1', envelope: null }],
    ['is not listed', undefined],
    ['has an envelope without MAIL FROM', { id: 'sub-1', envelope: { rcptTo: [{ email: 'to@example.com' }] } }],
    ['has an envelope without recipients', { id: 'sub-1', envelope: { mailFrom: { email: 'me@example.com' }, rcptTo: [] } }],
  ])('refuses rather than build a weaker envelope when the held submission %s', async (_name, held) => {
    mockRequest.mockResolvedValueOnce({
      methodResponses: [['EmailSubmission/get', { list: held ? [held] : [] }, '0']],
    });

    await expect(rescheduleScheduledSend(SCHEDULED, 60)).rejects.toThrow(/held envelope/);
    // Nothing was created and the original was left alone.
    expect(setCalls()).toEqual([]);
  });

  describe('keeps the held send options (REQUIRETLS, DSN)', () => {
    const heldWith = (mailFrom: Record<string, string | null> | null, rcpt: Record<string, string | null> | null) => ({
      methodResponses: [['EmailSubmission/get', {
        list: [{
          id: 'sub-1',
          envelope: {
            mailFrom: { email: 'me@example.com', parameters: mailFrom },
            rcptTo: [
              { email: 'to@example.com', parameters: rcpt },
              { email: 'bcc@example.com', parameters: rcpt },
            ],
          },
        }],
      }, '0']],
    });
    const replacementEnvelope = () => mockRequest.mock.calls[1][0][0][1].create.replacement.envelope;
    const run = async (held: ReturnType<typeof heldWith>, seconds: number) => {
      mockRequest
        .mockResolvedValueOnce(held)
        .mockResolvedValueOnce({ methodResponses: REPLACED })
        .mockResolvedValueOnce(CANCELLED);
      await rescheduleScheduledSend(SCHEDULED, seconds);
      return replacementEnvelope();
    };

    it.each([
      ['Send now', 0, '1'],
      ['Reschedule', 7200, '7200'],
    ])('%s keeps REQUIRETLS', async (_name, seconds, holdFor) => {
      const envelope = await run(heldWith({ HOLDFOR: '30', REQUIRETLS: null }, null), seconds);
      expect(envelope).toEqual({
        mailFrom: { email: 'me@example.com', parameters: { HOLDFOR: holdFor, REQUIRETLS: null } },
        rcptTo: [{ email: 'to@example.com' }, { email: 'bcc@example.com' }],
      });
    });

    it.each([
      ['Send now', 0, '1'],
      ['Reschedule', 7200, '7200'],
    ])('%s keeps the delivery notification request (DSN)', async (_name, seconds, holdFor) => {
      const envelope = await run(
        heldWith({ HOLDFOR: '30', RET: 'HDRS', ENVID: 'env-1' }, { NOTIFY: 'SUCCESS,FAILURE,DELAY' }),
        seconds,
      );
      expect(envelope).toEqual({
        mailFrom: { email: 'me@example.com', parameters: { HOLDFOR: holdFor, RET: 'HDRS', ENVID: 'env-1' } },
        rcptTo: [
          { email: 'to@example.com', parameters: { NOTIFY: 'SUCCESS,FAILURE,DELAY' } },
          { email: 'bcc@example.com', parameters: { NOTIFY: 'SUCCESS,FAILURE,DELAY' } },
        ],
      });
    });

    it('replaces a held HOLDUNTIL rather than send two holds', async () => {
      const envelope = await run(heldWith({ HOLDUNTIL: '2026-10-08T08:00:00Z', REQUIRETLS: null }, null), 600);
      expect(envelope.mailFrom.parameters).toEqual({ HOLDFOR: '600', REQUIRETLS: null });
    });

    it.each([
      ['Send now', 0, '1'],
      ['Reschedule', 7200, '7200'],
    ])('%s of a held send with no options builds the same envelope as before', async (_name, seconds, holdFor) => {
      const envelope = await run(heldWith({ HOLDFOR: '30' }, null), seconds);
      expect(envelope).toEqual({
        mailFrom: { email: 'me@example.com', parameters: { HOLDFOR: holdFor } },
        rcptTo: [{ email: 'to@example.com' }, { email: 'bcc@example.com' }],
      });
    });
  });

  it('creates the replacement before cancelling the original', async () => {
    mockRequest
      .mockResolvedValueOnce(LOOKUP)
      .mockResolvedValueOnce({ methodResponses: REPLACED })
      .mockResolvedValueOnce(CANCELLED);

    await rescheduleScheduledSend(SCHEDULED, 7200);

    expect(setCalls()).toEqual([[['replacement'], []], [[], ['sub-1']]]);
    expect(mockRequest.mock.calls[2][0][0][1].update).toEqual({ 'sub-1': { undoStatus: 'canceled' } });
  });

  it('sends now as a 1-second hold, so the replacement can still be withdrawn', async () => {
    mockRequest
      .mockResolvedValueOnce(LOOKUP)
      .mockResolvedValueOnce({ methodResponses: REPLACED })
      .mockResolvedValueOnce(CANCELLED);

    await rescheduleScheduledSend(SCHEDULED, 0);

    const replacement = mockRequest.mock.calls[1][0][0][1].create.replacement;
    expect(replacement.envelope).toEqual({
      mailFrom: { email: 'me@example.com', parameters: { HOLDFOR: '1' } },
      rcptTo: [{ email: 'to@example.com' }],
    });
    expect(setCalls()).toEqual([[['replacement'], []], [[], ['sub-1']]]);
  });

  it('leaves the original scheduled when the replacement is refused', async () => {
    mockRequest
      .mockResolvedValueOnce(LOOKUP)
      .mockResolvedValueOnce(set({ notCreated: { replacement: { type: 'forbiddenToSend', description: 'Quota exceeded' } } }));

    await expect(rescheduleScheduledSend(SCHEDULED, 7200)).rejects.toThrow('Quota exceeded');
    // No cancel went out.
    expect(setCalls()).toEqual([[['replacement'], []]]);
  });

  it('withdraws the replacement when the original has already gone out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockRequest
      .mockResolvedValueOnce(LOOKUP)
      .mockResolvedValueOnce({ methodResponses: REPLACED })
      .mockResolvedValueOnce(set({ notUpdated: { 'sub-1': { type: 'cannotUnsend', description: 'Already sent' } } }))
      .mockResolvedValueOnce({ methodResponses: [['EmailSubmission/get', { list: [{ id: 'sub-1', undoStatus: 'final' }] }, '0']] })
      .mockResolvedValueOnce(set({ updated: { 'sub-2': null } }));

    await expect(rescheduleScheduledSend(SCHEDULED, 0)).rejects.toThrow('Failed to cancel the previous schedule: Already sent');
    expect(setCalls()).toEqual([[['replacement'], []], [[], ['sub-1']], [[], ['sub-2']]]);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('still reports the failure when the replacement cannot be withdrawn either', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockRequest
      .mockResolvedValueOnce(LOOKUP)
      .mockResolvedValueOnce({ methodResponses: REPLACED })
      .mockResolvedValueOnce(set({ notUpdated: { 'sub-1': { type: 'cannotUnsend' } } }))
      .mockResolvedValueOnce({ methodResponses: [['EmailSubmission/get', { list: [{ id: 'sub-1', undoStatus: 'final' }] }, '0']] })
      .mockResolvedValueOnce(set({ notUpdated: { 'sub-2': { type: 'cannotUnsend' } } }));

    await expect(rescheduleScheduledSend(SCHEDULED, 0)).rejects.toThrow('Failed to cancel the previous schedule');
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('keeps the replacement when a cancel whose answer got lost did go through', async () => {
    mockRequest
      .mockResolvedValueOnce(LOOKUP)
      .mockResolvedValueOnce({ methodResponses: REPLACED })
      .mockRejectedValueOnce(new Error('Network request failed'))
      .mockResolvedValueOnce({ methodResponses: [['EmailSubmission/get', { list: [{ id: 'sub-1', undoStatus: 'canceled' }] }, '0']] });

    const result = await rescheduleScheduledSend(SCHEDULED, 7200);

    expect(result.emailSubmissionId).toBe('sub-2');
    expect(setCalls()).toEqual([[['replacement'], []], [[], ['sub-1']]]);
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

  it('turns a refused reschedule into ScheduleTooLateError', async () => {
    mockRequest
      .mockResolvedValueOnce({
        methodResponses: [
          ['EmailSubmission/get', { list: [{ id: 'sub-1', envelope: { mailFrom: { email: 'me@example.com' }, rcptTo: [{ email: 'to@example.com' }] } }] }, '0'],
        ],
      })
      .mockResolvedValueOnce({
        methodResponses: [['EmailSubmission/set', { notCreated: { replacement: HOLD_REJECTED } }, '0']],
      });

    const err = await rescheduleScheduledSend(SCHEDULED, 5 * 24 * 3600).catch((e) => e);

    expect(err).toBeInstanceOf(ScheduleTooLateError);
    expect(jmapClient.learnHoldLimit).toHaveBeenCalledWith(172_800);
    // The original stays scheduled.
    expect(setCalls()).toEqual([[['replacement'], []]]);
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
    mockRequest.mockResolvedValueOnce({
      methodResponses: [['EmailSubmission/set', { updated: { 's-grp': null } }, '0']],
    });
    await cancelScheduledSend('s-grp', 'grp-1');
    expect(mockRequest.mock.calls[0][0][0][1].accountId).toBe('grp-1');

    mockRequest
      .mockResolvedValueOnce(LOOKUP)
      .mockResolvedValueOnce(set({ created: { replacement: { id: 's-new', sendAt: FUTURE } } }))
      .mockResolvedValueOnce(set({ updated: { 's-grp': null } }));
    await rescheduleScheduledSend({ ...SCHEDULED, emailSubmissionId: 's-grp', accountId: 'grp-1' }, 0);
    expect(mockRequest.mock.calls.slice(1).map((c) => c[0][0][1].accountId)).toEqual(['grp-1', 'grp-1', 'grp-1']);
  });
});

describe('sendEmail: delivery notifications and REQUIRETLS', () => {
  const OUTGOING = {
    from: [{ email: 'me@example.com', name: 'Me' }],
    to: [{ email: ' you@example.com ', name: 'You' }],
    cc: [{ email: 'cc@example.com' }],
    bcc: [{ email: 'bcc@example.com' }],
    subject: 'Hello',
    textBody: 'Hi',
    messageId: 'mid-1@example.com',
  };
  const RCPTS = ['you@example.com', 'cc@example.com', 'bcc@example.com'];
  const send = async (over: Record<string, unknown> = {}, holdFor?: number) => {
    mockRequest.mockResolvedValueOnce({ methodResponses: [] });
    await sendEmail({ ...OUTGOING, ...over }, 'identity-1', 'sent-mb', holdFor, { draftsMailboxId: 'drafts-mb' })
      .catch(() => undefined);
    return mockRequest.mock.calls[0];
  };
  const submission = (call: unknown[]) =>
    ((call[0] as Array<[string, { create: Record<string, Record<string, unknown>> }]>)
      .find(([m]) => m === 'EmailSubmission/set')![1]).create['sub-1'];

  // The request as sent before DSN / REQUIRETLS existed, captured verbatim.
  const TODAY = '[[["Email/set",{"accountId":"acc-1","create":{"draft":{"from":[{"name":"Me","email":"me@example.com"}],"to":[{"name":"You","email":"you@example.com"}],"cc":[{"email":"cc@example.com"}],"bcc":[{"email":"bcc@example.com"}],"subject":"Hello","messageId":["mid-1@example.com"],"textBody":[{"partId":"text","type":"text/plain"}],"bodyValues":{"text":{"value":"Hi"}},"mailboxIds":{"drafts-mb":true},"keywords":{"$seen":true,"$draft":true}}}},"0"],["EmailSubmission/set",{"accountId":"acc-1","create":{"sub-1":{"emailId":"#draft","identityId":"identity-1"}},"onSuccessUpdateEmail":{"#sub-1":{"mailboxIds":{"sent-mb":true},"keywords/$draft":null}}},"1"],["EmailSubmission/get",{"accountId":"acc-1","ids":["#sub-1"],"properties":["deliveryStatus"]},"deliveryStatus"]],["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail","urn:ietf:params:jmap:submission"],{}]';

  it('with both options off and no hold, the request is byte-identical to before', async () => {
    expect(JSON.stringify(await send())).toBe(TODAY);
    mockRequest.mockClear();
    expect(JSON.stringify(await send({ requestDsn: false, requireTls: false }))).toBe(TODAY);
  });

  it('a hold alone, or an envelope sender alone, keeps the envelope it had', async () => {
    expect(JSON.stringify(submission(await send({}, 30)))).toBe(
      '{"emailId":"#draft","identityId":"identity-1","envelope":{"mailFrom":{"email":"me@example.com","parameters":{"HOLDFOR":"30"}},"rcptTo":[{"email":"you@example.com"},{"email":"cc@example.com"},{"email":"bcc@example.com"}]}}',
    );
    mockRequest.mockClear();
    expect(JSON.stringify(submission(await send({ envelopeMailFrom: 'id@example.com' })))).toBe(
      '{"emailId":"#draft","identityId":"identity-1","envelope":{"mailFrom":{"email":"id@example.com"},"rcptTo":[{"email":"you@example.com"},{"email":"cc@example.com"},{"email":"bcc@example.com"}]}}',
    );
  });

  it('DSN asks for headers back and notifies on every bare-address recipient', async () => {
    expect(submission(await send({ requestDsn: true })).envelope).toEqual({
      mailFrom: { email: 'me@example.com', parameters: { RET: 'HDRS' } },
      rcptTo: RCPTS.map((email) => ({ email, parameters: { NOTIFY: 'SUCCESS,FAILURE,DELAY' } })),
    });
  });

  it('REQUIRETLS is a valueless MAIL FROM parameter, recipients plain', async () => {
    expect(submission(await send({ requireTls: true })).envelope).toEqual({
      mailFrom: { email: 'me@example.com', parameters: { REQUIRETLS: null } },
      rcptTo: RCPTS.map((email) => ({ email })),
    });
  });

  it('each combines with HOLDFOR and the envelope sender', async () => {
    expect(submission(await send({ requestDsn: true }, 29.2)).envelope).toEqual({
      mailFrom: { email: 'me@example.com', parameters: { HOLDFOR: '30', RET: 'HDRS' } },
      rcptTo: RCPTS.map((email) => ({ email, parameters: { NOTIFY: 'SUCCESS,FAILURE,DELAY' } })),
    });
    mockRequest.mockClear();
    expect(submission(await send({ requireTls: true, envelopeMailFrom: 'id@example.com' }, 60)).envelope).toEqual({
      mailFrom: { email: 'id@example.com', parameters: { HOLDFOR: '60', REQUIRETLS: null } },
      rcptTo: RCPTS.map((email) => ({ email })),
    });
    mockRequest.mockClear();
    expect(submission(await send({ requireTls: true, requestDsn: true }, 60)).envelope).toEqual({
      mailFrom: { email: 'me@example.com', parameters: { HOLDFOR: '60', REQUIRETLS: null, RET: 'HDRS' } },
      rcptTo: RCPTS.map((email) => ({ email, parameters: { NOTIFY: 'SUCCESS,FAILURE,DELAY' } })),
    });
  });

  it('keeps REQUIRETLS when the capability has vanished: the server refuses rather than send in clear', async () => {
    const call = await send({ requireTls: true, requestDsn: true });
    expect(submission(call).envelope).toMatchObject({ mailFrom: { parameters: { REQUIRETLS: null, RET: 'HDRS' } } });
    expect(jmapClient.supportsSubmissionExtension).not.toHaveBeenCalled();
  });
});

describe('submissionEnvelopeParameters', () => {
  it('maps the options to webmail\'s parameters', () => {
    expect(submissionEnvelopeParameters({})).toEqual({ mailFrom: {}, rcptTo: {} });
    expect(submissionEnvelopeParameters({}, 0)).toEqual({ mailFrom: {}, rcptTo: {} });
    expect(submissionEnvelopeParameters({ requestDsn: true, requireTls: true }, 90)).toEqual({
      mailFrom: { HOLDFOR: '90', REQUIRETLS: null, RET: 'HDRS' },
      rcptTo: { NOTIFY: 'SUCCESS,FAILURE,DELAY' },
    });
  });
});

describe('buildSubmissionEnvelope', () => {
  const EMAIL = { from: [{ email: 'me@example.com' }], to: [{ email: 'a@x.test' }, { email: '  ' }], subject: '' };
  it('is undefined when there is nothing to say beyond the identity', () => {
    expect(buildSubmissionEnvelope(EMAIL, 0)).toBeUndefined();
    expect(buildSubmissionEnvelope({ ...EMAIL, requestDsn: false, requireTls: false }, 0)).toBeUndefined();
  });
  it('drops blank recipients and uses the given MAIL FROM over the envelope sender', () => {
    expect(buildSubmissionEnvelope({ ...EMAIL, envelopeMailFrom: 'id@example.com', requireTls: true }, 0, 'other@example.com'))
      .toEqual({ mailFrom: { email: 'other@example.com', parameters: { REQUIRETLS: null } }, rcptTo: [{ email: 'a@x.test' }] });
  });
});

describe('sendEmail: the From override as MAIL FROM, the identity as fallback (#1009)', () => {
  const client = jmapClient as unknown as { connectionGen: number; accountId: string };
  const OUTGOING = {
    from: [{ email: 'alias@example.com', name: 'Alias' }],
    to: [{ email: 'you@example.com' }],
    subject: 'Hello',
    textBody: 'Hi',
    envelopeMailFrom: 'alias@example.com',
    envelopeFallbackMailFrom: 'me@example.com',
  };
  const OPTS = { draftsMailboxId: 'drafts-mb', draftId: 'old-draft', accountId: 'shared-1' };
  const refusedWith = (refusal: Record<string, unknown>, created: Record<string, unknown> = { draft: { id: 'e-new' } }) => ({
    methodResponses: [
      ['Email/set', { created }, '0'],
      ['EmailSubmission/set', { notCreated: { 'sub-1': refusal } }, '1'],
      // The dangling #sub-1 reference: only a report.
      ['error', { type: 'invalidResultReference' }, 'deliveryStatus'],
    ],
  });
  const FORBIDDEN_FROM = refusedWith({ type: 'forbiddenFrom', description: 'Not your address' });
  const RETRY_OK = {
    methodResponses: [
      ['EmailSubmission/set', { created: { 'sub-1': { id: 's-2', sendAt: '2026-10-07T10:01:00Z' } } }, '1'],
      ['Email/set', { updated: { 'e-new': null } }, '1'],
      ['EmailSubmission/get', { list: [{ deliveryStatus: { 'you@example.com': { delivered: 'queued' } } }] }, 'deliveryStatus'],
    ],
  };
  const DESTROYED = { methodResponses: [['Email/set', { destroyed: ['e-new'] }, '0']] };
  const methods = (i: number) => (mockRequest.mock.calls[i][0] as Array<[string]>).map(([m]) => m);
  const submissionAt = (i: number) => ((mockRequest.mock.calls[i][0] as Array<[string, Record<string, unknown>]>)
    .find(([m]) => m === 'EmailSubmission/set')![1]);
  const destroyCalls = () => mockRequest.mock.calls
    .map((c) => c[0][0])
    .filter(([method, args]: [string, { destroy?: string[] }]) => method === 'Email/set' && args.destroy)
    .map(([, args]: [string, { accountId: string; destroy: string[] }]) => [args.accountId, args.destroy]);

  beforeEach(() => {
    // A once-answer left over by a failed test must not leak into the next.
    mockRequest.mockReset();
    client.connectionGen = 7;
    client.accountId = 'acc-1';
  });
  afterEach(() => {
    client.accountId = 'acc-1';
    delete (client as { connectionGen?: number }).connectionGen;
  });

  it('asks for the override as MAIL FROM', async () => {
    mockRequest.mockResolvedValueOnce(RETRY_OK);
    await sendEmail(OUTGOING, 'identity-1', 'sent-mb', undefined, OPTS).catch(() => undefined);
    expect((submissionAt(0).create as Record<string, Record<string, unknown>>)['sub-1'].envelope).toEqual({
      mailFrom: { email: 'alias@example.com' },
      rcptTo: [{ email: 'you@example.com' }],
    });
  });

  it.each(['forbiddenFrom', 'forbiddenMailFrom'])(
    'a %s refusal submits the same copy once more, with the identity as MAIL FROM, on the same connection and account',
    async (type) => {
      mockRequest
        .mockImplementationOnce(async () => {
          // A switch lands while the first request runs: the retry must not follow it.
          client.connectionGen = 8;
          client.accountId = 'acc-other';
          return refusedWith({ type, description: 'Not your address' });
        })
        .mockResolvedValueOnce(RETRY_OK)
        .mockResolvedValueOnce({ methodResponses: [['Email/set', { destroyed: ['old-draft'] }, '0']] });

      const result = await sendEmail(
        { ...OUTGOING, requestDsn: true, requireTls: true }, 'identity-1', 'sent-mb', 59.5, OPTS,
      );

      expect(mockRequest).toHaveBeenCalledTimes(3);
      expect(mockRequest.mock.calls.map((c) => c[2])).toEqual([{ gen: 7 }, { gen: 7 }, { gen: 7 }]);
      expect(methods(1)).toEqual(['EmailSubmission/set', 'EmailSubmission/get']);
      const retry = submissionAt(1);
      expect(retry).toEqual({
        accountId: 'shared-1',
        create: {
          'sub-1': {
            emailId: 'e-new',
            identityId: 'identity-1',
            envelope: {
              mailFrom: { email: 'me@example.com', parameters: { HOLDFOR: '60', REQUIRETLS: null, RET: 'HDRS' } },
              rcptTo: [{ email: 'you@example.com', parameters: { NOTIFY: 'SUCCESS,FAILURE,DELAY' } }],
            },
          },
        },
        onSuccessUpdateEmail: submissionAt(0).onSuccessUpdateEmail,
      });
      expect((mockRequest.mock.calls[1][0] as Array<[string, Record<string, unknown>]>)[1][1])
        .toEqual({ accountId: 'shared-1', ids: ['#sub-1'], properties: ['deliveryStatus'] });
      expect(result).toMatchObject({
        scheduled: true, emailId: 'e-new', emailSubmissionId: 's-2', sendAt: '2026-10-07T10:01:00Z',
      });
      expect(result.filingWarning).toBeUndefined();
      // Only the previous draft goes, once the message is out.
      expect(destroyCalls()).toEqual([['shared-1', ['old-draft']]]);
    },
  );

  it('a refused retry removes the copy and fails: never a third submission', async () => {
    mockRequest
      .mockResolvedValueOnce(FORBIDDEN_FROM)
      .mockResolvedValueOnce({ methodResponses: [
        ['EmailSubmission/set', { notCreated: { 'sub-1': { type: 'forbiddenFrom', description: 'Still not yours' } } }, '1'],
        ['error', { type: 'invalidResultReference' }, 'deliveryStatus'],
      ] })
      .mockResolvedValueOnce(DESTROYED);

    const err = await sendEmail(OUTGOING, 'identity-1', 'sent-mb', undefined, OPTS).catch((e) => e);
    expect(err).toBeInstanceOf(SendRefusedError);
    expect(err.message).toBe('Still not yours');
    expect(err.type).toBe('forbiddenFrom');
    expect(mockRequest).toHaveBeenCalledTimes(3);
    expect(destroyCalls()).toEqual([['shared-1', ['e-new']]]);
  });

  it.each([
    ['forbiddenToSend', { type: 'forbiddenToSend', description: 'Quota exceeded' }],
    ['invalidProperties', { type: 'invalidProperties', description: 'Bad envelope' }],
    ['tooLarge', { type: 'tooLarge', description: 'Too big' }],
    ['no type', { description: 'Refused' }],
  ])('another refusal (%s) is not retried', async (_name, refusal) => {
    mockRequest.mockResolvedValueOnce(refusedWith(refusal)).mockResolvedValueOnce(DESTROYED);
    await expect(sendEmail(OUTGOING, 'identity-1', 'sent-mb', undefined, OPTS)).rejects.toBeInstanceOf(SendRefusedError);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(destroyCalls()).toEqual([['shared-1', ['e-new']]]);
  });

  it('a hold-limit refusal is not about the address: not retried', async () => {
    mockRequest
      .mockResolvedValueOnce(refusedWith({
        type: 'forbiddenMailFrom',
        description: 'Server rejected MAIL-FROM: 501 5.5.4 Requested hold time exceeds maximum of 172800 seconds.',
      }))
      .mockResolvedValueOnce(DESTROYED);
    await expect(sendEmail(OUTGOING, 'identity-1', 'sent-mb', 400_000, OPTS)).rejects.toBeInstanceOf(ScheduleTooLateError);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(destroyCalls()).toEqual([['shared-1', ['e-new']]]);
  });

  it('a method-level forbiddenFrom error is not a refused create: not retried', async () => {
    mockRequest
      .mockResolvedValueOnce({ methodResponses: [
        ['Email/set', { created: { draft: { id: 'e-new' } } }, '0'],
        ['error', { type: 'forbiddenFrom', description: 'Not your address' }, '1'],
      ] })
      .mockResolvedValueOnce(DESTROYED);
    await expect(sendEmail(OUTGOING, 'identity-1', 'sent-mb', undefined, OPTS)).rejects.toThrow('Not your address');
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it('a legacy queued row (identity MAIL FROM, no fallback) behaves as before: not retried', async () => {
    mockRequest.mockResolvedValueOnce(FORBIDDEN_FROM).mockResolvedValueOnce(DESTROYED);
    const legacy = { ...OUTGOING, envelopeMailFrom: 'me@example.com', envelopeFallbackMailFrom: undefined };
    await expect(sendEmail(legacy, 'identity-1', 'sent-mb', undefined, OPTS)).rejects.toThrow('Not your address');
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect((submissionAt(0).create as Record<string, Record<string, unknown>>)['sub-1'].envelope)
      .toEqual({ mailFrom: { email: 'me@example.com' }, rcptTo: [{ email: 'you@example.com' }] });
    expect(destroyCalls()).toEqual([['shared-1', ['e-new']]]);
  });

  it('a fallback equal to the requested MAIL FROM, in any case, is not retried', async () => {
    mockRequest.mockResolvedValueOnce(FORBIDDEN_FROM).mockResolvedValueOnce(DESTROYED);
    await expect(sendEmail({ ...OUTGOING, envelopeFallbackMailFrom: ' ALIAS@example.com ' }, 'identity-1', 'sent-mb', undefined, OPTS))
      .rejects.toThrow('Not your address');
    expect(mockRequest).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['with a fallback', OUTGOING],
    ['on a legacy row', { ...OUTGOING, envelopeMailFrom: 'me@example.com', envelopeFallbackMailFrom: undefined }],
  ])('a submission reported both created and refused counts as created (%s): one submission, the copy kept', async (_name, outgoing) => {
    mockRequest
      .mockResolvedValueOnce({ methodResponses: [
        ['Email/set', { created: { draft: { id: 'e-new' } } }, '0'],
        ['EmailSubmission/set', {
          created: { 'sub-1': { id: 's-1' } },
          notCreated: { 'sub-1': { type: 'forbiddenFrom', description: 'Not your address' } },
        }, '1'],
        ['EmailSubmission/get', { list: [{ deliveryStatus: { 'you@example.com': { delivered: 'queued' } } }] }, 'deliveryStatus'],
      ] })
      .mockResolvedValueOnce({ methodResponses: [['Email/set', { destroyed: ['old-draft'] }, '0']] });

    const result = await sendEmail(outgoing, 'identity-1', 'sent-mb', undefined, OPTS);

    expect(result).toMatchObject({ emailId: 'e-new', emailSubmissionId: 's-1' });
    const submissions = mockRequest.mock.calls
      .flatMap((c) => c[0] as Array<[string]>)
      .filter(([m]) => m === 'EmailSubmission/set');
    expect(submissions).toHaveLength(1);
    // Only the previous draft goes; the sent copy stays.
    expect(destroyCalls()).toEqual([['shared-1', ['old-draft']]]);
  });

  it('without a known created copy, nothing is retried', async () => {
    mockRequest.mockResolvedValueOnce(refusedWith({ type: 'forbiddenFrom', description: 'Not your address' }, {}));
    await expect(sendEmail(OUTGOING, 'identity-1', 'sent-mb', undefined, OPTS)).rejects.toThrow('Not your address');
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a transport error', new Error('Network request failed')],
    ['a timeout', Object.assign(new Error('timed out'), { name: 'RequestTimeoutError' })],
  ])('%s on the first request is not retried, and nothing is removed', async (_name, error) => {
    mockRequest.mockRejectedValueOnce(error);
    await expect(sendEmail(OUTGOING, 'identity-1', 'sent-mb', undefined, OPTS)).rejects.toBe(error);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('an unconfirmed first send is not retried', async () => {
    mockRequest.mockResolvedValueOnce({ methodResponses: [['Email/set', { created: { draft: { id: 'e-new' } } }, '0']] });
    await expect(sendEmail(OUTGOING, 'identity-1', 'sent-mb', undefined, OPTS)).rejects.toBeInstanceOf(SendUnconfirmedError);
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('a transport error on the retry is uncertain: the copy stays and nothing more is sent', async () => {
    const error = new Error('Network request failed');
    mockRequest.mockResolvedValueOnce(FORBIDDEN_FROM).mockRejectedValueOnce(error);
    await expect(sendEmail(OUTGOING, 'identity-1', 'sent-mb', undefined, OPTS)).rejects.toBe(error);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(destroyCalls()).toEqual([]);
  });

  it('a retry answered without a submission is unconfirmed: the copy stays', async () => {
    mockRequest.mockResolvedValueOnce(FORBIDDEN_FROM).mockResolvedValueOnce({ methodResponses: [] });
    await expect(sendEmail(OUTGOING, 'identity-1', 'sent-mb', undefined, OPTS)).rejects.toBeInstanceOf(SendUnconfirmedError);
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(destroyCalls()).toEqual([]);
  });

  it('a retry whose every recipient is refused removes the copy', async () => {
    mockRequest
      .mockResolvedValueOnce(FORBIDDEN_FROM)
      .mockResolvedValueOnce({ methodResponses: [
        ['EmailSubmission/set', { created: { 'sub-1': { id: 's-2' } } }, '1'],
        ['EmailSubmission/get', { list: [{ deliveryStatus: { 'you@example.com': { delivered: 'no', smtpReply: '550' } } }] }, 'deliveryStatus'],
      ] })
      .mockResolvedValueOnce(DESTROYED);
    await expect(sendEmail(OUTGOING, 'identity-1', 'sent-mb', undefined, OPTS)).rejects.toBeInstanceOf(RecipientsRejectedError);
    expect(mockRequest).toHaveBeenCalledTimes(3);
    expect(destroyCalls()).toEqual([['shared-1', ['e-new']]]);
  });
});
