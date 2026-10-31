import type { CalendarEvent, ContactCard, Email, EmailAddress, FileNode } from '../../api/types';
import { textConditions } from '../search-utils';
import type { MailFilters, ParsedQuery } from './query-parser';

// What each kind of item is searched by, and the server filters a parsed
// query turns into (webmail lib/global-search/providers/*.ts and
// buildJMAPFilter in lib/jmap/search-utils.ts).

type JmapFilter = Record<string, unknown>;

/** AND of two filters, flattening an AND on the left. */
export function andFilters(base: JmapFilter, extra: JmapFilter | null): JmapFilter {
  if (!extra || Object.keys(extra).length === 0) return base;
  if (Object.keys(base).length === 0) return extra;
  if (base.operator === 'AND' && Array.isArray(base.conditions)) {
    return { operator: 'AND', conditions: [...(base.conditions as JmapFilter[]), extra] };
  }
  return { operator: 'AND', conditions: [base, extra] };
}

/** The Email/query filter for free text and the mail operators (webmail buildJMAPFilter). */
export function buildMailFilter(text: string, filters: MailFilters): JmapFilter {
  const conditions: JmapFilter[] = [];
  if (text.trim()) conditions.push(...textConditions(text));
  if (filters.from) conditions.push(...textConditions(filters.from, 'from'));
  if (filters.to) conditions.push(...textConditions(filters.to, 'to'));
  if (filters.subject) conditions.push(...textConditions(filters.subject, 'subject'));
  if (filters.body) conditions.push(...textConditions(filters.body, 'body'));
  if (filters.hasAttachment !== null) conditions.push({ hasAttachment: filters.hasAttachment });
  if (filters.dateAfter) {
    const date = new Date(filters.dateAfter);
    if (!Number.isNaN(date.getTime())) conditions.push({ after: date.toISOString() });
  }
  if (filters.dateBefore) {
    const end = new Date(filters.dateBefore);
    if (!Number.isNaN(end.getTime())) {
      end.setHours(23, 59, 59, 999);
      conditions.push({ before: end.toISOString() });
    }
  }
  if (filters.isUnread === true) conditions.push({ notKeyword: '$seen' });
  else if (filters.isUnread === false) conditions.push({ hasKeyword: '$seen' });
  if (filters.isStarred === true) conditions.push({ hasKeyword: '$flagged' });
  else if (filters.isStarred === false) conditions.push({ notKeyword: '$flagged' });
  if (conditions.length === 0) return {};
  if (conditions.length === 1) return conditions[0];
  return { operator: 'AND', conditions };
}

/** The folders of one mail account the filter needs: id and role. */
export interface MailboxRef {
  id: string;
  role?: string | null;
  name: string;
}

function findRole(mailboxes: MailboxRef[], role: 'trash' | 'junk'): MailboxRef | undefined {
  return mailboxes.find((m) => m.role === role || (role === 'junk' && m.role === 'spam'));
}

/**
 * The default scope is everything but Trash and Junk; `in:trash` and
 * `in:junk` search that folder alone and `is:anything` lifts the exclusion
 * (webmail mailFilterFor). Without those folders, everything.
 */
export function mailFilterFor(parsed: ParsedQuery, mailboxes: MailboxRef[]): JmapFilter {
  const base = buildMailFilter(parsed.text, parsed.mail);
  if (parsed.mailboxRole) {
    const mailbox = findRole(mailboxes, parsed.mailboxRole);
    return mailbox ? andFilters(base, { inMailbox: mailbox.id }) : base;
  }
  if (parsed.includeTrashAndJunk) return base;
  const excluded = (['trash', 'junk'] as const).map((role) => findRole(mailboxes, role)?.id).filter((id): id is string => !!id);
  return excluded.length > 0 ? andFilters(base, { inMailboxOtherThan: excluded }) : base;
}

/**
 * `after:`/`before:` are calendar days, compared against instants. Several
 * text parts go out as an AND of single-key conditions: 1.0 takes one AND
 * group when it expands recurrences (webmail calendarFilterFor).
 */
export function calendarFilterFor(parsed: ParsedQuery): JmapFilter {
  const after = parsed.after ? `${parsed.after}T00:00:00Z` : undefined;
  const before = parsed.before ? `${parsed.before}T23:59:59Z` : undefined;
  const texts = textConditions(parsed.text).map(({ text }): JmapFilter => ({ text }));
  if (texts.length === 1) {
    const filter = texts[0];
    if (after) filter.after = after;
    if (before) filter.before = before;
    return filter;
  }
  const bounds: JmapFilter[] = [];
  if (after) bounds.push({ after });
  if (before) bounds.push({ before });
  return { operator: 'AND', conditions: [...bounds, ...texts] };
}

function addressFields(addresses: EmailAddress[] | null | undefined): string[] {
  const out: string[] = [];
  for (const address of addresses ?? []) {
    if (address.name) out.push(address.name);
    if (address.email) out.push(address.email);
  }
  return out;
}

/** The text a loaded message is found by. */
export function emailFields(email: Email): string[] {
  return [email.subject ?? '', email.preview ?? '', ...addressFields(email.from), ...addressFields(email.to)];
}

function includesCi(haystack: string[], needle: string): boolean {
  const n = needle.toLowerCase();
  return haystack.some((h) => h.toLowerCase().includes(n));
}

/** The mail operators, applied to a loaded message. */
export function emailMatchesFilters(email: Email, parsed: ParsedQuery): boolean {
  const { mail } = parsed;
  if (mail.from && !includesCi(addressFields(email.from), mail.from)) return false;
  if (mail.to && !includesCi([...addressFields(email.to), ...addressFields(email.cc)], mail.to)) return false;
  if (mail.subject && !includesCi([email.subject ?? ''], mail.subject)) return false;
  if (mail.hasAttachment !== null && Boolean(email.hasAttachment) !== mail.hasAttachment) return false;
  if (mail.isUnread !== null && Boolean(email.keywords?.$seen) === mail.isUnread) return false;
  if (mail.isStarred !== null && Boolean(email.keywords?.$flagged) !== mail.isStarred) return false;
  const day = email.receivedAt?.slice(0, 10) ?? '';
  if (mail.dateAfter && day < mail.dateAfter) return false;
  if (mail.dateBefore && day > mail.dateBefore) return false;
  return true;
}

/** The text a contact is found by: name, addresses, organisations, phones, nicknames. */
export function contactFields(contact: ContactCard, displayName: string): string[] {
  const fields: string[] = [displayName];
  for (const email of Object.values(contact.emails ?? {})) if (email?.address) fields.push(email.address);
  for (const org of Object.values(contact.organizations ?? {})) {
    const name = (org as { name?: string }).name;
    if (name) fields.push(name);
  }
  for (const phone of Object.values(contact.phones ?? {})) {
    const number = (phone as { number?: string }).number;
    if (number) fields.push(number);
  }
  for (const nick of Object.values(contact.nicknames ?? {})) {
    const name = (nick as { name?: string }).name;
    if (name) fields.push(name);
  }
  return fields;
}

/** The text an event is found by: title, description, places and participants. */
export function eventFields(event: CalendarEvent): string[] {
  const fields: string[] = [event.title ?? '', event.description ?? ''];
  for (const location of Object.values(event.locations ?? {})) if (location?.name) fields.push(location.name);
  for (const participant of Object.values(event.participants ?? {})) {
    const p = participant as { name?: string | null; email?: string | null };
    if (p.name) fields.push(p.name);
    if (p.email) fields.push(p.email);
  }
  return fields;
}

export function isRecurringEvent(event: Pick<CalendarEvent, 'recurrenceId' | 'recurrenceRules'>): boolean {
  return Boolean(event.recurrenceId) || (Array.isArray(event.recurrenceRules) && event.recurrenceRules.length > 0);
}

/** The folder path a file node lives in (`/` for the root). */
export function pathOfNode(nodes: FileNode[], node: FileNode): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const segments: string[] = [];
  const seen = new Set<string>();
  let parentId = node.parentId;
  while (parentId != null && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    segments.unshift(parent.name);
    parentId = parent.parentId;
  }
  return `/${segments.join('/')}`;
}
