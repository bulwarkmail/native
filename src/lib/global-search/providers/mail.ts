import { searchAccountEmails, type UnifiedEmail } from '../../../api/unified-inbox';
import type { OpScope } from '../../../api/op-scope';
import type { Email, Mailbox } from '../../../api/types';
import { jmapClient } from '../../../api/jmap-client';
import { useEmailStore } from '../../../stores/email-store';
import { useSettingsStore } from '../../../stores/settings-store';
import { exclusionFilter, trashAndJunkIds } from '../../search-scope';
import { matchesTerms, type ParsedQuery } from '../query-parser';
import type { MailHit, RemoteSearchResult, SearchAccount, SearchProvider } from '../types';
import { abortError, isShownAndServed, searchShown, shownCacheAccount } from './shown';

// Mail searches every signed-in account (plan ruling R2): the shown one on
// its live connection, every other one through the unified inbox's detached
// read path, which talks to that account's own server with its own
// credentials. Either way each hit carries the login, the JMAP account and
// the raw id, so the same id in two accounts stays two hits.

type JmapFilter = Record<string, unknown>;

function addressFields(addresses: Email['from']): string[] {
  const out: string[] = [];
  for (const address of addresses ?? []) {
    if (address.name) out.push(address.name);
    if (address.email) out.push(address.email);
  }
  return out;
}

function emailFields(email: Email): string[] {
  return [email.subject ?? '', email.preview ?? '', ...addressFields(email.from), ...addressFields(email.to)];
}

function includesCi(haystack: string[], needle: string): boolean {
  const n = needle.toLowerCase();
  return haystack.some((h) => h.toLowerCase().includes(n));
}

/** The structured operators, applied to an already-loaded message. */
export function emailMatchesFilters(email: Email, parsed: ParsedQuery): boolean {
  const { mail } = parsed;
  if (mail.from && !includesCi(addressFields(email.from), mail.from)) return false;
  if (mail.to && !includesCi([...addressFields(email.to), ...addressFields(email.cc)], mail.to)) return false;
  if (mail.subject && !includesCi([email.subject ?? ''], mail.subject)) return false;
  if (mail.body && !includesCi([email.preview ?? ''], mail.body)) return false;
  if (mail.hasAttachment !== undefined && Boolean(email.hasAttachment) !== mail.hasAttachment) return false;
  if (mail.isUnread !== undefined && Boolean(email.keywords?.$seen) === mail.isUnread) return false;
  if (mail.isStarred !== undefined && Boolean(email.keywords?.$flagged) !== mail.isStarred) return false;
  const day = email.receivedAt?.slice(0, 10) ?? '';
  if (mail.dateAfter && day < mail.dateAfter) return false;
  if (mail.dateBefore && day > mail.dateBefore) return false;
  return true;
}

/**
 * The text and operator conditions, built like the email store's search
 * filter (`buildJmapFilter`): the words as typed (JMAP's text filter has no
 * wildcard, and Stalwart drops a trailing `*`), dates as day bounds.
 */
function queryConditions(parsed: ParsedQuery): JmapFilter[] {
  const { mail } = parsed;
  const conditions: JmapFilter[] = [];
  const text = parsed.text.trim();
  if (text) conditions.push({ text });
  if (mail.from) conditions.push({ from: mail.from });
  if (mail.to) conditions.push({ to: mail.to });
  if (mail.subject) conditions.push({ subject: mail.subject });
  if (mail.body) conditions.push({ body: mail.body });
  if (mail.dateAfter) {
    const d = new Date(mail.dateAfter);
    if (!isNaN(d.getTime())) conditions.push({ after: d.toISOString() });
  }
  if (mail.dateBefore) {
    const d = new Date(mail.dateBefore);
    if (!isNaN(d.getTime())) {
      d.setHours(23, 59, 59, 999);
      conditions.push({ before: d.toISOString() });
    }
  }
  if (mail.hasAttachment !== undefined) conditions.push({ hasAttachment: mail.hasAttachment });
  if (mail.isUnread === true) conditions.push({ notKeyword: '$seen' });
  else if (mail.isUnread === false) conditions.push({ hasKeyword: '$seen' });
  if (mail.isStarred === true) conditions.push({ hasKeyword: '$flagged' });
  else if (mail.isStarred === false) conditions.push({ notKeyword: '$flagged' });
  return conditions;
}

function allOf(conditions: JmapFilter[]): JmapFilter {
  if (conditions.length === 0) return {};
  return conditions.length === 1 ? conditions[0] : { operator: 'AND', conditions };
}

/**
 * Email/query filter for JMAP account `jmapAccountId`, whose folders are
 * `mailboxes` (each stamped with its `accountId`). The default scope is every
 * folder but Trash and Junk, like the store's "all folders" search;
 * `in:trash` / `in:junk` search that folder alone and `is:anything` lifts the
 * exclusion. An account without the role folder just searches everything.
 */
export function mailFilterFor(parsed: ParsedQuery, mailboxes: Mailbox[], jmapAccountId: string): JmapFilter {
  const conditions = queryConditions(parsed);
  if (parsed.mailboxRole) {
    const folder = mailboxes.find((m) => m.accountId === jmapAccountId && m.role === parsed.mailboxRole);
    if (folder) conditions.push({ inMailbox: folder.originalId ?? folder.id });
    return allOf(conditions);
  }
  if (!parsed.includeTrashAndJunk) {
    const exclusion = exclusionFilter(trashAndJunkIds(mailboxes, jmapAccountId));
    if (exclusion) conditions.push(exclusion);
  }
  return allOf(conditions);
}

/** Whether a cached message is in the folder scope `mailFilterFor` sends. */
function inSearchScope(email: Email, parsed: ParsedQuery, mailboxes: Mailbox[], jmapAccountId: string): boolean {
  const inRole = (role: string) => mailboxes.some((m) =>
    m.role === role && (m.accountId ?? jmapAccountId) === jmapAccountId && email.mailboxIds?.[m.id]);
  if (parsed.mailboxRole) return inRole(parsed.mailboxRole);
  if (parsed.includeTrashAndJunk) return true;
  return !inRole('trash') && !inRole('junk');
}

function folderOf(email: Email, mailboxes: Mailbox[]): string {
  return mailboxes.find((m) => email.mailboxIds?.[m.id])?.name ?? '';
}

function toHit(
  email: Email,
  account: SearchAccount,
  jmapAccountId: string,
  folder: string,
  source: 'local' | 'remote',
): MailHit {
  return {
    kind: 'mail',
    serverUrl: account.serverUrl,
    appAccountId: account.appAccountId,
    jmapAccountId,
    id: email.id,
    accountLabel: account.label,
    title: email.subject ?? '',
    subtitle: folder,
    date: email.receivedAt || null,
    source,
    email: { ...email, jmapAccountId },
    snippet: null,
  };
}

function remoteHits(emails: UnifiedEmail[], account: SearchAccount): MailHit[] {
  return emails.map((email) => toHit(email, account, email.jmapAccountId, email.sourceFolder ?? '', 'remote'));
}

async function searchAccount(
  parsed: ParsedQuery,
  account: SearchAccount,
  limit: number,
  position: number,
  at?: OpScope,
): Promise<RemoteSearchResult> {
  const includeGroup = useSettingsStore.getState().includeGroupInUnified ?? true;
  const result = await searchAccountEmails(account.appAccountId, {
    filter: (mailboxes, jmapAccountId) => mailFilterFor(parsed, mailboxes, jmapAccountId),
    limit,
    position,
    includeGroup,
    at,
  });
  return { hits: remoteHits(result.emails, account), hasMore: result.hasMore };
}

export const mailProvider: SearchProvider = {
  kind: 'mail',

  supports: () => true,

  local: (parsed, accounts, limit) => {
    const account = shownCacheAccount(accounts);
    if (!account) return [];
    const { emails, mailboxes } = useEmailStore.getState();
    const ownJmapId = jmapClient.accountId;
    const hits: MailHit[] = [];
    for (const email of emails) {
      if (!matchesTerms(parsed.terms, emailFields(email))) continue;
      if (!emailMatchesFilters(email, parsed)) continue;
      const folder = mailboxes.find((m) => email.mailboxIds?.[m.id]);
      const jmapAccountId = email.jmapAccountId ?? folder?.accountId ?? ownJmapId;
      if (!inSearchScope(email, parsed, mailboxes, jmapAccountId)) continue;
      hits.push(toHit(email, account, jmapAccountId, folderOf(email, mailboxes), 'local'));
      if (hits.length >= limit) break;
    }
    return hits;
  },

  remote: async (parsed, account, { limit, position = 0, signal }) => {
    // The shown account, while the client serves it, on its live scope;
    // otherwise (another account, or the shown one before the client has
    // switched to it) detached, on that account's own server.
    if (isShownAndServed(account.appAccountId)) {
      return searchShown(account, signal, (at) => searchAccount(parsed, account, limit, position, at));
    }
    const result = await searchAccount(parsed, account, limit, position);
    // A newer search superseded this one: its results are not shown.
    if (signal.aborted) throw abortError();
    return result;
  },
};
