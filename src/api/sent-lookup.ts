// Lookups the send queue uses to find out whether a send with an unknown
// outcome reached the server, before it is ever sent again. Every call takes
// the account explicitly; nothing defaults to the client's primary account.

import { jmapClient } from './jmap-client';
import { requireMethodResult } from './jmap-result';
import { CAPABILITIES } from './types';

/** Messages the lookup reads; more matches of the time filter make the result incomplete. */
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
 * Messages anywhere in the account received after `since` whose Message-ID is
 * `messageId`. The JMAP `header` filter is not used (Stalwart 0.16 does not
 * match it): the account is queried by time, newest first, up to
 * {@link COPY_LOOKUP_LIMIT}, with `calculateTotal`, and Message-IDs are
 * compared here. `complete` is false when the server holds more matches of
 * the time filter than were read. Throws when the request or a method fails.
 */
export async function findCopiesByMessageId(
  messageId: string,
  { accountId, since }: { accountId: string; since: string },
): Promise<CopyLookup> {
  const res = await jmapClient.request([
    ['Email/query', {
      accountId,
      filter: { after: since },
      sort: [{ property: 'receivedAt', isAscending: false }],
      limit: COPY_LOOKUP_LIMIT,
      calculateTotal: true,
    }, 'q'],
    ['Email/get', {
      accountId,
      '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
      properties: ['id', 'messageId', 'keywords', 'mailboxIds'],
    }, 'g'],
  ]);
  const query = requireMethodResult(res, 'q', 'Email/query');
  const ids = (query.ids as string[] | undefined) ?? [];
  const list = (requireMethodResult(res, 'g', 'Email/get').list as Array<Record<string, unknown>> | undefined) ?? [];
  // Without a total, only a short page proves nothing was left out.
  const complete = typeof query.total === 'number' ? query.total <= ids.length : ids.length < COPY_LOOKUP_LIMIT;

  const seen = new Set<string>();
  const copies: EmailCopy[] = [];
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

/**
 * The EmailSubmissions the server holds for these messages, kept only when
 * their `emailId` is one asked for (the filter result is not trusted alone).
 * Throws on any failure.
 */
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
  const wanted = new Set(emailIds);
  return list.filter((s) => s && typeof s.emailId === 'string' && wanted.has(s.emailId));
}
