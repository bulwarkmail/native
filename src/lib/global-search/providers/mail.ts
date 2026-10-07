import { searchAccountEmails, type UnifiedEmail } from '../../../api/unified-inbox';
import type { OpScope } from '../../../api/op-scope';
import type { Email, Mailbox } from '../../../api/types';
import { jmapClient } from '../../../api/jmap-client';
import { accountIdOfRow, useEmailStore } from '../../../stores/email-store';
import { isStaleLoad } from '../../network-error';
import { buildJmapFilter } from '../../search-utils';
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
 * The text and operator conditions: the email store's own search filter
 * (`buildJmapFilter`), whose fields the operators map onto one to one, as
 * a list so folder conditions can be ANDed in.
 */
function queryConditions(parsed: ParsedQuery): JmapFilter[] {
  const base = buildJmapFilter(parsed.text, parsed.mail);
  if (!base) return [];
  return base.operator === 'AND' && Array.isArray(base.conditions) ? [...(base.conditions as JmapFilter[])] : [base];
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

/**
 * The store folder of JMAP account `jmapAccountId` a cached row sits in. Row
 * `mailboxIds` are raw server ids, while the store namespaces a shared
 * account's folders (`${owner}:${raw}`, raw in `originalId`), and raw ids
 * repeat across accounts: a folder is matched by its account and raw id.
 */
function rowFolders(email: Email, mailboxes: Mailbox[], jmapAccountId: string): Mailbox[] {
  return mailboxes.filter((m) => m.accountId === jmapAccountId && email.mailboxIds?.[m.originalId ?? m.id]);
}

/** Whether a cached message is in the folder scope `mailFilterFor` sends. */
function inSearchScope(parsed: ParsedQuery, folders: Mailbox[]): boolean {
  const inRole = (role: string) => folders.some((m) => m.role === role);
  if (parsed.mailboxRole) return inRole(parsed.mailboxRole);
  if (parsed.includeTrashAndJunk) return true;
  return !inRole('trash') && !inRole('junk');
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
      // The row's account the way the store resolves it: its stamp in a
      // list spanning accounts, else the folder on screen.
      const jmapAccountId = accountIdOfRow(email) ?? ownJmapId;
      const folders = rowFolders(email, mailboxes, jmapAccountId);
      if (!inSearchScope(parsed, folders)) continue;
      hits.push(toHit(email, account, jmapAccountId, folders[0]?.name ?? '', 'local'));
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
    let result: RemoteSearchResult;
    try {
      result = await searchAccount(parsed, account, limit, position);
    } catch (err) {
      if (signal.aborted) throw abortError();
      // The live client served this account and moved on mid-read: the
      // retry finds it no longer live and reads it detached.
      if (!isStaleLoad(err)) throw err;
      result = await searchAccount(parsed, account, limit, position);
    }
    // A newer search superseded this one: its results are not shown.
    if (signal.aborted) throw abortError();
    return result;
  },
};
