import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FakeSubmissionServer } from './fake-submission-server';

// Stalwart runs the SMTP RCPT stage while it creates a submission, held or
// not, and records each refused recipient as `delivered: "no"` with its
// reply: a relay it doesn't allow ("550 5.1.2 Relay not allowed.") or a
// throttle that is used up ("452 4.4.5 Rate limit exceeded, try again
// later."). The create still succeeds - undoStatus final when it took nobody -
// and onSuccessUpdateEmail files the message in Sent. Seen live on 0.16.23 and
// 1.0; 0.16.6 records it the same way (submission/set.rs). These tests run the
// send paths against a fake Stalwart (./fake-submission-server) that models
// the RCPT stage and `#creationId` in EmailSubmission/get.

const fake = vi.hoisted(() => ({
  server: undefined as unknown as FakeSubmissionServer,
  stalwart: true,
  accounts: ['acc-1'],
  username: 'me@example.com',
}));

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    serverUrl: 'https://mail.example.com',
    get username() { return fake.username; },
    request: vi.fn((calls: never, using?: string[]) => fake.server.request(calls, using)),
    hasCapability: vi.fn(() => true),
    hasAccountCapability: vi.fn((urn: string) => urn !== 'urn:stalwart:jmap' || fake.stalwart),
    getSubmissionAccountIds: vi.fn(() => fake.accounts),
    hasDelayedSend: vi.fn(() => true),
    getMaxObjectsInGet: vi.fn(() => 500),
    getMaxObjectsInSet: vi.fn(() => 500),
    getMaxCallsInRequest: vi.fn(() => 16),
    learnHoldLimit: vi.fn(),
  },
}));

import { jmapClient } from '../jmap-client';
import { listScheduledEmails, rescheduleScheduledSend, sendEmail } from '../email';
import { RecipientsRefusedError, jmapErrorType } from '../jmap-result';
import { pruneEmailSubmissions, resetSubmissionPrune } from '../submissions';
import {
  createFakeSubmissionServer, RATE_LIMITED, RELAY_DENIED, type StalwartVersion,
} from './fake-submission-server';

const HOUR = 3_600_000;

const OUTGOING = {
  from: [{ email: 'me@example.com' }],
  to: [{ email: 'you@example.com' }],
  subject: 'Hello',
  textBody: 'Hi',
};
const VIA_DRAFTS = { draftsMailboxId: 'drafts' };
/** Stalwart's relay rule on the test servers: anything outside refused. */
const relayOff = (email: string) => (email.endsWith('@example.net') ? RELAY_DENIED : undefined);

function setup(version: StalwartVersion, options: Omit<Parameters<typeof createFakeSubmissionServer>[0], 'version'> = {}) {
  fake.server = createFakeSubmissionServer({ version, ...options });
  return fake.server;
}

function addDraft(server: FakeSubmissionServer, id: string) {
  server.emails.set(id, { id, mailboxIds: { drafts: true }, keywords: { $draft: true, $seen: true } });
}

function to(...addresses: string[]) {
  return { ...OUTGOING, to: addresses.map((email) => ({ email })) };
}

/** The arguments of every call to `method`, in order. */
function argsOf(server: FakeSubmissionServer, method: string): Array<Record<string, any>> {
  return server.requests.flatMap(({ calls }) => calls.filter(([name]) => name === method).map(([, args]) => args));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSubmissionPrune();
  Object.assign(fake, { stalwart: true, accounts: ['acc-1'], username: 'me@example.com' });
});

afterEach(() => {
  vi.restoreAllMocks();
  // A record get reports as pending, with its time ahead, is never destroyed.
  expect(fake.server?.violations ?? []).toEqual([]);
});

describe('a send whose recipients the server refuses', () => {
  it.each(['1.0', '0.16.23', '0.16.10', '0.16.6'] as StalwartVersion[])(
    'Stalwart %s: fails when every recipient was refused, and keeps the previous draft',
    async (version) => {
      const server = setup(version, { refuseRecipient: relayOff });
      addDraft(server, 'old-draft');

      const err = await sendEmail(to('nobody@example.net'), 'id-1', 'sent', undefined, { ...VIA_DRAFTS, draftId: 'old-draft' })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(RecipientsRefusedError);
      expect((err as RecipientsRefusedError).recipients).toEqual([{ email: 'nobody@example.net', smtpReply: RELAY_DENIED }]);
      // The copy onSuccessUpdateEmail filed in Sent is gone, the previous
      // draft is not ...
      expect([...server.emails.keys()]).toEqual(['old-draft']);
      // ... and neither is the record, which can neither go out nor be cancelled.
      expect(server.submissions()).toEqual([]);
    },
  );

  it.each(['1.0', '0.16.23'] as StalwartVersion[])(
    'Stalwart %s: a held send (undo send, scheduled) is refused when it is created',
    async (version) => {
      const server = setup(version, { refuseRecipient: relayOff });

      const err = await sendEmail(to('nobody@example.net'), 'id-1', 'sent', 30, VIA_DRAFTS).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(RecipientsRefusedError);
      // The create answered final: nothing was queued to hold.
      expect(server.requests[0].responses[1][1].created['sub-1']).toMatchObject({ undoStatus: 'final' });
      expect(server.emails.size).toBe(0);
      expect(server.submissions()).toEqual([]);
    },
  );

  it('Stalwart 1.0: takes a used-up throttle for a refusal too', async () => {
    setup('1.0', { refuseRecipient: () => RATE_LIMITED });

    const err = await sendEmail(OUTGOING, 'id-1', 'sent', undefined, VIA_DRAFTS).catch((e: unknown) => e);

    expect((err as RecipientsRefusedError).recipients).toEqual([{ email: 'you@example.com', smtpReply: RATE_LIMITED }]);
  });

  it.each(['1.0', '0.16.23', '0.16.6'] as StalwartVersion[])(
    'Stalwart %s: names the refused recipients and sends to the others',
    async (version) => {
      const server = setup(version, { refuseRecipient: relayOff });
      addDraft(server, 'old-draft');

      const result = await sendEmail(
        to('you@example.com', 'nobody@example.net'), 'id-1', 'sent', undefined, { ...VIA_DRAFTS, draftId: 'old-draft' },
      );

      expect(result.refusedRecipients).toEqual([{ email: 'nobody@example.net', smtpReply: RELAY_DENIED }]);
      expect(result.filingWarning).toBeUndefined();
      // Sent as usual: the previous draft goes, the message stays in Sent.
      expect([...server.emails.keys()]).toEqual([result.emailId]);
      expect(server.emails.get(result.emailId!)?.mailboxIds).toEqual({ sent: true });
    },
  );

  it('Stalwart 1.0: reads the delivery status in the send request, before the record is destroyed', async () => {
    const server = setup('1.0', { refuseRecipient: relayOff });

    const result = await sendEmail(to('you@example.com', 'nobody@example.net'), 'id-1', 'sent', undefined, VIA_DRAFTS);

    expect(server.requests[0].calls[2]).toEqual(
      ['EmailSubmission/get', { accountId: 'acc-1', ids: ['#sub-1'], properties: ['id', 'deliveryStatus'] }, '2'],
    );
    expect(server.requests[0].using).toEqual([
      'urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:mail', 'urn:ietf:params:jmap:submission',
    ]);
    expect(server.requests.at(-1)?.calls).toEqual([
      ['EmailSubmission/set', { accountId: 'acc-1', destroy: [result.emailSubmissionId] }, '0'],
    ]);
  });

  it('Stalwart 1.0: asks again with the retry after a full submission quota', async () => {
    const server = setup('1.0', { limit: 1, refuseRecipient: relayOff });
    server.seed('acc-1', [{ sendAt: Date.now() - HOUR, status: 'final' }]);

    const err = await sendEmail(to('nobody@example.net'), 'id-1', 'sent', undefined, VIA_DRAFTS).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RecipientsRefusedError);
    const retry = server.requests.find(({ calls }) => calls[0][0] === 'EmailSubmission/set' && calls[0][1].create);
    expect(retry?.calls.map(([name]) => name)).toEqual(['EmailSubmission/set', 'EmailSubmission/get']);
    // Only the seeded record's message is left.
    expect([...server.emails.keys()].filter((id) => !id.startsWith('seed'))).toEqual([]);
    expect(server.submissions()).toEqual([]);
  });

  it('leaves the record to the prune on a server without urn:stalwart:jmap', async () => {
    fake.stalwart = false;
    const server = setup('1.0', { refuseRecipient: relayOff });

    await expect(sendEmail(to('nobody@example.net'), 'id-1', 'sent', undefined, VIA_DRAFTS))
      .rejects.toBeInstanceOf(RecipientsRefusedError);

    expect(server.emails.size).toBe(0);
    // Final: nothing was queued, so the prune may take it.
    expect(server.submissions()).toEqual([{ id: expect.any(String), sendAt: expect.any(Number), undoStatus: 'final' }]);
  });

  it('sends as before when the server tells nothing about the recipients', async () => {
    const server = setup('1.0', { refuseRecipient: relayOff });
    vi.mocked(jmapClient.request).mockImplementationOnce(async (calls, using) => {
      const res = await server.request(calls, using);
      return {
        methodResponses: res.methodResponses.map((r) => (r[0] === 'EmailSubmission/get'
          ? ['error', { type: 'unknownMethod' }, r[2]] as [string, Record<string, any>, string]
          : r)),
      };
    });

    const result = await sendEmail(to('nobody@example.net'), 'id-1', 'sent', undefined, VIA_DRAFTS);

    expect(result.emailSubmissionId).toBeDefined();
    expect(result.refusedRecipients).toBeUndefined();
    // The get's own failure is neither a failed send nor a filing problem.
    expect(result.filingWarning).toBeUndefined();
  });

  it('takes a server that keeps no delivery status for one that took everyone', async () => {
    setup('1.0');
    vi.mocked(jmapClient.request).mockResolvedValueOnce({
      methodResponses: [
        ['Email/set', { created: { draft: { id: 'e-new' } } }, '0'],
        ['EmailSubmission/set', { created: { 'sub-1': { id: 's-1' } } }, '1'],
        ['EmailSubmission/get', { list: [{ id: 's-1', deliveryStatus: null }], notFound: [] }, '2'],
      ],
    });
    fake.stalwart = false;

    const result = await sendEmail(OUTGOING, 'id-1', 'sent');

    expect(result).toMatchObject({ emailId: 'e-new', emailSubmissionId: 's-1' });
    expect(result.refusedRecipients).toBeUndefined();
  });

  it("reports a refused create with the create's own reason, not the get's (1.0 and 0.16.23 answer the same)", async () => {
    setup('1.0');
    vi.mocked(jmapClient.request)
      .mockResolvedValueOnce({
        methodResponses: [
          ['Email/set', { created: { draft: { id: 'e-new' } } }, '0'],
          ['EmailSubmission/set', { notCreated: { 'sub-1': { type: 'invalidProperties', description: 'Identity not found.', properties: ['identityId'] } } }, '1'],
          ['error', { type: 'invalidResultReference', description: 'Id reference "sub-1" does not exist or is invalid.' }, '2'],
        ],
      })
      .mockResolvedValueOnce({ methodResponses: [['Email/set', { destroyed: ['e-new'] }, '0']] });

    const err = await sendEmail(OUTGOING, 'id-x', 'sent', undefined, VIA_DRAFTS).catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(RecipientsRefusedError);
    expect((err as Error).message).toBe('Identity not found.');
  });
});

describe('"Send now" and "Reschedule" when the server refuses the recipients again', () => {
  /** A scheduled message to `recipients`, held for an hour. */
  function scheduledTo(server: FakeSubmissionServer, ...recipients: string[]) {
    server.emails.set('mail-1', {
      id: 'mail-1', mailboxIds: { sent: true }, keywords: {}, to: recipients.map((email) => ({ email })),
    });
    const [original] = server.seed('acc-1', [{ sendAt: Date.now() + HOUR, status: 'pending', emailId: 'mail-1' }]);
    return { emailSubmissionId: original, emailId: 'mail-1', identityId: 'id-1', from: [{ email: 'me@example.com' }] };
  }

  it.each([
    ['1.0', 0],
    ['1.0', 7200],
    ['0.16.23', 0],
    ['0.16.23', 7200],
  ] as Array<[StalwartVersion, number]>)(
    'Stalwart %s: keeps the original when every recipient of the replacement is refused (hold %is)',
    async (version, holdFor) => {
      // A throttle used up since the message was scheduled.
      const server = setup(version, { refuseRecipient: () => RATE_LIMITED });
      const scheduled = scheduledTo(server, 'bob@example.org');

      const err = await rescheduleScheduledSend(scheduled, holdFor).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(RecipientsRefusedError);
      expect((err as RecipientsRefusedError).recipients).toEqual([{ email: 'bob@example.org', smtpReply: RATE_LIMITED }]);
      // Still goes at its old time; no cancel went out, and the dead
      // replacement's record is gone.
      expect(argsOf(server, 'EmailSubmission/set').some((a) => a.update)).toBe(false);
      expect(server.submissions()).toEqual([
        { id: scheduled.emailSubmissionId, sendAt: expect.any(Number), undoStatus: 'pending' },
      ]);
    },
  );

  it('Stalwart 1.0: reads the replacement\'s delivery status with its create', async () => {
    const server = setup('1.0');
    const scheduled = scheduledTo(server, 'bob@example.org');

    await rescheduleScheduledSend(scheduled, 0);

    const create = server.requests.find(({ calls }) => calls[0][1].create);
    expect(create?.calls[1]).toEqual(
      ['EmailSubmission/get', { accountId: 'acc-1', ids: ['#replacement'], properties: ['id', 'deliveryStatus'] }, '1'],
    );
    expect(create?.using).toEqual(['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:submission']);
  });

  it.each(['1.0', '0.16.23'] as StalwartVersion[])(
    'Stalwart %s: names the recipients refused for the replacement and replaces the original',
    async (version) => {
      const server = setup(version, { refuseRecipient: relayOff });
      const scheduled = scheduledTo(server, 'bob@example.org', 'nobody@example.net');

      const result = await rescheduleScheduledSend(scheduled, 7200);

      expect(result.refusedRecipients).toEqual([{ email: 'nobody@example.net', smtpReply: RELAY_DENIED }]);
      expect(server.submissions()).toEqual([
        { id: result.emailSubmissionId, sendAt: expect.any(Number), undoStatus: 'pending' },
      ]);
    },
  );

  it('leaves the refused replacement to the prune on a server without urn:stalwart:jmap', async () => {
    fake.stalwart = false;
    const server = setup('1.0', { refuseRecipient: () => RATE_LIMITED });
    const scheduled = scheduledTo(server, 'bob@example.org');

    await expect(rescheduleScheduledSend(scheduled, 0)).rejects.toBeInstanceOf(RecipientsRefusedError);

    expect(server.submissions().map((s) => s.undoStatus)).toEqual(['pending', 'final']);
  });
});

describe('shared accounts that refuse the submission prune', () => {
  const queriedAccounts = (server: FakeSubmissionServer) => argsOf(server, 'EmailSubmission/query').map((q) => q.accountId);

  // 0.16.23 lists an account that shared only an address book or a calendar
  // with the submission capability, then refuses its records: "You are not an
  // owner of account e" (live, userc).
  it('Stalwart 0.16.23: leaves such an account alone while the app runs, without a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const server = setup('0.16.23', { forbiddenAccounts: ['e'] });
    fake.accounts = ['acc-1', 'e'];

    await pruneEmailSubmissions({ force: true });
    await pruneEmailSubmissions({ force: true });
    await listScheduledEmails();

    expect(queriedAccounts(server)).toEqual(['acc-1', 'e', 'acc-1', 'acc-1']);
    expect(warn).not.toHaveBeenCalled();
  });

  it('Stalwart 0.16.23: asks again for another login on the same server', async () => {
    const server = setup('0.16.23', { forbiddenAccounts: ['e'] });
    fake.accounts = ['acc-1', 'e'];

    await pruneEmailSubmissions({ force: true });
    fake.username = 'usera@example.com';
    await pruneEmailSubmissions({ force: true });

    expect(queriedAccounts(server)).toEqual(['acc-1', 'e', 'acc-1', 'e']);
  });

  it('Stalwart 1.0: keeps pruning a group account the user belongs to', async () => {
    const server = setup('1.0');
    fake.accounts = ['acc-1', 'team'];

    await pruneEmailSubmissions({ force: true });
    await pruneEmailSubmissions({ force: true });

    expect(queriedAccounts(server)).toEqual(['acc-1', 'team', 'acc-1', 'team']);
  });

  it('never leaves out the primary account, and warns about it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const server = setup('1.0', { forbiddenAccounts: ['acc-1'] });

    await pruneEmailSubmissions({ force: true });
    await pruneEmailSubmissions({ force: true });

    expect(queriedAccounts(server)).toEqual(['acc-1', 'acc-1']);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(jmapErrorType(warn.mock.calls[0][1])).toBe('forbidden');
  });

  it('keeps asking an account that failed for another reason', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const server = setup('1.0');
    fake.accounts = ['acc-1', 'team'];
    server.beforeEachRequest((calls) => {
      if ((calls[0][1] as { accountId?: string }).accountId === 'team') throw new Error('Network request failed');
    });

    await pruneEmailSubmissions({ force: true });
    await pruneEmailSubmissions({ force: true });

    expect(warn).toHaveBeenCalledTimes(2);
    server.beforeEachRequest(() => undefined);
    await pruneEmailSubmissions({ force: true });
    expect(queriedAccounts(server)).toEqual(['acc-1', 'acc-1', 'acc-1', 'team']);
  });
});
