// Lookups the send queue uses to find out whether a send with an unknown
// outcome reached the server, before it is ever sent again. Every call takes
// the account explicitly; nothing defaults to the client's primary account.

import { jmapClient } from './jmap-client';
import { requireMethodResult } from './jmap-result';
import { CAPABILITIES } from './types';

/** Messages per lookup page. */
export const COPY_LOOKUP_PAGE = 200;
/** Messages the lookup reads at most (10 pages) before giving up without proof. */
export const COPY_LOOKUP_MAX = 2000;
/** Requests at most, for a server that pages in tiny steps. */
const COPY_LOOKUP_MAX_REQUESTS = 40;
const COPY_PROPERTIES = ['id', 'messageId', 'from', 'keywords', 'mailboxIds'];

/** Message-ID values longer than this are never compared (RFC 5322 line limit). */
const MAX_MESSAGE_ID_LENGTH = 998;

export interface EmailCopy {
  id: string;
  messageId: string[];
  /** Header From addresses. */
  from: Array<{ email?: string; name?: string | null }>;
  keywords: Record<string, boolean>;
  mailboxIds: Record<string, boolean>;
}

export interface CopyLookup {
  copies: EmailCopy[];
  /** False when the lookup gave up at its cap without proof: a copy may have been missed. */
  complete: boolean;
  /** True when `isProof` accepted a page's matches. */
  proven: boolean;
}

/** `<id>` -> `id`, linear; null for a value too long to be a Message-ID. */
function bareMessageId(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_MESSAGE_ID_LENGTH + 2) return null;
  let s = value.trim();
  if (s.startsWith('<')) s = s.slice(1);
  if (s.endsWith('>')) s = s.slice(0, -1);
  return s.trim();
}

function toCopy(id: string, record: Record<string, unknown>): EmailCopy {
  return {
    id,
    messageId: record.messageId as string[],
    from: Array.isArray(record.from) ? (record.from as EmailCopy['from']) : [],
    keywords: (record.keywords as Record<string, boolean> | null) ?? {},
    mailboxIds: (record.mailboxIds as Record<string, boolean> | null) ?? {},
  };
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
 * match it): the account is paged newest first by `receivedAt` and
 * Message-IDs are compared here, page by page. Each page's new matches go to
 * `isProof`; paging stops once it says yes (`proven`), at the end of the
 * window (an empty page, or `total` reached), or after
 * {@link COPY_LOOKUP_MAX} messages (`complete: false`). A match that is not
 * proof (an echo, a forgery) never stops it. Throws when a request or method
 * fails.
 */
export async function findCopiesByMessageId(
  messageId: string,
  { accountId, since, isProof }: {
    accountId: string;
    since: string;
    isProof?: (matches: EmailCopy[]) => Promise<boolean>;
  },
): Promise<CopyLookup> {
  const seen = new Set<string>();
  const copies: EmailCopy[] = [];
  let position = 0;
  for (let request = 0; request < COPY_LOOKUP_MAX_REQUESTS && position < COPY_LOOKUP_MAX; request++) {
    const res = await jmapClient.request([
      ['Email/query', {
        accountId,
        filter: { after: since },
        sort: [{ property: 'receivedAt', isAscending: false }],
        position,
        limit: Math.min(COPY_LOOKUP_PAGE, COPY_LOOKUP_MAX - position),
        calculateTotal: true,
      }, 'q'],
      ['Email/get', {
        accountId,
        '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' },
        properties: COPY_PROPERTIES,
      }, 'g'],
    ]);
    const query = requireMethodResult(res, 'q', 'Email/query');
    const ids = (query.ids as string[] | undefined) ?? [];
    const list = (requireMethodResult(res, 'g', 'Email/get').list as Array<Record<string, unknown>> | undefined) ?? [];
    const matches: EmailCopy[] = [];
    for (const record of list) {
      const id = record.id;
      // A message arriving between pages shifts the window: dedupe by id.
      if (typeof id !== 'string' || seen.has(id) || !hasMessageId(record, messageId)) continue;
      seen.add(id);
      matches.push(toCopy(id, record));
    }
    copies.push(...matches);
    if (matches.length && isProof && (await isProof(matches))) return { copies, complete: true, proven: true };
    // A server may return fewer than asked for: only an empty page or the
    // total marks the end of the window.
    if (ids.length === 0) return { copies, complete: true, proven: false };
    position += ids.length;
    if (typeof query.total === 'number' && position >= query.total) return { copies, complete: true, proven: false };
  }
  return { copies, complete: false, proven: false };
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
  identityId?: string;
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
        properties: ['id', 'emailId', 'identityId', 'undoStatus'],
      }, '1'],
    ],
    [CAPABILITIES.CORE, CAPABILITIES.MAIL, CAPABILITIES.SUBMISSION],
  );
  requireMethodResult(res, '0', 'EmailSubmission/query');
  const list = (requireMethodResult(res, '1', 'EmailSubmission/get').list as SubmissionRef[] | undefined) ?? [];
  const wanted = new Set(emailIds);
  return list.filter((s) => s && typeof s.emailId === 'string' && wanted.has(s.emailId));
}
