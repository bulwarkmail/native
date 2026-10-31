/**
 * "Recover deleted items" (webmail lib/recovery/archived-items.ts, #1319):
 * messages Stalwart keeps after they were deleted for good (an emptied
 * Trash, an expunge, Trash cleaned up after its retention). Stalwart
 * Enterprise only, and only when the admin sets `archiveDeletedItemsFor`
 * (DataRetention). Pure functions; src/api/archived-items.ts sends what they
 * build.
 *
 * - x:ArchivedItem/query, /get, /set: a user without the Impersonate
 *   permission only ever sees the items of the account the call names and
 *   is refused an `accountId` filter (`unsupportedFilter`). An admin's query
 *   covers every account unless it names one in the filter. So the query
 *   sends the filter, falls back to none on `unsupportedFilter`, and the
 *   client keeps only items whose `accountId` is the account it asked for.
 * - Query order and paging: the default sort is by id, descending (newest
 *   first). Without `calculateTotal` Stalwart scans ascending, cut at
 *   `limit` or 5000, and only then reverses, so the newest items past 5000
 *   are never seen and `position` is applied twice. With `calculateTotal:
 *   true` it pages correctly, so every page asks for the total.
 * - The object: `ArchivedItem`, tagged by `@type` (Email, FileNode,
 *   CalendarEvent, ContactCard, SieveScript; all count in the query), and
 *   `ArchivedEmail` (from, subject, receivedAt, size, accountId, archivedAt,
 *   archivedUntil, blobId). No folder is kept. `from` is "Name <address>",
 *   the address or the name.
 * - Restoring: x:ArchivedItem/set update `{ status: "requestRestore" }`
 *   removes the item at once and schedules a task that puts the message
 *   back in the Inbox, unread and without keywords. If that task fails the
 *   message is lost and the client can't tell. Only emails are restored.
 * - Without a license every call answers `forbidden`.
 */

import { jmapErrorType } from '../../api/jmap-result';

export const STALWART_CAPABILITY = 'urn:stalwart:jmap';
export const ARCHIVED_ITEM_USING = ['urn:ietf:params:jmap:core', STALWART_CAPABILITY];

/** Ids per query page. */
export const ARCHIVE_PAGE_SIZE = 500;
/** Items looked at before the list stops and offers "Show older". */
export const ARCHIVE_LIST_CAP = 2000;
/** Items the Trash link looks at, at most, before giving up. */
export const ARCHIVE_PEEK_LIMIT = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One deleted message the server still keeps. */
export interface ArchivedEmail {
  id: string;
  /** Sender as the server stored it: a name, an address, or both. */
  fromName: string;
  fromEmail: string;
  subject: string;
  /** The message's date, ISO. Null when the server had none. */
  receivedAt: string | null;
  /** When it was deleted for good, ISO. */
  archivedAt: string;
  /** Until when the server keeps it, ISO. */
  archivedUntil: string | null;
  size: number;
  accountId: string;
}

export interface RestoreResult {
  id: string;
  ok: boolean;
  /** The server's reason when it refused this one, or the error of the whole call. */
  error?: string;
  /** The JMAP error type, when there was one (`notFound`, `forbidden`). */
  type?: string;
}

export interface ArchiveQueryPage {
  ids: string[];
  total: number | null;
}

/** What the paging needs: one query page, and the raw items of some ids. */
export interface ArchiveIo {
  query: (position: number, limit: number) => Promise<ArchiveQueryPage>;
  get: (ids: string[]) => Promise<unknown[]>;
}

export interface ArchiveListResult {
  items: ArchivedEmail[];
  /** Where "Show older" goes on; null when there is nothing older to look at. */
  nextPosition: number | null;
}

export type ArchiveCall = [string, Record<string, unknown>, string];

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

/** "Name <address>", "address" or "Name", as the server builds it. */
export function parseArchivedFrom(from: string): { name: string; email: string } {
  const value = from.trim();
  const angle = /^(.*?)\s*<([^<>\s]+)>$/.exec(value);
  if (angle) return { name: angle[1].replace(/^"(.*)"$/, '$1').trim(), email: angle[2] };
  if (/^[^\s@]+@[^\s@]+$/.test(value)) return { name: '', email: value };
  return { name: value, email: '' };
}

function asRecord(raw: unknown): Record<string, unknown> | null {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/**
 * The deleted messages of `accountId` in an x:ArchivedItem/get list. Other
 * kinds (files, events, contacts, scripts) are left out: the server can't
 * restore them. So is every item of another account, and every item that
 * doesn't say whose it is.
 */
export function parseArchivedItems(list: unknown, accountId: string): ArchivedEmail[] {
  if (!Array.isArray(list)) return [];
  const out: ArchivedEmail[] = [];
  for (const raw of list) {
    const item = asRecord(raw);
    if (!item || item['@type'] !== 'Email') continue;
    const id = str(item.id);
    const archivedAt = isoOrNull(item.archivedAt);
    if (!id || !archivedAt) continue;
    if (str(item.accountId) !== accountId) continue;
    const from = parseArchivedFrom(str(item.from));
    out.push({
      id,
      fromName: from.name,
      fromEmail: from.email,
      subject: str(item.subject),
      receivedAt: isoOrNull(item.receivedAt),
      archivedAt,
      archivedUntil: isoOrNull(item.archivedUntil),
      size: typeof item.size === 'number' && Number.isFinite(item.size) ? item.size : 0,
      accountId,
    });
  }
  return out;
}

/** The start of the days window, or -Infinity for 0 (everything the server keeps). */
export function daysCutoff(days: number, now: number): number {
  return days > 0 ? now - days * DAY_MS : -Infinity;
}

/** Whether an item is shown: deleted inside the window and still kept by the server. */
function inWindow(item: ArchivedEmail, cutoff: number, now: number): boolean {
  if (Date.parse(item.archivedAt) < cutoff) return false;
  return !item.archivedUntil || Date.parse(item.archivedUntil) > now;
}

/**
 * What the user sees: items deleted within the last `days` (0 = all the
 * server keeps), without those the server no longer keeps, newest first.
 */
export function visibleArchivedItems(items: ArchivedEmail[], days: number, now: number = Date.now()): ArchivedEmail[] {
  const cutoff = daysCutoff(days, now);
  return items
    .filter((item) => inWindow(item, cutoff, now))
    .sort((a, b) => Date.parse(b.archivedAt) - Date.parse(a.archivedAt) || (a.id < b.id ? 1 : -1));
}

/** Every raw item of a page is older than the window (of any kind; a page with an undated item isn't). */
function wholePageOlder(raw: unknown[], cutoff: number): boolean {
  if (cutoff === -Infinity || raw.length === 0) return false;
  return raw.every((r) => {
    const at = isoOrNull(asRecord(r)?.archivedAt);
    return at !== null && Date.parse(at) < cutoff;
  });
}

/**
 * Reads the archive newest first in pages of ARCHIVE_PAGE_SIZE from
 * `startPosition`, with the details of each page. Stops at the end, once a
 * whole page is older than the days window, or after ARCHIVE_LIST_CAP items
 * (then `nextPosition` says where "Show older" goes on).
 */
export async function listArchivedEmailsPaged(
  io: ArchiveIo,
  accountId: string,
  options: { days: number; now?: number; startPosition?: number; cap?: number; pageSize?: number },
): Promise<ArchiveListResult> {
  const now = options.now ?? Date.now();
  const cutoff = daysCutoff(options.days, now);
  const pageSize = options.pageSize ?? ARCHIVE_PAGE_SIZE;
  const cap = options.cap ?? ARCHIVE_LIST_CAP;
  let position = options.startPosition ?? 0;
  let looked = 0;
  const items: ArchivedEmail[] = [];
  for (;;) {
    const page = await io.query(position, pageSize);
    if (page.ids.length === 0) return { items, nextPosition: null };
    const raw = await io.get(page.ids);
    items.push(...parseArchivedItems(raw, accountId).filter((item) => inWindow(item, cutoff, now)));
    position += page.ids.length;
    looked += page.ids.length;
    if (wholePageOlder(raw, cutoff)) return { items, nextPosition: null };
    if (page.total !== null && position >= page.total) return { items, nextPosition: null };
    if (page.ids.length < pageSize && page.total === null) return { items, nextPosition: null };
    if (looked >= cap) return { items, nextPosition: position };
  }
}

/**
 * Whether the archive holds at least one message of `accountId` inside the
 * days window, looking at one item at a time, newest first: stops at the
 * first such message, at the first item older than the window, or after
 * `limit` items.
 */
export async function hasArchivedEmail(
  io: ArchiveIo,
  accountId: string,
  options: { days: number; now?: number; limit?: number },
): Promise<boolean> {
  const now = options.now ?? Date.now();
  const cutoff = daysCutoff(options.days, now);
  const limit = options.limit ?? ARCHIVE_PEEK_LIMIT;
  for (let position = 0; position < limit; position++) {
    const page = await io.query(position, 1);
    if (page.ids.length === 0) return false;
    const raw = await io.get(page.ids);
    if (parseArchivedItems(raw, accountId).some((item) => inWindow(item, cutoff, now))) return true;
    if (wholePageOlder(raw, cutoff)) return false;
    if (page.total !== null && position + 1 >= page.total) return false;
  }
  return false;
}

/**
 * The calls that restore `ids`, split at maxObjectsInSet. The narrowest
 * change a user may make: only `status` (and `archivedUntil`) are writable.
 */
export function buildRestoreCalls(ids: string[], accountId: string, maxObjectsInSet: number): ArchiveCall[] {
  const step = Math.max(1, Math.floor(maxObjectsInSet));
  const calls: ArchiveCall[] = [];
  for (let i = 0; i < ids.length; i += step) {
    const update = Object.fromEntries(ids.slice(i, i + step).map((id) => [id, { status: 'requestRestore' }]));
    calls.push(['x:ArchivedItem/set', { accountId, update }, `r${calls.length}`]);
  }
  return calls;
}

/** Each id of a restore call: updated, refused with the reason, or failed with the call. */
export function readRestoreResults(calls: ArchiveCall[], responses: ArchiveCall[]): RestoreResult[] {
  const byCallId = new Map(responses.map((r) => [r[2], r]));
  const results: RestoreResult[] = [];
  for (const [, args, callId] of calls) {
    const ids = Object.keys(args.update as Record<string, unknown>);
    const [method, result] = byCallId.get(callId) ?? [];
    if (method !== 'x:ArchivedItem/set' || !result) {
      const type = method === 'error' ? str(result?.type) || undefined : undefined;
      const reason = method === 'error' ? str(result?.description) || type || 'error' : 'No answer';
      results.push(...ids.map((id) => ({ id, ok: false, error: reason, ...(type ? { type } : {}) })));
      continue;
    }
    const updated = (result.updated ?? {}) as Record<string, unknown>;
    const notUpdated = (result.notUpdated ?? {}) as Record<string, { type?: string; description?: string } | undefined>;
    for (const id of ids) {
      if (id in updated) results.push({ id, ok: true });
      else {
        const refused = notUpdated[id];
        results.push({ id, ok: false, error: refused?.description || refused?.type || 'notUpdated', ...(refused?.type ? { type: refused.type } : {}) });
      }
    }
  }
  return results;
}

/**
 * How a failed archive call counts for detection: `unsupported` when the
 * server says no (no Enterprise license: `forbidden`; not Stalwart or too
 * old: `unknownMethod`, `unknownCapability`), `error` for anything else
 * (offline, a server error), which is asked again sooner.
 */
export function classifyArchiveError(error: unknown): 'unsupported' | 'error' {
  const type = jmapErrorType(error);
  if (type === 'forbidden' || type === 'unknownMethod' || type === 'unknownCapability' || type === 'accountNotFound') return 'unsupported';
  const message = error instanceof Error ? error.message : String(error);
  if (/unknownCapability|unknownMethod/.test(message)) return 'unsupported';
  return 'error';
}

export interface RestoreOutcome {
  /** Restored: they leave the list. */
  done: Set<string>;
  /** No longer in the archive (`notFound`): they leave the list too. */
  gone: Set<string>;
  /** Failed: they stay selected to try again. */
  failed: string[];
  /** The server refused for want of a license: the page hides. */
  refused: boolean;
}

/** What a restore of `ids` did, as the page shows it (webmail RecoverDeletedSettings.restore). */
export function restoreOutcome(ids: string[], results: RestoreResult[]): RestoreOutcome {
  const done = new Set(results.filter((r) => r.ok).map((r) => r.id));
  const gone = new Set(results.filter((r) => !r.ok && r.type === 'notFound').map((r) => r.id));
  return {
    done,
    gone,
    failed: ids.filter((id) => !done.has(id) && !gone.has(id)),
    refused: results.some((r) => r.type === 'forbidden'),
  };
}
