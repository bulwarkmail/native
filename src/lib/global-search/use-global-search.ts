import React from 'react';
import { createGlobalSearchController, type GlobalSearchController, type GlobalSearchState } from './controller';
import type { SearchScope } from './query-parser';
import type { SearchAccount, SearchProvider } from './types';

export interface UseGlobalSearchOptions {
  query: string;
  scope: SearchScope;
  accountId: string | null;
  providers: readonly SearchProvider[];
  accounts: SearchAccount[];
  /**
   * Changes whenever what the accounts can be searched for changes (the
   * signed-in accounts, the shown one, its connection): the controller reads
   * the accounts on each run but does not restart by itself.
   */
  accountsKey: string;
  localLimit: number;
  remoteLimit: number;
}

export interface UseGlobalSearchResult extends GlobalSearchState {
  loadMoreMail: () => void;
}

/**
 * The global search controller for a screen: created on mount, fed the
 * inputs, re-run when the accounts change, and disposed on unmount (so no
 * result of a search the screen left lands anywhere).
 */
export function useGlobalSearch(options: UseGlobalSearchOptions): UseGlobalSearchResult {
  const { query, scope, accountId, providers, accounts, accountsKey, localLimit, remoteLimit } = options;
  const accountsRef = React.useRef(accounts);
  accountsRef.current = accounts;

  const [controller, setController] = React.useState<GlobalSearchController | null>(null);
  const [state, setState] = React.useState<GlobalSearchState | null>(null);

  // Created in the effect, not in render: a disposed controller can't be
  // reused, and a strict-mode remount runs the cleanup once.
  React.useEffect(() => {
    const next = createGlobalSearchController({
      providers,
      accounts: () => accountsRef.current,
      localLimit,
      remoteLimit,
    });
    const unsubscribe = next.subscribe(setState);
    setController(next);
    setState(next.getState());
    return () => {
      unsubscribe();
      next.dispose();
    };
  }, [providers, localLimit, remoteLimit]);

  React.useEffect(() => {
    controller?.update({ query, scope, accountId });
  }, [controller, query, scope, accountId]);

  // The first key is what `update` already searched; only a change re-runs.
  const ranFor = React.useRef<{ controller: GlobalSearchController | null; key: string } | null>(null);
  React.useEffect(() => {
    if (!controller) return;
    const last = ranFor.current;
    ranFor.current = { controller, key: accountsKey };
    if (last && last.controller === controller && last.key !== accountsKey) controller.rerun();
  }, [controller, accountsKey]);

  const loadMoreMail = React.useCallback(() => controller?.loadMoreMail(), [controller]);
  const current = state ?? INITIAL;
  return React.useMemo(() => ({ ...current, loadMoreMail }), [current, loadMoreMail]);
}

/** What the screen shows before the controller's first publish: nothing searched yet. */
const INITIAL: GlobalSearchState = (() => {
  const idle = createGlobalSearchController({ providers: [], accounts: () => [], localLimit: 0, remoteLimit: 0 });
  const initial = idle.getState();
  idle.dispose();
  return initial;
})();
