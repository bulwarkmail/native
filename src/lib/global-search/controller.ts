// Framework-free orchestration of a global search, ported from webmail's
// hooks/use-global-search.ts: the local pass on every keystroke, the server
// pass after a debounce with partial results merged as each login lands, the
// mail "load more", and stale results dropped by search id. A screen wraps
// this in a hook (subscribe + getState); nothing here touches React.

import { parseSearchQuery, type ParsedQuery, type SearchScope } from './query-parser';
import { mergeHits, rankHits } from './rank';
import { hasRemoteQuery, runGlobalSearch } from './run-global-search';
import {
  emptyOutcome,
  SEARCH_KINDS,
  type SearchAccount,
  type SearchOutcome,
  type SearchProvider,
} from './types';

export const DEFAULT_SEARCH_DEBOUNCE_MS = 300;

export interface GlobalSearchControllerOptions {
  providers: readonly SearchProvider[];
  /** Every account the search may fan out to; read on each run. */
  accounts: () => SearchAccount[];
  /** Hits per kind from the local caches. */
  localLimit: number;
  /** Hits per kind per account from the server. */
  remoteLimit: number;
  /** Delay before the server pass; the local pass runs immediately. */
  debounceMs?: number;
}

export interface GlobalSearchInput {
  query: string;
  /** Scope chip; an explicit `in:` in the query wins over it. */
  scope: SearchScope;
  /** Account chip (app account id); null = every account. */
  accountId: string | null;
  enabled?: boolean;
}

export interface GlobalSearchState {
  parsed: ParsedQuery;
  outcome: SearchOutcome;
  /** Any kind still waiting on a server response. */
  isSearching: boolean;
  /** The query has nothing to search for (empty, or operators with no server-side meaning). */
  isEmpty: boolean;
  /** Current mail window; grows by `remoteLimit` on each load-more. */
  mailLimit: number;
}

export interface GlobalSearchController {
  getState: () => GlobalSearchState;
  subscribe: (listener: (state: GlobalSearchState) => void) => () => void;
  /** Feed the current inputs; restarts the search when they changed. */
  update: (input: GlobalSearchInput) => void;
  /** Re-run the server pass now. */
  rerun: () => void;
  /** Fetch a bigger mail window and merge it in. */
  loadMoreMail: () => void;
  dispose: () => void;
}

export function resolveParsedQuery(query: string, scope: SearchScope): ParsedQuery {
  const base = parseSearchQuery(query);
  return base.scope === 'all' && scope !== 'all' ? { ...base, scope } : base;
}

function isSearching(outcome: SearchOutcome): boolean {
  return Object.values(outcome.status).some((s) => s.status === 'loading');
}

export function createGlobalSearchController(options: GlobalSearchControllerOptions): GlobalSearchController {
  const { providers, localLimit, remoteLimit, debounceMs = DEFAULT_SEARCH_DEBOUNCE_MS } = options;

  let input: GlobalSearchInput = { query: '', scope: 'all', accountId: null, enabled: true };
  let inputKey: string | null = null;
  let parsed = resolveParsedQuery('', 'all');
  let outcome = emptyOutcome();
  let mailLimit = remoteLimit;
  let searchId = 0;
  let controller: AbortController | null = null;
  let loadMoreController: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const listeners = new Set<(state: GlobalSearchState) => void>();

  const isEmptyQuery = () => !(parsed.terms.length > 0 || SEARCH_KINDS.some((kind) => hasRemoteQuery(parsed, kind)));

  let state: GlobalSearchState = { parsed, outcome, isSearching: false, isEmpty: true, mailLimit };
  const publish = () => {
    state = { parsed, outcome, isSearching: isSearching(outcome), isEmpty: isEmptyQuery(), mailLimit };
    for (const listener of [...listeners]) listener(state);
  };

  const resolveAccounts = () => {
    const all = options.accounts();
    return input.accountId ? all.filter((a) => a.appAccountId === input.accountId) : all;
  };

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    controller?.abort();
    loadMoreController?.abort();
    controller = null;
    loadMoreController = null;
  };

  const start = () => {
    cancel();
    const id = ++searchId;
    if (disposed) return;
    if (input.enabled === false || isEmptyQuery()) {
      outcome = emptyOutcome();
      publish();
      return;
    }
    const mine = new AbortController();
    controller = mine;
    const accounts = resolveAccounts();
    const query = parsed;

    // Instant pass: whatever the caches already hold, no round-trip.
    const local = emptyOutcome();
    for (const provider of providers) {
      if (query.scope !== 'all' && provider.kind !== query.scope) continue;
      if (query.terms.length > 0) {
        try {
          local.hits[provider.kind] = rankHits(mergeHits([], provider.local(query, accounts, localLimit)), query);
        } catch {
          // A cache mid-mutation must not break typing; the server pass follows.
        }
      }
      const willAsk = hasRemoteQuery(query, provider.kind) && accounts.some((a) => provider.supports(a));
      local.status[provider.kind].status = willAsk ? 'loading' : 'done';
    }
    outcome = local;
    publish();

    timer = setTimeout(() => {
      timer = null;
      if (mine.signal.aborted) return;
      void runGlobalSearch({
        parsed: query,
        accounts,
        providers: [...providers],
        localLimit,
        remoteLimit: mailLimit > remoteLimit ? mailLimit : remoteLimit,
        signal: mine.signal,
        onUpdate: (next) => {
          if (id !== searchId) return;
          outcome = next;
          publish();
        },
      });
    }, debounceMs);
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    update: (next) => {
      const key = JSON.stringify([next.query, next.scope, next.accountId, next.enabled !== false]);
      if (key === inputKey) return;
      inputKey = key;
      input = next;
      parsed = resolveParsedQuery(next.query, next.scope);
      mailLimit = remoteLimit;
      start();
    },
    rerun: () => start(),
    loadMoreMail: () => {
      if (disposed || input.enabled === false || isEmptyQuery()) return;
      const nextLimit = mailLimit + remoteLimit;
      mailLimit = nextLimit;
      loadMoreController?.abort();
      const mine = new AbortController();
      loadMoreController = mine;
      const id = searchId;
      const query = parsed;
      void runGlobalSearch({
        parsed: query,
        accounts: resolveAccounts(),
        providers: providers.filter((p) => p.kind === 'mail'),
        localLimit,
        remoteLimit: nextLimit,
        includeLocal: false,
        signal: mine.signal,
        onUpdate: (next) => {
          if (id !== searchId) return;
          outcome = {
            hits: { ...outcome.hits, mail: rankHits(mergeHits(outcome.hits.mail, next.hits.mail), query) },
            status: { ...outcome.status, mail: next.status.mail },
          };
          publish();
        },
      });
      publish();
    },
    dispose: () => {
      disposed = true;
      searchId++;
      cancel();
      listeners.clear();
    },
  };
}
