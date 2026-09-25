import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FakeSubmissionServer } from './fake-submission-server';

// Stalwart 1.0 refuses new submissions once an account holds `maxSubmissions`
// EmailSubmission records (500 by default), counting every record whatever its
// status or age. These tests run the send paths against a fake Stalwart
// (./fake-submission-server) in the 0.16 and 1.0 shapes, and check after each
// one that no submission get reports as pending with sendAt ahead was ever
// destroyed: that record is the only way to cancel the mail.

const fake = vi.hoisted(() => ({
  server: undefined as unknown as FakeSubmissionServer,
  stalwart: true,
  submission: true,
  accounts: ['acc-1'],
  maxInGet: 500,
  maxInSet: 500,
}));

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    serverUrl: 'https://mail.example.com',
    request: vi.fn((calls: never, using?: string[]) => fake.server.request(calls, using)),
    hasCapability: vi.fn((urn: string) => urn !== 'urn:ietf:params:jmap:submission' || fake.submission),
    hasAccountCapability: vi.fn((urn: string) => urn !== 'urn:stalwart:jmap' || fake.stalwart),
    getSubmissionAccountIds: vi.fn(() => fake.accounts),
    hasDelayedSend: vi.fn(() => true),
    getMaxObjectsInGet: vi.fn(() => fake.maxInGet),
    getMaxObjectsInSet: vi.fn(() => fake.maxInSet),
    getMaxCallsInRequest: vi.fn(() => 16),
    learnHoldLimit: vi.fn(),
  },
}));

// blob.ts pulls in expo-file-system; the receipt only needs the byte upload.
vi.mock('../blob', () => ({
  uploadBytes: vi.fn(async () => ({ blobId: 'blob-1', size: 1, type: 'message/rfc822' })),
}));

import { jmapClient } from '../jmap-client';
import {
  cancelScheduledSend, listScheduledEmails, rescheduleScheduledSend, sendEmail, sendReadReceipt,
} from '../email';
import { SubmissionQuotaError } from '../jmap-result';
import { prunableSubmissionIds, pruneEmailSubmissions, resetSubmissionPrune } from '../submissions';
import { createFakeSubmissionServer, OVER_QUOTA_DESCRIPTION, type StalwartVersion } from './fake-submission-server';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const OUTGOING = {
  from: [{ email: 'me@example.com' }],
  to: [{ email: 'you@example.com' }],
  subject: 'Hello',
  textBody: 'Hi',
};
const VIA_DRAFTS = { draftsMailboxId: 'drafts' };
const RECEIPT = {
  to: 'sender@remote.example',
  fromEmail: 'me@example.com',
  identityId: 'id-1',
  sentMailboxId: 'sent',
  originalSubject: 'Hello',
  automatic: true,
};

function setup(version: StalwartVersion, options: { limit?: number; maxChanges?: number; omitTotal?: boolean } = {}) {
  fake.server = createFakeSubmissionServer({ version, ...options });
  return fake.server;
}

function addDraft(server: FakeSubmissionServer, id: string) {
  server.emails.set(id, { id, mailboxIds: { drafts: true }, keywords: { $draft: true, $seen: true } });
}

/** The arguments of every call to `method`, in order. */
function argsOf(server: FakeSubmissionServer, method: string): Array<Record<string, any>> {
  return server.requests.flatMap(({ calls }) => calls.filter(([name]) => name === method).map(([, args]) => args));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSubmissionPrune();
  Object.assign(fake, { stalwart: true, submission: true, accounts: ['acc-1'], maxInGet: 500, maxInSet: 500 });
});

afterEach(() => {
  vi.restoreAllMocks();
  // The rule that must always hold.
  expect(fake.server?.violations ?? []).toEqual([]);
});

describe('prunableSubmissionIds', () => {
  it('picks canceled records and final ones whose sendAt has passed, never a pending one', () => {
    const now = Date.parse('2026-09-25T12:00:00Z');
    expect(prunableSubmissionIds([
      { id: 'held', sendAt: '2026-09-25T13:00:00Z', undoStatus: 'pending' },
      { id: 'retrying', sendAt: '2026-09-25T11:00:00Z', undoStatus: 'pending' },
      { id: 'delivered', sendAt: '2026-09-25T11:00:00Z', undoStatus: 'final' },
      { id: 'delivered-now', sendAt: '2026-09-25T12:00:00Z', undoStatus: 'final' },
      { id: 'final-ahead', sendAt: '2026-09-25T13:00:00Z', undoStatus: 'final' },
      { id: 'canceled-ahead', sendAt: '2026-09-26T12:00:00Z', undoStatus: 'canceled' },
      { id: 'canceled-old', sendAt: '2026-09-01T12:00:00Z', undoStatus: 'canceled' },
      { id: 'no-send-at', undoStatus: 'final' },
      { id: 'no-status', sendAt: '2026-09-25T11:00:00Z' },
      { id: 'bad-date', sendAt: 'soon', undoStatus: 'final' },
    ], now)).toEqual(['delivered', 'delivered-now', 'canceled-ahead', 'canceled-old']);
  });
});

describe('an immediate send removes its own submission record', () => {
  it.each(['0.16.6', '0.16.10', '0.16.23', '1.0'] as StalwartVersion[])(
    'Stalwart %s: a send without a draft removes it in a request of its own',
    async (version) => {
      const server = setup(version);

      const result = await sendEmail(OUTGOING, 'id-1', 'sent', undefined, VIA_DRAFTS);

      expect(server.methods()).toEqual([['Email/set', 'EmailSubmission/set'], ['EmailSubmission/set']]);
      expect(argsOf(server, 'EmailSubmission/set')[1]).toEqual({ accountId: 'acc-1', destroy: [result.emailSubmissionId] });
      expect(server.requests[1].using).toEqual(['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:submission']);
      expect(server.submissions()).toEqual([]);
      // The message itself is untouched: filed in Sent.
      expect(server.emails.get(result.emailId!)?.mailboxIds).toEqual({ sent: true });
    },
  );

  it('Stalwart 1.0: a send from a draft removes the record with the old draft, in one request', async () => {
    const server = setup('1.0');
    addDraft(server, 'old-draft');

    const result = await sendEmail(OUTGOING, 'id-1', 'sent', undefined, { ...VIA_DRAFTS, draftId: 'old-draft' });

    expect(result.filingWarning).toBeUndefined();
    expect(server.methods()).toEqual([['Email/set', 'EmailSubmission/set'], ['Email/set', 'EmailSubmission/set']]);
    expect(server.requests[1].calls).toEqual([
      ['Email/set', { accountId: 'acc-1', destroy: ['old-draft'] }, '0'],
      ['EmailSubmission/set', { accountId: 'acc-1', destroy: [result.emailSubmissionId] }, '1'],
    ]);
    expect(server.requests[1].using).toContain('urn:ietf:params:jmap:submission');
    expect(server.submissions()).toEqual([]);
    expect(server.emails.has('old-draft')).toBe(false);
  });

  it.each(['0.16.10', '0.16.23', '1.0'] as StalwartVersion[])(
    'Stalwart %s: a send held for the undo window keeps its record, whatever the create answered',
    async (version) => {
      // 0.16.10-0.16.16 answer undoStatus "final" even for this held send.
      const server = setup(version);

      const result = await sendEmail(OUTGOING, 'id-1', 'sent', 10, VIA_DRAFTS);

      expect(result.scheduled).toBe(true);
      expect(server.methods()).toEqual([['Email/set', 'EmailSubmission/set']]);
      expect(server.submissions()).toEqual([{ id: result.emailSubmissionId, sendAt: expect.any(Number), undoStatus: 'pending' }]);
    },
  );

  it('leaves the record to the prune on a server without urn:stalwart:jmap', async () => {
    fake.stalwart = false;
    const server = setup('1.0');

    await sendEmail(OUTGOING, 'id-1', 'sent', undefined, VIA_DRAFTS);

    expect(server.methods()).toEqual([['Email/set', 'EmailSubmission/set']]);
    expect(server.submissions()).toHaveLength(1);
  });

  it('never turns a record that could not be removed into a filing warning (1.0)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const server = setup('1.0');
    addDraft(server, 'old-draft');
    vi.mocked(jmapClient.request)
      .mockImplementationOnce((calls, using) => server.request(calls, using))
      .mockResolvedValueOnce({
        methodResponses: [
          ['Email/set', { accountId: 'acc-1', destroyed: ['old-draft'] }, '0'],
          ['EmailSubmission/set', { accountId: 'acc-1', notDestroyed: { s1: { type: 'forbidden' } } }, '1'],
        ],
      });

    const result = await sendEmail(OUTGOING, 'id-1', 'sent', undefined, { ...VIA_DRAFTS, draftId: 'old-draft' });

    expect(result.filingWarning).toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[submissions] not destroyed:', { s1: { type: 'forbidden' } });
  });

  it('Stalwart 1.0: 600 sends in a row never reach the limit of 500', async () => {
    const server = setup('1.0', { limit: 500 });

    for (let i = 0; i < 600; i++) await sendEmail(OUTGOING, 'id-1', 'sent', undefined, VIA_DRAFTS);

    expect(server.submissions()).toEqual([]);
  });
});

describe('a full submission quota on a send (Stalwart 1.0)', () => {
  it('removes what can go and submits the Drafts copy again', async () => {
    const server = setup('1.0', { limit: 5 });
    const now = Date.now();
    const [scheduled] = server.seed('acc-1', [{ sendAt: now + DAY, status: 'pending' }]);
    server.seed('acc-1', [
      { sendAt: now - HOUR, status: 'final' },
      { sendAt: now - 2 * HOUR, status: 'final' },
      { sendAt: now - 2 * DAY, status: 'final' },
      { sendAt: now + 2 * DAY, status: 'canceled' },
    ]);

    const result = await sendEmail(OUTGOING, 'id-1', 'sent', undefined, VIA_DRAFTS);

    // The first create was refused in Stalwart's words...
    expect(server.requests[0].responses[1]).toEqual(['EmailSubmission/set', expect.objectContaining({
      notCreated: { 'sub-1': { type: 'overQuota', description: OVER_QUOTA_DESCRIPTION } },
    }), '1']);
    // ...then the prune made room and the copy already in Drafts went out.
    expect(server.methods()).toEqual([
      ['Email/set', 'EmailSubmission/set'],
      ['EmailSubmission/query', 'EmailSubmission/get'],
      ['EmailSubmission/set'],
      ['EmailSubmission/set'],
      ['EmailSubmission/set'],
    ]);
    const retry = argsOf(server, 'EmailSubmission/set')[2];
    expect(retry.create['sub-1']).toEqual({ emailId: result.emailId, identityId: 'id-1' });
    expect(retry.onSuccessUpdateEmail).toEqual({ '#sub-1': { mailboxIds: { sent: true }, 'keywords/$draft': null } });
    expect(server.emails.get(result.emailId!)?.mailboxIds).toEqual({ sent: true });
    // Only the scheduled send is left; the new send's own record went too.
    expect(server.submissions().map((s) => s.id)).toEqual([scheduled]);
  });

  it('finds records older than three days in the change log', async () => {
    const server = setup('1.0', { limit: 5, maxChanges: 2 });
    server.seed('acc-1', Array.from({ length: 5 }, (_, i) => ({ sendAt: Date.now() - (10 + i) * DAY, status: 'final' as const })));

    const result = await sendEmail(OUTGOING, 'id-1', 'sent', undefined, VIA_DRAFTS);

    expect(result.emailSubmissionId).toBeDefined();
    // The query can't see them; the log is read from "n" through each newState.
    expect(argsOf(server, 'EmailSubmission/query')).toHaveLength(1);
    expect(argsOf(server, 'EmailSubmission/changes').map((a) => a.sinceState)).toEqual(['n', 'r2', 'r4']);
    expect(argsOf(server, 'EmailSubmission/get').at(-1)).toMatchObject({ ids: ['s1', 's2', 's3', 's4', 's5'] });
    expect(server.submissions()).toEqual([]);
  });

  it('gives up with SubmissionQuotaError when nothing can go, and leaves no copy in Drafts', async () => {
    const server = setup('1.0', { limit: 3 });
    const now = Date.now();
    const pending = server.seed('acc-1', [
      { sendAt: now + DAY, status: 'pending' },
      { sendAt: now + 2 * DAY, status: 'pending' },
      // Past its sendAt but still in the queue (retrying): pending too.
      { sendAt: now - HOUR, status: 'pending' },
    ]);
    addDraft(server, 'old-draft');

    const err = await sendEmail(OUTGOING, 'id-1', 'sent', undefined, { ...VIA_DRAFTS, draftId: 'old-draft' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SubmissionQuotaError);
    expect(err).toMatchObject({ type: 'overQuota', message: OVER_QUOTA_DESCRIPTION });
    // One retry only.
    expect(argsOf(server, 'EmailSubmission/set').filter((a) => a.create)).toHaveLength(2);
    expect(server.submissions().map((s) => s.id)).toEqual(pending);
    // The copy made for this attempt is gone; the user's own draft stays.
    const drafts = [...server.emails.values()].filter((e) => e.mailboxIds.drafts).map((e) => e.id);
    expect(drafts).toEqual(['old-draft']);
  });

  it('does not walk the change log on a server without urn:stalwart:jmap', async () => {
    fake.stalwart = false;
    const server = setup('1.0', { limit: 2 });
    server.seed('acc-1', [
      { sendAt: Date.now() - 10 * DAY, status: 'final' },
      { sendAt: Date.now() - 11 * DAY, status: 'final' },
    ]);

    const err = await sendEmail(OUTGOING, 'id-1', 'sent', undefined, VIA_DRAFTS).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SubmissionQuotaError);
    expect(server.methods().flat()).not.toContain('EmailSubmission/changes');
  });

  it('keeps a full mailbox (Email/set overQuota) apart from the submission quota', async () => {
    const server = setup('1.0');
    server.failNextEmailCreate({ type: 'overQuota', description: 'Account quota exceeded.' });

    const err = await sendEmail(OUTGOING, 'id-1', 'sent', undefined, VIA_DRAFTS).catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(SubmissionQuotaError);
    expect((err as Error).message).toContain('Account quota exceeded.');
    expect(server.methods()).toEqual([['Email/set', 'EmailSubmission/set']]);
  });

  it('Stalwart 0.16.23 does not enforce the limit: no retry is ever needed', async () => {
    const server = setup('0.16.23', { limit: 1 });
    server.seed('acc-1', [{ sendAt: Date.now() + DAY, status: 'pending' }, { sendAt: Date.now() + DAY, status: 'pending' }]);

    await sendEmail(OUTGOING, 'id-1', 'sent', 10, VIA_DRAFTS);

    expect(server.methods()).toEqual([['Email/set', 'EmailSubmission/set']]);
  });
});

describe('the background prune', () => {
  it.each(['0.16.23', '1.0'] as StalwartVersion[])(
    'Stalwart %s: removes canceled and delivered records in every submission account, never a pending one',
    async (version) => {
      const server = setup(version);
      fake.accounts = ['acc-1', 'grp-1'];
      const now = Date.now();
      const kept = server.seed('acc-1', [
        { sendAt: now + DAY, status: 'pending' },
        { sendAt: now - HOUR, status: 'pending' },
      ]);
      server.seed('acc-1', [
        { sendAt: now - HOUR, status: 'final' },
        { sendAt: now + DAY, status: 'canceled' },
        { sendAt: now - 2 * DAY, status: 'canceled' },
      ]);
      const keptInGroup = server.seed('grp-1', [{ sendAt: now + 2 * HOUR, status: 'pending' }]);
      server.seed('grp-1', [{ sendAt: now - 2 * DAY, status: 'final' }]);

      await expect(pruneEmailSubmissions()).resolves.toBe(4);

      expect(server.submissions('acc-1').map((s) => s.id)).toEqual(kept);
      expect(server.submissions('grp-1').map((s) => s.id)).toEqual(keptInGroup);
      expect(argsOf(server, 'EmailSubmission/query')[0]).toMatchObject({
        filter: { operator: 'OR', conditions: [{ before: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/) }, { undoStatus: 'canceled' }] },
        calculateTotal: true,
      });
    },
  );

  it('reads the query page by page and destroys in batches the server accepts', async () => {
    const server = setup('1.0');
    fake.maxInGet = 2;
    fake.maxInSet = 2;
    server.seed('acc-1', Array.from({ length: 5 }, (_, i) => ({ sendAt: Date.now() - (i + 1) * HOUR, status: 'final' as const })));

    await expect(pruneEmailSubmissions()).resolves.toBe(5);

    expect(argsOf(server, 'EmailSubmission/query').map((a) => [a.position, a.limit])).toEqual([[0, 2], [2, 2], [4, 2]]);
    expect(argsOf(server, 'EmailSubmission/set').map((a) => a.destroy)).toEqual([['s5', 's4'], ['s3', 's2'], ['s1']]);
  });

  it('stops at a short page when the server leaves out total', async () => {
    const server = setup('1.0', { omitTotal: true });
    fake.maxInGet = 2;
    server.seed('acc-1', Array.from({ length: 3 }, () => ({ sendAt: Date.now() - HOUR, status: 'final' as const })));

    await expect(pruneEmailSubmissions()).resolves.toBe(3);

    expect(argsOf(server, 'EmailSubmission/query').map((a) => a.position)).toEqual([0, 2]);
  });

  it('runs at most once per account in ten minutes unless forced', async () => {
    const server = setup('1.0');
    const start = Date.now();
    server.seed('acc-1', [{ sendAt: start - HOUR, status: 'final' }]);
    await expect(pruneEmailSubmissions()).resolves.toBe(1);

    server.seed('acc-1', [{ sendAt: start - HOUR, status: 'final' }]);
    const requestsBefore = server.requests.length;
    await expect(pruneEmailSubmissions()).resolves.toBe(0);
    expect(server.requests).toHaveLength(requestsBefore);

    vi.spyOn(Date, 'now').mockReturnValue(start + 11 * MINUTE);
    await expect(pruneEmailSubmissions()).resolves.toBe(1);

    server.seed('acc-1', [{ sendAt: start - HOUR, status: 'final' }]);
    await expect(pruneEmailSubmissions({ force: true })).resolves.toBe(1);
  });

  it('asks nothing of a server without submission', async () => {
    fake.submission = false;
    const server = setup('1.0');

    await expect(pruneEmailSubmissions()).resolves.toBe(0);

    expect(server.requests).toEqual([]);
  });

  it('never rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    setup('1.0');
    vi.mocked(jmapClient.request).mockRejectedValueOnce(new Error('Network request failed'));

    await expect(pruneEmailSubmissions()).resolves.toBe(0);
    expect(warn).toHaveBeenCalled();
  });
});

describe('cancelling a scheduled send', () => {
  it.each(['0.16.23', '1.0'] as StalwartVersion[])(
    'Stalwart %s: removes the canceled record in a request of its own, once the cancel is confirmed',
    async (version) => {
      const server = setup(version);
      const [held] = server.seed('acc-1', [{ sendAt: Date.now() + HOUR, status: 'pending' }]);

      await cancelScheduledSend(held);

      expect(server.requests.map(({ calls }) => calls)).toEqual([
        [['EmailSubmission/set', { accountId: 'acc-1', update: { [held]: { undoStatus: 'canceled' } } }, '0']],
        [['EmailSubmission/set', { accountId: 'acc-1', destroy: [held] }, '0']],
      ]);
      expect(server.submissions()).toEqual([]);
    },
  );

  it('removes nothing when the cancel is refused because the mail went out', async () => {
    const server = setup('1.0');
    const [sent] = server.seed('acc-1', [{ sendAt: Date.now() - MINUTE, status: 'final' }]);

    await expect(cancelScheduledSend(sent)).rejects.toThrow('The message has already been sent.');

    expect(server.requests).toHaveLength(1);
    expect(server.submissions().map((s) => s.id)).toEqual([sent]);
  });

  it('removes nothing when the cancel failed in transit', async () => {
    const server = setup('1.0');
    const [held] = server.seed('acc-1', [{ sendAt: Date.now() + HOUR, status: 'pending' }]);
    vi.mocked(jmapClient.request).mockRejectedValueOnce(new Error('Network request failed'));

    await expect(cancelScheduledSend(held)).rejects.toThrow('Network request failed');

    expect(server.submissions().map((s) => s.id)).toEqual([held]);
  });
});

describe('rescheduling and "Send now"', () => {
  const scheduled = (emailSubmissionId: string) => ({
    emailSubmissionId,
    emailId: 'mail-1',
    identityId: 'id-1',
    from: [{ email: 'me@example.com' }],
  });

  it('Stalwart 0.16.23: "Send now" leaves only the replacement behind', async () => {
    const server = setup('0.16.23');
    const [original] = server.seed('acc-1', [{ sendAt: Date.now() + HOUR, status: 'pending', emailId: 'mail-1' }]);

    const result = await rescheduleScheduledSend(scheduled(original), 0);

    expect(server.submissions()).toEqual([{ id: result.emailSubmissionId, sendAt: expect.any(Number), undoStatus: 'pending' }]);
    expect(argsOf(server, 'EmailSubmission/set').map((a) => a.destroy).filter(Boolean)).toEqual([[original]]);
  });

  it('Stalwart 1.0: a full quota makes room without touching the pending original', async () => {
    const server = setup('1.0', { limit: 3 });
    const now = Date.now();
    const [original] = server.seed('acc-1', [{ sendAt: now + HOUR, status: 'pending', emailId: 'mail-1' }]);
    server.seed('acc-1', [{ sendAt: now - HOUR, status: 'final' }, { sendAt: now - 2 * HOUR, status: 'final' }]);

    const result = await rescheduleScheduledSend(scheduled(original), 2 * 3600);

    expect(argsOf(server, 'EmailSubmission/set').filter((a) => a.create)).toHaveLength(2);
    expect(server.submissions()).toEqual([{ id: result.emailSubmissionId, sendAt: expect.any(Number), undoStatus: 'pending' }]);
  });

  it('Stalwart 1.0: still full after making room, the original stays scheduled', async () => {
    const server = setup('1.0', { limit: 1 });
    const [original] = server.seed('acc-1', [{ sendAt: Date.now() + HOUR, status: 'pending', emailId: 'mail-1' }]);

    const err = await rescheduleScheduledSend(scheduled(original), 0).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SubmissionQuotaError);
    expect(argsOf(server, 'EmailSubmission/set').some((a) => a.update)).toBe(false);
    expect(server.submissions()).toEqual([{ id: original, sendAt: expect.any(Number), undoStatus: 'pending' }]);
  });
});

describe('read receipts', () => {
  it('Stalwart 1.0: a sent receipt removes its record at once', async () => {
    const server = setup('1.0');

    const emailId = await sendReadReceipt(RECEIPT);

    expect(server.methods()).toEqual([['Email/import'], ['EmailSubmission/set'], ['EmailSubmission/set']]);
    expect(server.submissions()).toEqual([]);
    expect(server.emails.get(emailId)?.mailboxIds).toEqual({ sent: true });
  });

  it('Stalwart 1.0: a full quota makes room and retries once', async () => {
    const server = setup('1.0', { limit: 1 });
    server.seed('acc-1', [{ sendAt: Date.now() - HOUR, status: 'final' }]);

    await sendReadReceipt(RECEIPT);

    expect(argsOf(server, 'EmailSubmission/set').filter((a) => a.create)).toHaveLength(2);
    expect(server.submissions()).toEqual([]);
  });

  it('Stalwart 1.0: still full, it fails with SubmissionQuotaError and the receipt leaves Sent', async () => {
    const server = setup('1.0', { limit: 1 });
    const [held] = server.seed('acc-1', [{ sendAt: Date.now() + DAY, status: 'pending' }]);

    const err = await sendReadReceipt(RECEIPT).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(SubmissionQuotaError);
    expect([...server.emails.values()].filter((e) => e.mailboxIds.sent && !e.id.startsWith('seed'))).toEqual([]);
    expect(server.submissions().map((s) => s.id)).toEqual([held]);
  });
});

describe('the scheduled list', () => {
  it('Stalwart 1.0: reads every page, so the mail scheduled furthest ahead is still listed', async () => {
    const server = setup('1.0', { limit: 1000 });
    fake.maxInGet = 50;
    const now = Date.now();
    server.seed('acc-1', Array.from({ length: 120 }, (_, i) => ({ sendAt: now - HOUR - i * MINUTE, status: 'final' as const })));
    const [ahead] = server.seed('acc-1', [{ sendAt: now + 5 * DAY, status: 'pending', emailId: 'mail-ahead' }]);

    const list = await listScheduledEmails();

    expect(list.map((s) => s.emailSubmissionId)).toEqual([ahead]);
    expect(argsOf(server, 'EmailSubmission/query').map((a) => [a.position, a.limit, a.calculateTotal]))
      .toEqual([[0, 50, true], [50, 50, true], [100, 50, true]]);
  });

  it('stops at a short page when the server leaves out total (0.16.23)', async () => {
    const server = setup('0.16.23', { omitTotal: true });
    fake.maxInGet = 2;
    const now = Date.now();
    const ids = server.seed('acc-1', [
      { sendAt: now + HOUR, status: 'pending', emailId: 'mail-1' },
      { sendAt: now + 2 * HOUR, status: 'pending', emailId: 'mail-2' },
      { sendAt: now + 3 * HOUR, status: 'pending', emailId: 'mail-3' },
    ]);

    const list = await listScheduledEmails();

    expect(list.map((s) => s.emailSubmissionId)).toEqual(ids);
    expect(argsOf(server, 'EmailSubmission/query').map((a) => a.position)).toEqual([0, 2]);
  });
});
