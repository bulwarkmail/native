import React from 'react';
import { parseSearchQuery, hasRemoteQuery, SEARCH_KINDS, type ParsedQuery, type SearchScope } from './query-parser';
import { localOutcome, runGlobalSearch } from './run';
import { emptyOutcome, type SearchAccount, type SearchOutcome, type SearchProvider } from './types';

// Keeps a search's merged outcome current (webmail hooks/use-global-search.ts):
// in-memory hits on every keystroke, server hits after a pause, partial
// results as each login answers. A newer query drops older answers.

export interface UseGlobalSearchOptions {
  query: string;
  /** Scope chip; an `in:` in the query wins. */
  scope: SearchScope;
  /** Account chip (account-store id); null = every login. */
  accountId: string | null;
  localLimit: number;
  remoteLimit: number;
  debounceMs?: number;
  enabled?: boolean;
  providers: readonly SearchProvider[];
  accounts: () => SearchAccount[];
}

/** The parsed query with the scope chip applied (an explicit `in:` wins). */
export function scopedQuery(query: string, scope: SearchScope): ParsedQuery {
  const base = parseSearchQuery(query);
  return base.scope === 'all' && scope !== 'all' ? { ...base, scope } : base;
}

export function useGlobalSearch(options: UseGlobalSearchOptions): { parsed: ParsedQuery; outcome: SearchOutcome; isSearching: boolean } {
  const {
    query, scope, accountId, localLimit, remoteLimit, debounceMs = 300, enabled = true, providers, accounts,
  } = options;
  const parsed = React.useMemo(() => scopedQuery(query, scope), [query, scope]);
  const [outcome, setOutcome] = React.useState<SearchOutcome>(emptyOutcome);
  const searchId = React.useRef(0);

  const isEmpty = parsed.terms.length === 0 && !SEARCH_KINDS.some((kind) => hasRemoteQuery(parsed, kind));

  React.useEffect(() => {
    const id = ++searchId.current;
    if (!enabled || isEmpty) {
      setOutcome(emptyOutcome());
      return undefined;
    }
    const controller = new AbortController();
    const all = accounts();
    const targets = accountId ? all.filter((a) => a.localAccountId === accountId) : all;
    setOutcome(localOutcome(parsed, targets, providers, localLimit));
    const timer = setTimeout(() => {
      void runGlobalSearch({
        parsed, accounts: targets, providers, localLimit, remoteLimit, signal: controller.signal,
        onUpdate: (next) => { if (id === searchId.current) setOutcome(next); },
      });
    }, debounceMs);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [parsed, enabled, isEmpty, accountId, accounts, providers, localLimit, remoteLimit, debounceMs]);

  const isSearching = SEARCH_KINDS.some((kind) => outcome.status[kind].status === 'loading');
  return { parsed, outcome, isSearching };
}
