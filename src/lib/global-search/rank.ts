import type { ParsedQuery } from './query-parser';
import type { GlobalSearchHit } from './types';

/**
 * Identity used for de-duplication.
 *
 * The same object reached through several logins to the SAME server is one
 * result, not one per login (multi-account setups against a single server
 * would otherwise repeat every hit once per login). Ids are only meaningful
 * per server + owning JMAP account, so that pair scopes the key (the URL
 * without trailing slashes, so one server never counts twice); hits without
 * a serverUrl (injected in tests) fall back to the login and the owning
 * account, which never over-merges: a login's own `1` and its group
 * account's `1` stay two hits (#847: ids from different servers stay apart
 * either way).
 *
 * Calendar hits additionally collapse per series: the local cache holds
 * expanded occurrences while server FTS returns the master, and a search
 * result should list a series once - so the uid, not the occurrence id.
 */
function serverOf(url: string | undefined): string {
  let end = (url ?? '').trim();
  while (end.endsWith('/')) end = end.slice(0, -1);
  return end;
}

function mergeKey(hit: GlobalSearchHit): string {
  const server = serverOf(hit.serverUrl);
  const scope = server ? `s ${server} ${hit.jmapAccountId}` : `l ${hit.appAccountId} ${hit.jmapAccountId}`;
  if (hit.kind === 'calendar' && hit.event.uid) {
    return `calendar ${scope} uid:${hit.event.uid}`;
  }
  return `${hit.kind} ${scope} ${hit.id}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function atWordBoundary(field: string, term: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(term)}`, 'u').test(field);
}

/**
 * Relevance of a hit for the typed terms. Titles are what the user scans, so
 * exact > prefix > whole-word > substring on the title, then a subtitle match,
 * and finally hits the server matched on a field we don't show (body text).
 * Recency breaks ties in `rankHits`.
 */
export function scoreHit(hit: GlobalSearchHit, parsed: ParsedQuery): number {
  const query = parsed.terms.join(' ');
  if (!query) return 10;
  const title = hit.title.toLowerCase();
  if (title === query) return 100;
  if (title.startsWith(query)) return 80;
  if (parsed.terms.every((term) => atWordBoundary(title, term))) return 60;
  if (parsed.terms.every((term) => title.includes(term))) return 50;
  if (parsed.terms.some((term) => title.includes(term))) return 30;
  const subtitle = hit.subtitle.toLowerCase();
  if (parsed.terms.some((term) => subtitle.includes(term))) return 20;
  return 10;
}

function dateValue(hit: GlobalSearchHit): number {
  if (!hit.date) return Number.NEGATIVE_INFINITY;
  const ms = new Date(hit.date).getTime();
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

/** Newest first; hits without a date sink to the bottom. */
export function compareByRecency(a: GlobalSearchHit, b: GlobalSearchHit): number {
  return dateValue(b) - dateValue(a);
}

/** Sorted copy: score desc, recency desc, then title for a stable order. */
export function rankHits(hits: GlobalSearchHit[], parsed: ParsedQuery): GlobalSearchHit[] {
  return hits
    .map((hit, index) => ({ hit, index, score: scoreHit(hit, parsed) }))
    .sort((a, b) =>
      b.score - a.score
      || compareByRecency(a.hit, b.hit)
      || a.hit.title.localeCompare(b.hit.title)
      || a.index - b.index)
    .map((entry) => entry.hit);
}

/**
 * Dedupes by identity (see mergeKey). A remote hit replaces a local one for the same
 * item - it carries the server snippet and the freshest data - while a local
 * hit never displaces a remote one that already landed. Order of first
 * appearance is kept; callers re-rank afterwards.
 */
export function mergeHits(existing: GlobalSearchHit[], incoming: GlobalSearchHit[]): GlobalSearchHit[] {
  const byKey = new Map<string, GlobalSearchHit>();
  for (const hit of existing) byKey.set(mergeKey(hit), hit);
  for (const hit of incoming) {
    const key = mergeKey(hit);
    const current = byKey.get(key);
    if (current && current.source === 'remote' && hit.source === 'local') continue;
    byKey.set(key, hit);
  }
  return [...byKey.values()];
}
