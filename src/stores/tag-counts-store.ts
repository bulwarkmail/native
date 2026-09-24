import { create } from 'zustand';
import { fetchTagCounts, type TagCount } from '../api/tag-counts';

// Sidebar tag badges (PF6). Every drawer open used to send the full set of
// Email/query pairs again, one pair per tag and account, although nothing
// had changed. The counts are now kept for the login, the accounts and the
// tags they were fetched for, and fetched again only once an Email change
// was reported for one of those accounts (push, or the poll fallback), or
// when the login, the accounts or the tags differ.

interface TagCountsState {
  /** Tag id → counts, summed over the accounts they were fetched for. */
  counts: Record<string, TagCount>;
  /** Login the counts belong to; another login's are dropped, not shown. */
  login: string | null;
  /** The login, accounts and tags the counts were fetched for. */
  key: string | null;
  /** Bumped by every reported Email change. */
  generation: number;
  /** `generation` the counts were fetched at. */
  fetchedAt: number;
  /** Fetch the counts unless the cached ones are current. */
  ensure: (login: string, tagIds: string[], accountIds: Array<string | undefined>) => Promise<void>;
  /** An Email change arrived: the next `ensure` fetches again. */
  invalidate: () => void;
}

let inflight: { key: string; generation: number; seq: number; promise: Promise<void> } | null = null;
let lastSeq = 0;

export const useTagCountsStore = create<TagCountsState>((set, get) => ({
  counts: {},
  login: null,
  key: null,
  generation: 0,
  fetchedAt: -1,

  ensure: (login, tagIds, accountIds) => {
    const key = `${login}|${accountIds.map((id) => id ?? '').join(',')}|${tagIds.join(',')}`;
    if (get().login !== login) set({ counts: {}, login, key: null });
    const { generation } = get();
    if (get().key === key && get().fetchedAt === generation) return Promise.resolve();
    if (inflight && inflight.key === key && inflight.generation === generation) return inflight.promise;
    const seq = ++lastSeq;
    const promise = (async () => {
      try {
        const list = await fetchTagCounts(tagIds, accountIds);
        // A later ensure (another login, other tags) supersedes this one.
        if (inflight?.seq !== seq || get().login !== login) return;
        set({ counts: Object.fromEntries(list.map((c) => [c.id, c])), key, fetchedAt: generation });
      } catch {
        // Counts are decoration: keep the old ones and try again next time.
      } finally {
        if (inflight?.seq === seq) inflight = null;
      }
    })();
    inflight = { key, generation, seq, promise };
    return promise;
  },

  invalidate: () => set({ generation: get().generation + 1 }),
}));
