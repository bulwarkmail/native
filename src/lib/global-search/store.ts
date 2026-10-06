// State of the global search palette (webmail #641). Port of the webmail's
// stores/global-search-store.ts: the last scope is remembered across launches;
// the open flag, the query and the account chip are not.

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { SearchScope } from './query-parser';

interface GlobalSearchState {
  isOpen: boolean;
  query: string;
  scope: SearchScope;
  /** App account id to restrict to, or null for every account. */
  accountId: string | null;
  openPalette: (initialQuery?: string) => void;
  closePalette: () => void;
  togglePalette: () => void;
  setQuery: (query: string) => void;
  setScope: (scope: SearchScope) => void;
  setAccountId: (accountId: string | null) => void;
}

const SCOPES: readonly SearchScope[] = ['all', 'mail', 'contacts', 'calendar', 'files'];

export const useGlobalSearchStore = create<GlobalSearchState>()(
  persist(
    (set, get) => ({
      isOpen: false,
      query: '',
      scope: 'all',
      accountId: null,

      openPalette: (initialQuery) => set({
        isOpen: true,
        ...(initialQuery !== undefined ? { query: initialQuery } : {}),
      }),
      closePalette: () => set({ isOpen: false }),
      togglePalette: () => set({ isOpen: !get().isOpen }),
      setQuery: (query) => set({ query }),
      setScope: (scope) => set({ scope: SCOPES.includes(scope) ? scope : 'all' }),
      setAccountId: (accountId) => set({ accountId }),
    }),
    {
      name: 'global-search',
      version: 1,
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ scope: state.scope }),
      merge: (persisted, current) => {
        const saved = persisted as Partial<GlobalSearchState> | undefined;
        const scope = saved?.scope && SCOPES.includes(saved.scope) ? saved.scope : 'all';
        return { ...current, scope };
      },
    },
  ),
);
