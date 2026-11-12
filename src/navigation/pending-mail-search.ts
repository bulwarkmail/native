import { create } from 'zustand';

// A `mail/search` deep link (the search widget) arrives before the mail list
// is mounted, or while it shows a folder. The query is parked here and
// consumed by EmailListScreen, which runs it like a submitted search; an
// empty query just opens the search field. "Find mail" on an address parks
// the sender instead, which the list applies as its From filter (webmail
// lib/mail-search-request.ts, acb827bf1).
interface PendingMailSearchState {
  query: string | null;
  from: string | null;
  set: (query: string | null) => void;
  setFrom: (from: string | null) => void;
  consume: () => string | null;
  consumeFrom: () => string | null;
}

export const usePendingMailSearch = create<PendingMailSearchState>((set, get) => ({
  query: null,
  from: null,
  set: (query) => set({ query }),
  setFrom: (from) => set({ from }),
  consume: () => {
    const query = get().query;
    if (query !== null) set({ query: null });
    return query;
  },
  consumeFrom: () => {
    const from = get().from;
    if (from !== null) set({ from: null });
    return from;
  },
}));

export function setPendingMailSearch(query: string | null): void {
  usePendingMailSearch.getState().set(query);
}

/** Opens the mail list on the mail from `address`. */
export function setPendingSenderSearch(address: string): void {
  usePendingMailSearch.getState().setFrom(address);
}
