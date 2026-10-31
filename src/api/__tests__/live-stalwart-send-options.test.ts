/**
 * Live checks of the composer's send options against a real Stalwart: the
 * priority headers (webmail #970), the read-receipt request and the DSN /
 * REQUIRETLS envelope parameters (webmail submissionEnvelopeParameters).
 *
 * Opt-in like live-stalwart.test.ts: skipped unless `BULWARK_LIVE_JMAP` and
 * `BULWARK_LIVE_PASS` are set.
 *
 *   BULWARK_LIVE_JMAP=http://10.10.10.62:8120 \
 *   BULWARK_LIVE_USER=e2e-perf@example.org BULWARK_LIVE_PASS=… \
 *   npx vitest run src/api/__tests__/live-stalwart-send-options.test.ts
 *
 * Mail goes to the user's own address; everything it creates is removed.
 * Verified against Stalwart 0.16.27 and 1.0.1 (2026-10-31).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { JMAPClient } from '../jmap-client';
import { cancelScheduledSend, destroyEmails, getMailboxes, listScheduledEmails, rescheduleScheduledSend, sendEmail } from '../email';
import { getIdentities } from '../identity';
import { supportsSubmissionExtension } from '../../lib/submission-options';

const SERVER = process.env.BULWARK_LIVE_JMAP;
const USER = process.env.BULWARK_LIVE_USER ?? 'e2e-perf@example.org';
const PASS = process.env.BULWARK_LIVE_PASS ?? '';
const live = SERVER && PASS ? describe : describe.skip;

const RUN_STARTED = Date.now();
const RUN = RUN_STARTED.toString(36);

let singleton: JMAPClient;

live('live Stalwart: composer send options', () => {
  let drafts = '';
  let sent = '';
  const tag = `bulwark-sendopts-${RUN}`;
  const createdEmails: string[] = [];

  beforeAll(async () => {
    const mod = await import('../jmap-client');
    singleton = mod.jmapClient as unknown as JMAPClient;
    const client = new JMAPClient();
    await client.connect(SERVER!, USER, PASS);
    singleton.restoreSnapshot(client.snapshot());
    const boxes = await getMailboxes();
    drafts = boxes.find((b) => b.role === 'drafts')?.id ?? '';
    sent = boxes.find((b) => b.role === 'sent')?.id ?? '';
  }, 60_000);

  afterAll(async () => {
    const held = await listScheduledEmails().catch(() => []);
    for (const s of held.filter((h) => createdEmails.includes(h.emailId))) {
      await cancelScheduledSend(s.emailSubmissionId).catch(() => undefined);
    }
    // Not a subject search: Stalwart answers that from a full-text index
    // that lags. Every message since the run began is read and compared.
    const res = await singleton.request([
      ['Email/query', { accountId: singleton.accountId, filter: { after: new Date(RUN_STARTED - 60_000).toISOString() }, limit: 500 }, '0'],
      ['Email/get', {
        accountId: singleton.accountId, '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['id', 'subject'],
      }, '1'],
    ]);
    const matching = (res.methodResponses[1][1].list as Array<{ id: string; subject?: string }> ?? [])
      .filter((e) => e.subject?.includes(tag)).map((e) => e.id);
    const leftovers = [...new Set([...(matching), ...createdEmails])];
    if (leftovers.length) await destroyEmails(leftovers).catch(() => undefined);
  }, 60_000);

  it('lists DSN and REQUIRETLS in the submission extensions', () => {
    expect(supportsSubmissionExtension('DSN')).toBe(true);
    expect(supportsSubmissionExtension('REQUIRETLS')).toBe(true);
  });

  it('files the priority and read-receipt headers with the sent message', async () => {
    const [identity] = await getIdentities();
    const result = await sendEmail(
      {
        from: [{ email: identity.email }], to: [{ email: identity.email }],
        subject: `priority ${tag}`, textBody: 'live', priority: 'high', requestReadReceipt: true,
      },
      identity.id, sent, undefined, { draftsMailboxId: drafts, requestDsn: true },
    );
    createdEmails.push(result.emailId!);
    expect(result.emailSubmissionId).toBeTruthy();
    const res = await singleton.request([['Email/get', {
      accountId: singleton.accountId,
      ids: [result.emailId],
      properties: ['mailboxIds', 'header:X-Priority:asText', 'header:Importance:asText', 'header:Disposition-Notification-To:asText'],
    }, '0']]);
    const [email] = res.methodResponses[0][1].list;
    expect(email.mailboxIds[sent]).toBe(true);
    expect(email['header:X-Priority:asText']?.trim()).toBe('1 (Highest)');
    expect(email['header:Importance:asText']?.trim()).toBe('high');
    expect(email['header:Disposition-Notification-To:asText']?.trim()).toBe(identity.email);
  }, 60_000);

  it('submits with RET/NOTIFY and REQUIRETLS on the envelope', async () => {
    const [identity] = await getIdentities();
    // Held, so the submission record (and its envelope) can be read back.
    const result = await sendEmail(
      { from: [{ email: identity.email }], to: [{ email: identity.email }], subject: `dsn ${tag}`, textBody: 'live' },
      identity.id, sent, 3600, { draftsMailboxId: drafts, requestDsn: true, requireTls: true },
    );
    createdEmails.push(result.emailId!);
    const res = await singleton.request([['EmailSubmission/get', {
      accountId: singleton.accountId, ids: [result.emailSubmissionId], properties: ['envelope', 'undoStatus'],
    }, '0']], ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:submission']);
    const [submission] = res.methodResponses[0][1].list;
    expect(submission.undoStatus).toBe('pending');
    expect(submission.envelope.mailFrom.email).toBe(identity.email);
    expect(submission.envelope.mailFrom.parameters).toMatchObject({ RET: 'HDRS', HOLDFOR: '3600' });
    expect('REQUIRETLS' in submission.envelope.mailFrom.parameters).toBe(true);
    expect(submission.envelope.rcptTo).toEqual([
      expect.objectContaining({ email: identity.email, parameters: expect.objectContaining({ NOTIFY: 'SUCCESS,FAILURE,DELAY' }) }),
    ]);

    // Moved to another time, it keeps them.
    const held = (await listScheduledEmails()).find((s) => s.emailSubmissionId === result.emailSubmissionId)!;
    const moved = await rescheduleScheduledSend(held, 7200);
    const after = await singleton.request([['EmailSubmission/get', {
      accountId: singleton.accountId, ids: [moved.emailSubmissionId], properties: ['envelope'],
    }, '0']], ['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:submission']);
    const [replacement] = after.methodResponses[0][1].list;
    expect(replacement.envelope.mailFrom.parameters).toMatchObject({ RET: 'HDRS', HOLDFOR: '7200' });
    expect('REQUIRETLS' in replacement.envelope.mailFrom.parameters).toBe(true);
    expect(replacement.envelope.rcptTo[0].parameters).toMatchObject({ NOTIFY: 'SUCCESS,FAILURE,DELAY' });
    await cancelScheduledSend(moved.emailSubmissionId!);
  }, 60_000);
});
