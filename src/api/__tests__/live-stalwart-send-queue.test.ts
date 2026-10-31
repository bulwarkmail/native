/**
 * Live checks of the offline send queue's rule against sending twice: a
 * message is found by its Message-ID, a copy that went out stops a resend,
 * and the autosaved draft alone does not.
 *
 * Opt-in like live-stalwart.test.ts: skipped unless `BULWARK_LIVE_JMAP` and
 * `BULWARK_LIVE_PASS` are set.
 *
 *   BULWARK_LIVE_JMAP=http://10.10.10.62:8120 \
 *   BULWARK_LIVE_USER=e2e-perf@example.org BULWARK_LIVE_PASS=… \
 *   npx vitest run src/api/__tests__/live-stalwart-send-queue.test.ts
 *
 * Mail goes to the user's own address; everything it creates is removed.
 * Verified against Stalwart 0.16.27 and 1.0.1 (2026-10-31).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

import { JMAPClient } from '../jmap-client';
import { destroyEmails, getMailboxes, saveDraftVersion, sendEmail } from '../email';
import { getIdentities } from '../identity';
import { findCopiesByMessageId, runQueuedSend } from '../queued-send';
import { generateMessageId } from '../../lib/email-threading';
import { newQueuedSend } from '../../lib/send-queue';
import type { Identity, Mailbox } from '../types';

const SERVER = process.env.BULWARK_LIVE_JMAP;
const USER = process.env.BULWARK_LIVE_USER ?? 'e2e-perf@example.org';
const PASS = process.env.BULWARK_LIVE_PASS ?? '';
const live = SERVER && PASS ? describe : describe.skip;

const RUN_STARTED = Date.now();
const RUN = RUN_STARTED.toString(36);

let singleton: JMAPClient;

live('live Stalwart: offline send queue', () => {
  let drafts = '';
  let sent = '';
  let boxes: Mailbox[] = [];
  let identity: Identity;
  const tag = `bulwark-sendqueue-${RUN}`;

  beforeAll(async () => {
    const mod = await import('../jmap-client');
    singleton = mod.jmapClient as unknown as JMAPClient;
    const client = new JMAPClient();
    await client.connect(SERVER!, USER, PASS);
    singleton.restoreSnapshot(client.snapshot());
    boxes = await getMailboxes();
    drafts = boxes.find((b) => b.role === 'drafts')?.id ?? '';
    sent = boxes.find((b) => b.role === 'sent')?.id ?? '';
    [identity] = await getIdentities();
  }, 60_000);

  afterAll(async () => {
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
    const leftovers = matching;
    if (leftovers.length) await destroyEmails(leftovers).catch(() => undefined);
  }, 60_000);

  const message = (subject: string) => ({
    from: [{ email: identity.email }],
    to: [{ email: identity.email }],
    subject: `${subject} ${tag}`,
    textBody: 'live',
    messageId: generateMessageId(identity.email),
  });

  const started = Date.now();
  const lookup = () => ({ mailboxIds: [sent, drafts], since: started });

  const payloadFor = (outgoing: ReturnType<typeof message>, draftId?: string) => ({
    outgoing, identity, fromEmail: identity.email, sentMailboxId: sent, draftsMailboxId: drafts, draftId,
  });

  it('finds a message by its Message-ID, and only that one', async () => {
    const outgoing = message('lookup');
    const result = await sendEmail(outgoing, identity.id, sent, undefined, { draftsMailboxId: drafts });
    const copies = await findCopiesByMessageId(outgoing.messageId, lookup());
    expect(copies.map((c) => c.id)).toEqual([result.emailId]);
    expect(copies[0].keywords?.$draft).toBeFalsy();
    expect(await findCopiesByMessageId(generateMessageId(identity.email), lookup())).toEqual([]);
  }, 60_000);

  it('does not send again a message an unanswered attempt already sent', async () => {
    const outgoing = message('sent-once');
    const first = await sendEmail(outgoing, identity.id, sent, undefined, { draftsMailboxId: drafts });
    // The answer to that send was lost: the queued entry is still marked.
    const outcome = await runQueuedSend(newQueuedSend('q1', payloadFor(outgoing), Date.now(), true), boxes);
    expect(outcome.kind).toBe('alreadySent');
    const copies = await findCopiesByMessageId(outgoing.messageId, lookup());
    expect(copies.map((c) => c.id)).toEqual([first.emailId]);
  }, 60_000);

  it('takes $draft off a copy sent without a Drafts folder only once it went out', async () => {
    const outgoing = message('no-drafts');
    // Created in Sent with $draft; onSuccessUpdateEmail takes it off.
    const result = await sendEmail(outgoing, identity.id, sent, undefined, {});
    const copies = await findCopiesByMessageId(outgoing.messageId, lookup());
    expect(copies.map((c) => c.id)).toEqual([result.emailId]);
    expect(copies[0].keywords?.$draft).toBeFalsy();
    expect(copies[0].keywords?.$seen).toBe(true);
    const outcome = await runQueuedSend(newQueuedSend('q3', { ...payloadFor(outgoing), draftsMailboxId: undefined }, Date.now(), true), boxes);
    expect(outcome.kind).toBe('alreadySent');
  }, 60_000);

  it('sends a marked message whose only copy is its draft, and removes the draft', async () => {
    const outgoing = message('draft-only');
    const draft = await saveDraftVersion(outgoing, drafts);
    const outcome = await runQueuedSend(newQueuedSend('q2', payloadFor(outgoing, draft.id), Date.now(), true), boxes);
    expect(outcome.kind).toBe('sent');
    const copies = await findCopiesByMessageId(outgoing.messageId, lookup());
    expect(copies).toHaveLength(1);
    expect(copies[0].id).not.toBe(draft.id);
    expect(copies[0].keywords?.$draft).toBeFalsy();
    const res = await singleton.request([['Email/get', { accountId: singleton.accountId, ids: [copies[0].id], properties: ['mailboxIds'] }, '0']]);
    expect(res.methodResponses[0][1].list[0].mailboxIds[sent]).toBe(true);
  }, 60_000);
});
