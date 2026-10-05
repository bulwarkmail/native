// Lookups the send queue uses to find out whether a send with an unknown
// outcome reached the server, before it is ever sent again. Every call takes
// the account explicitly; nothing defaults to the client's primary account.

import { jmapClient } from './jmap-client';
import { destroyEmails } from './email';
import { requireMethodResult } from './jmap-result';
import { CAPABILITIES } from './types';

/** Copies per mailbox the lookup reads; a full page makes the result incomplete. */
export const COPY_LOOKUP_LIMIT = 200;

/** Message-ID values longer than this are never compared (RFC 5322 line limit). */
const MAX_MESSAGE_ID_LENGTH = 998;

export interface EmailCopy {
  id: string;
  messageId: string[];
  keywords: Record<string, boolean>;
  mailboxIds: Record<string, boolean>;
}

export interface CopyLookup {
  copies: EmailCopy[];
  /** False when a mailbox had more recent mail than was read: a copy may have been missed. */
  complete: boolean;
}

/** `<id>` -> `id`, linear; null for a value too long to be a Message-ID. */
function bareMessageId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_MESSAGE_ID_LENGTH + 2) return null;
  let s = value.trim();
  if (s.startsWith('<')) s = s.slice(1);
  if (s.endsWith('>')) s = s.slice(0, -1);
  return s.trim();
}

/** True when one of the copy's Message-ID values equals `target` exactly. */
export function hasMessageId(copy: { messageId?: unknown }, target: string): boolean {
  const wanted = bareMessageId(target);
  if (!wanted || !Array.isArray(copy.messageId)) return false;
  return copy.messageId.some((v) => bareMessageId(v) === wanted);
}

/**
 * Messages in `mailboxIds` received after `since` whose Message-ID is
 * `messageId`. The JMAP `header` filter is not used (Stalwart 0.16 does not
 * match it): each mailbox is queried by time, newest first, up to
 * {@link COPY_LOOKUP_LIMIT}, and Message-IDs are compared here. Throws when
 * the request or any method fails.
 */
export async function findCopiesByMessageId(
  messageId: string,
  { accountId, mailboxIds, since }: { accountId: string; mailboxIds: string[]; since: string },
): Promise<CopyLookup> {
  if (mailboxIds.length === 0) return { copies: [], complete: true };
  const calls: Array<[string, Record<string, unknown>, string]> = [];
  mailboxIds.forEach((mailboxId, i) => {
    calls.push(['Email/query', {
      accountId,
      filter: { inMailbox: mailboxId, after: since },
      sort: [{ property: 'receivedAt', isAscending: false }],
      limit: COPY_LOOKUP_LIMIT,
    }, `q${i}`]);
    calls.push(['Email/get', {
      accountId,
      '#ids': { resultOf: `q${i}`, name: 'Email/query', path: '/ids' },
      properties: ['id', 'messageId', 'keywords', 'mailboxIds'],
    }, `g${i}`]);
  });
  const res = await jmapClient.request(calls);

  let complete = true;
  const seen = new Set<string>();
  const copies: EmailCopy[] = [];
  mailboxIds.forEach((_, i) => {
    const ids = (requireMethodResult(res, `q${i}`, 'Email/query').ids as string[] | undefined) ?? [];
    const list = (requireMethodResult(res, `g${i}`, 'Email/get').list as Array<Record<string, unknown>> | undefined) ?? [];
    if (ids.length >= COPY_LOOKUP_LIMIT) complete = false;
    for (const record of list) {
      const id = record.id;
      if (typeof id !== 'string' || seen.has(id) || !hasMessageId(record, messageId)) continue;
      seen.add(id);
      copies.push({
        id,
        messageId: record.messageId as string[],
        keywords: (record.keywords as Record<string, boolean> | null) ?? {},
        mailboxIds: (record.mailboxIds as Record<string, boolean> | null) ?? {},
      });
    }
  });
  return { copies, complete };
}

/** The account's Sent and Drafts mailboxes by role (raw ids, as the server knows them). */
export async function resolveSendMailboxes(accountId: string): Promise<{ sentId?: string; draftsId?: string }> {
  const res = await jmapClient.request([['Mailbox/get', { accountId, properties: ['id', 'role'] }, '0']]);
  const list = (requireMethodResult(res, '0', 'Mailbox/get').list as Array<{ id: string; role?: string | null }> | undefined) ?? [];
  return {
    sentId: list.find((m) => m.role === 'sent')?.id,
    draftsId: list.find((m) => m.role === 'drafts')?.id,
  };
}

export interface SubmissionRef {
  id: string;
  emailId: string;
  undoStatus?: string;
}

/** The EmailSubmissions the server holds for these messages. Throws on any failure. */
export async function findSubmissionsForEmails(emailIds: string[], accountId: string): Promise<SubmissionRef[]> {
  if (emailIds.length === 0) return [];
  const res = await jmapClient.request(
    [
      ['EmailSubmission/query', { accountId, filter: { emailIds } }, '0'],
      ['EmailSubmission/get', {
        accountId,
        '#ids': { resultOf: '0', name: 'EmailSubmission/query', path: '/ids' },
        properties: ['id', 'emailId', 'undoStatus'],
      }, '1'],
    ],
    [CAPABILITIES.CORE, CAPABILITIES.MAIL, CAPABILITIES.SUBMISSION],
  );
  requireMethodResult(res, '0', 'EmailSubmission/query');
  const list = (requireMethodResult(res, '1', 'EmailSubmission/get').list as SubmissionRef[] | undefined) ?? [];
  return list;
}

/**
 * Destroy the copies that are drafts of this very message: only those whose
 * Message-ID matches and that carry `$draft`. Anything else passed in is left
 * alone.
 */
export async function destroyDraftCopies(copies: EmailCopy[], messageId: string, accountId: string): Promise<void> {
  const ids = copies
    .filter((c) => c.keywords?.$draft === true && hasMessageId(c, messageId))
    .map((c) => c.id);
  if (ids.length === 0) return;
  await destroyEmails(ids, accountId);
}
