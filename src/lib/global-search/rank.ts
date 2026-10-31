import type { ParsedQuery } from './query-parser';
import type { GlobalSearchHit } from './types';

// Merging and ordering of search hits (webmail lib/global-search/rank.ts).

/**
 * Identity for de-duplication: the same item reached through two logins of
 * one server is one hit; ids are scoped by server and owning account (#847).
 * Calendar hits collapse per series (the loaded window holds occurrences,
 * the server returns the series).
 */
function mergeKey(hit: GlobalSearchHit): string {
  const scope = hit.serverUrl ? `s ${hit.serverUrl} ${hit.jmapAccountId}` : `l ${hit.localAccountId} ${hit.jmapAccountId}`;
  if (hit.kind === 'calendar' && hit.event.uid) return `calendar ${scope} uid:${hit.event.uid}`;
  return `${hit.kind} ${scope} ${hit.id}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function atWordBoundary(field: string, term: string): boolean {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(term)}`, 'u').test(field);
}

/**
 * Relevance for the typed terms: exact > prefix > whole word > substring on
 * the title, then a subtitle match, then hits the server matched on a field
 * that isn't shown (the body). Recency breaks ties.
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

/** Sorted copy: score, then newest first, then title. */
export function rankHits(hits: GlobalSearchHit[], parsed: ParsedQuery): GlobalSearchHit[] {
  return hits
    .map((hit, index) => ({ hit, index, score: scoreHit(hit, parsed) }))
    .sort((a, b) =>
      b.score - a.score
      || dateValue(b.hit) - dateValue(a.hit)
      || a.hit.title.localeCompare(b.hit.title)
      || a.index - b.index)
    .map((entry) => entry.hit);
}

/**
 * De-duplicates by identity. A server hit replaces a local one for the same
 * item (it carries the snippet); a local hit never replaces a server one.
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
