import { create } from 'zustand';

// A `mail/search` deep link (the search widget) arrives before the mail list
// is mounted, or while it shows a folder. The query is parked here and
// consumed by EmailListScreen, which runs it like a submitted search; an
// empty query just opens the search field.
interface PendingMailSearchState {
  query: string | null;
  set: (query: string | null) => void;
  consume: () => string | null;
}

export const usePendingMailSearch = create<PendingMailSearchState>((set, get) => ({
  query: null,
  set: (query) => set({ query }),
  consume: () => {
    const query = get().query;
    if (query !== null) set({ query: null });
    return query;
  },
}));

export function setPendingMailSearch(query: string | null): void {
  usePendingMailSearch.getState().set(query);
}
