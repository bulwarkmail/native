import { create } from 'zustand';
import { jmapClient, type ServerProblem } from '../api/jmap-client';
import { useNetworkStore } from './network-store';

/**
 * How long requests have to keep failing, with none answered in between,
 * before the banner shows: one dropped request is not worth a banner.
 */
export const SHOW_AFTER_MS = 20_000;

interface ServerStatusState {
  /** The account the requests were for (the client serves one at a time). */
  accountId: string | null;
  problem: ServerProblem | null;
  /** When the failures in a row began. */
  since: number | null;
  failures: number;
  /** Two or more failures in a row over at least SHOW_AFTER_MS. */
  shown: boolean;
  report: (accountId: string | null, problem: ServerProblem | null, now?: number) => void;
}

const CLEAR = { problem: null, since: null, failures: 0, shown: false } as const;

export const useServerStatusStore = create<ServerStatusState>((set, get) => ({
  accountId: null,
  ...CLEAR,

  report: (accountId, problem, now = Date.now()) => {
    // Offline, the offline banner says why; failures then are no news about
    // the server.
    if (problem && !useNetworkStore.getState().online) return;
    const state = get().accountId === accountId ? get() : { accountId, ...CLEAR };
    if (!problem) {
      if (state.failures > 0 || state.accountId !== get().accountId) set({ accountId, ...CLEAR });
      return;
    }
    const failures = state.failures + 1;
    const since = state.since ?? now;
    set({
      accountId,
      // A sign-in that cannot be renewed is what to tell, whatever else fails
      // meanwhile: until it is renewed nothing works.
      problem: state.problem === 'sign_in_failing' ? 'sign_in_failing' : problem,
      since,
      failures,
      shown: state.shown || (failures >= 2 && now - since >= SHOW_AFTER_MS),
    });
  },
}));

jmapClient.onServerStatus((problem, accountId) => {
  useServerStatusStore.getState().report(accountId, problem);
});

// Back online: the run of failures starts over rather than showing what
// went wrong before the drop.
useNetworkStore.subscribe((state, previous) => {
  if (state.online && !previous.online) {
    useServerStatusStore.setState({ problem: null, since: null, failures: 0, shown: false });
  }
});
