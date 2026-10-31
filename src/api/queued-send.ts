// Sending a message from the offline send queue (see lib/send-queue.ts for
// the state machine and the rule against sending twice).

import { jmapClient } from './jmap-client';
import { destroyEmails, sendEmail, type SendEmailResult } from './email';
import { requireMethodResult } from './jmap-result';
import type { Mailbox } from './types';
import { sendTargetFor } from '../lib/compose-send-account';
import { supportsSubmissionExtension } from '../lib/submission-options';
import { stripMessageIdBrackets } from '../lib/email-threading';
import { holdForScheduled, verdictFromCopies, type FoundCopy, type QueuedSend } from '../lib/send-queue';

/** How far before the queueing a copy can be dated (the server's clock may differ). */
const CLOCK_SKEW_MS = 10 * 60_000;
/** Messages filed in Sent and Drafts since the queueing that are compared. */
const LOOKUP_LIMIT = 200;

/**
 * The messages in the given folders of `accountId` whose Message-ID is
 * `messageId`, filed since `since` (ms). Not a header search: Stalwart
 * answers `{ header: ['Message-ID', …] }` from its full-text index, which
 * lags behind (0.16.27 and 1.0.1 found nothing seconds after the send), so
 * the folders' recent messages are read and compared instead.
 */
export async function findCopiesByMessageId(
  messageId: string,
  opts: { accountId?: string; mailboxIds: string[]; since: number },
): Promise<FoundCopy[]> {
  const id = stripMessageIdBrackets(messageId);
  const mailboxIds = opts.mailboxIds.filter(Boolean);
  if (!id || mailboxIds.length === 0) return [];
  const account = opts.accountId ?? jmapClient.accountId;
  const inFolders = mailboxIds.length === 1
    ? { inMailbox: mailboxIds[0] }
    : { operator: 'OR', conditions: mailboxIds.map((m) => ({ inMailbox: m })) };
  const filter = {
    operator: 'AND',
    conditions: [{ after: new Date(opts.since - CLOCK_SKEW_MS).toISOString() }, inFolders],
  };
  const res = await jmapClient.request([
    ['Email/query', {
      accountId: account, filter, sort: [{ property: 'receivedAt', isAscending: false }], limit: LOOKUP_LIMIT,
    }, '0'],
    ['Email/get', {
      accountId: account,
      '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' },
      properties: ['id', 'keywords', 'messageId'],
    }, '1'],
  ]);
  requireMethodResult(res, '0', 'Email/query');
  const list = (requireMethodResult(res, '1', 'Email/get').list ?? []) as Array<{
    id: string; keywords?: Record<string, boolean>; messageId?: string[] | null;
  }>;
  return list
    .filter((e) => (e.messageId ?? []).some((m) => stripMessageIdBrackets(m) === id))
    .map((e) => ({ id: e.id, keywords: e.keywords ?? {} }));
}

export type QueuedSendOutcome =
  | { kind: 'sent'; result: SendEmailResult; accountId?: string }
  /** An earlier attempt went out; nothing was sent now. */
  | { kind: 'alreadySent'; accountId?: string };

/**
 * Send a queued message. The account, identity and folders are worked out
 * as the composer does (sendTargetFor, #1090). A message an earlier attempt
 * may have sent is looked up first, and is not sent again when a copy of it
 * went out; copies a refused attempt left in Drafts are removed before the
 * new attempt.
 */
export async function runQueuedSend(send: QueuedSend, mailboxes: Mailbox[], now = Date.now()): Promise<QueuedSendOutcome> {
  const p = send.payload;
  const target = await sendTargetFor(p.identity, p.fromEmail, mailboxes);
  const accountId = target.accountId ?? jmapClient.accountId;
  const draftAccountId = p.draftAccountId ?? jmapClient.accountId;

  const sentMailboxId = target.sentMailboxId ?? p.sentMailboxId;
  const draftsMailboxId = target.accountId ? target.draftsMailboxId : p.draftsMailboxId;

  if (send.maybeSent && p.outgoing.messageId) {
    const copies = await findCopiesByMessageId(p.outgoing.messageId, {
      accountId: target.accountId,
      mailboxIds: [sentMailboxId, draftsMailboxId ?? ''],
      since: send.createdAt,
    });
    // The autosaved draft lives in this account only when the draft did.
    const draftHere = p.draftId && draftAccountId === accountId ? p.draftId : undefined;
    const verdict = verdictFromCopies(copies, draftHere);
    if (verdict.kind === 'sent') {
      // The send went out but its answer was lost, so the old draft it would
      // have removed is still there.
      if (p.draftId && p.draftId !== verdict.copyId) {
        await destroyEmails([p.draftId], draftAccountId).catch((err) => {
          console.warn('[send-queue] could not remove the draft of a sent message', err);
        });
      }
      return { kind: 'alreadySent', accountId: target.accountId };
    }
    if (verdict.staleIds.length > 0) {
      await destroyEmails(verdict.staleIds, accountId);
    }
  }

  const result = await sendEmail(
    p.outgoing,
    target.identityId,
    sentMailboxId,
    holdForScheduled(p.scheduledAt, now),
    {
      draftsMailboxId,
      draftId: p.draftId,
      draftAccountId: p.draftId ? p.draftAccountId : undefined,
      accountId: target.accountId,
      // Only what the submitting account offers, as the composer does.
      requestDsn: !!p.requestDsn && supportsSubmissionExtension('DSN', target.accountId),
      requireTls: !!p.requireTls && supportsSubmissionExtension('REQUIRETLS', target.accountId),
    },
  );
  return { kind: 'sent', result, accountId: target.accountId };
}
