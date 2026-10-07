// What the global search screen lists, as plain rows (webmail's palette and
// search tab, components/global-search/*): a section per kind with its count,
// at most MAX_ROWS_PER_KIND hits until "Show all", the per-account error
// rows, and mail's "Load more". Kept free of React so it is tested directly.

import type { SearchScope } from './query-parser';
import {
  SEARCH_KINDS,
  type GlobalSearchHit,
  type SearchAccount,
  type SearchKind,
  type SearchOutcome,
} from './types';

/** Rows a group shows before "Show all" (webmail palette MAX_ROWS_PER_KIND). */
export const MAX_ROWS_PER_KIND = 5;

/**
 * A hit's list key. Ids repeat across accounts (and across JMAP accounts in
 * one login), so the key names both.
 */
export function hitKey(hit: GlobalSearchHit): string {
  return `${hit.kind}|${hit.appAccountId}|${hit.jmapAccountId}|${hit.id}`;
}

export type SearchRow =
  | { type: 'header'; key: string; kind: SearchKind; count: number; hasMore: boolean; loading: boolean }
  | { type: 'hit'; key: string; hit: GlobalSearchHit }
  | { type: 'show_all'; key: string; kind: SearchKind; hidden: number }
  | { type: 'error'; key: string; kind: SearchKind; appAccountId: string; accountLabel: string }
  | { type: 'load_more'; key: 'load_more' };

/** The kinds a scope lists, in webmail's order. */
export function kindsFor(scope: SearchScope): SearchKind[] {
  return SEARCH_KINDS.filter((kind) => scope === 'all' || scope === kind);
}

/**
 * The rows for `outcome` under the parsed scope. A group is listed while it
 * has hits, error rows or is still loading. With every kind shown, a group
 * stops at MAX_ROWS_PER_KIND until it is in `expanded`; a one-kind scope
 * lists all of its hits. "Load more" follows mail once every fetched mail
 * hit is shown and a server reported more.
 */
export function searchRows(outcome: SearchOutcome, scope: SearchScope, expanded: ReadonlySet<SearchKind>): SearchRow[] {
  const rows: SearchRow[] = [];
  for (const kind of kindsFor(scope)) {
    const hits = outcome.hits[kind];
    const status = outcome.status[kind];
    const loading = status.status === 'loading';
    if (hits.length === 0 && status.errors.length === 0 && !loading) continue;
    rows.push({ type: 'header', key: `header:${kind}`, kind, count: hits.length, hasMore: status.hasMore, loading });
    const capped = scope === 'all' && !expanded.has(kind);
    const shown = capped ? hits.slice(0, MAX_ROWS_PER_KIND) : hits;
    for (const hit of shown) rows.push({ type: 'hit', key: hitKey(hit), hit });
    const hidden = hits.length - shown.length;
    if (hidden > 0) rows.push({ type: 'show_all', key: `show_all:${kind}`, kind, hidden });
    for (const error of status.errors) {
      rows.push({
        type: 'error',
        key: `error:${kind}:${error.appAccountId}`,
        kind,
        appAccountId: error.appAccountId,
        accountLabel: error.accountLabel,
      });
    }
    if (kind === 'mail' && hidden === 0 && status.hasMore && !loading) rows.push({ type: 'load_more', key: 'load_more' });
  }
  return rows;
}

/**
 * Whether to say "No results": a finished search with something to search
 * for found nothing in scope, and every account answered (an account that
 * couldn't be searched has its error row instead: nothing is known of it).
 */
export function showNoResults(
  outcome: SearchOutcome,
  scope: SearchScope,
  state: { isSearching: boolean; isEmpty: boolean },
): boolean {
  if (state.isSearching || state.isEmpty) return false;
  return kindsFor(scope).every((kind) => outcome.hits[kind].length === 0 && outcome.status[kind].errors.length === 0);
}

/** The account-store fields a search account is built from. */
export interface SearchAccountSource {
  id: string;
  email: string;
  username: string;
  serverUrl: string;
}

/**
 * Every signed-in account the search fans out to, each with its own server
 * (rank's merge keeps two servers' same ids apart by it).
 */
export function searchAccountsFrom(accounts: readonly SearchAccountSource[]): SearchAccount[] {
  return accounts.map((account) => ({
    appAccountId: account.id,
    label: account.email || account.username,
    email: account.email,
    serverUrl: account.serverUrl,
  }));
}
