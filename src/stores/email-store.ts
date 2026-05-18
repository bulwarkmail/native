import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Email, Mailbox, StateChange } from '../api/types';
import { jmapClient } from '../api/jmap-client';
import {
  getMailboxes as fetchMailboxes,
  getMailboxesWithState,
  getMailboxesByIds,
  getMailboxChanges,
  queryEmails,
  getEmailQueryChanges,
  getEmails as fetchEmails,
  getEmailsWithState,
  getEmailChanges,
  getFullEmail,
  setEmailKeywords,
  moveEmail,
  archiveEmails as apiArchiveEmails,
  deleteEmail as apiDeleteEmail,
  restoreEmailMailboxes,
  searchEmails as apiSearchEmails,
} from '../api/email';
import { toWildcardQuery } from '../lib/search-utils';
import { useSettingsStore } from './settings-store';
import { useOfflineCacheStore } from './offline-cache-store';

export interface EmailFilters {
  from?: string;
  to?: string;
  subject?: string;
  dateAfter?: string;  // YYYY-MM-DD
  dateBefore?: string; // YYYY-MM-DD
  hasAttachment?: boolean; // undefined = unset, true = with, false = without
  isStarred?: boolean;
  isUnread?: boolean;
}

// Snapshot of an action that can still be reversed via the undo snackbar.
// We store the full email object so undo can re-insert it into the visible list
// optimistically without waiting for a refetch.
export interface UndoEntry {
  kind: 'archive' | 'delete' | 'move' | 'spam';
  /** Human-readable label shown in the snackbar (e.g. "Email archived"). */
  label: string;
  /** Time the entry was created - the snackbar uses this to drive its timer. */
  createdAt: number;
  /** Each item is one email's pre-action mailboxIds, used to restore it. */
  items: Array<{ email: Email; originalMailboxIds: Record<string, boolean> }>;
}

// Cached emails for one mailbox (the base view: no search query, no filters).
// `queryState` is the JMAP queryState for the matching Email/query, used to
// drive Email/queryChanges on the next refresh.
interface MailboxSnapshot {
  emails: Email[];
  total: number;
  queryState?: string;
}

// Everything we cache for one account so switching accounts can restore the
// previous view instantly instead of going through a network round-trip.
interface AccountSnapshot {
  mailboxes: Mailbox[];
  mailboxState?: string;       // JMAP Mailbox state (drives Mailbox/changes)
  emailState?: string;         // JMAP Email state (drives Email/changes)
  currentMailboxId: string | null;
  mailboxSnapshots: Record<string, MailboxSnapshot>;
}

export interface EmailState {
  // ── Per-account persisted caches ──────────────────────────────
  // accountSnapshots is the source of truth for accounts the user is *not*
  // currently viewing. The active account's data lives in the top-level
  // fields below (`mailboxes`, `mailboxSnapshots`, `mailboxState`, `emailState`,
  // `currentMailboxId`, `emails`, `totalEmails`, `queryState`) so consumers
  // keep reading the same shape they always have.
  accountSnapshots: Record<string, AccountSnapshot>;
  activeAccountId: string | null;

  // ── Active view (the currently-shown account/mailbox) ─────────
  mailboxes: Mailbox[];
  mailboxState?: string;
  emailState?: string;
  currentMailboxId: string | null;
  mailboxSnapshots: Record<string, MailboxSnapshot>;
  emails: Email[];
  totalEmails: number;
  queryState?: string;          // queryState for the currently-shown mailbox

  // ── UI state (not persisted, not per-account) ─────────────────
  loading: boolean;
  error: string | null;
  searchQuery: string;
  filters: EmailFilters;
  pendingUndo: UndoEntry | null;

  // ── Actions ────────────────────────────────────────────────────
  setActiveAccount: (accountId: string | null) => void;
  removeAccount: (accountId: string) => void;
  clearAllAccounts: () => void;
  fetchMailboxes: () => Promise<void>;
  selectMailbox: (mailboxId: string) => Promise<void>;
  loadMoreEmails: () => Promise<void>;
  refreshEmails: () => Promise<void>;
  handleStateChange: (change: StateChange) => Promise<void>;
  getEmailDetail: (id: string) => Promise<Email>;
  markRead: (emailId: string) => Promise<void>;
  markUnread: (emailId: string) => Promise<void>;
  toggleStar: (emailId: string, starred: boolean) => Promise<void>;
  togglePin: (emailId: string, pinned: boolean) => Promise<void>;
  moveToMailbox: (emailId: string, fromMailboxId: string, toMailboxId: string) => Promise<void>;
  archiveEmail: (emailId: string) => Promise<void>;
  deleteEmail: (emailId: string, trashMailboxId: string, currentMailboxId: string) => Promise<void>;
  undoLast: () => Promise<void>;
  clearUndo: () => void;
  searchEmails: (query: string) => Promise<Email[]>;
  setSearchQuery: (query: string) => void;
  setFilters: (filters: EmailFilters) => void;
  clearSearchAndFilters: () => void;
  reset: () => void;
}

function buildJmapFilter(
  mailboxId: string,
  searchQuery: string,
  filters: EmailFilters,
): Record<string, unknown> {
  const conditions: Record<string, unknown>[] = [{ inMailbox: mailboxId }];

  const trimmed = searchQuery.trim();
  if (trimmed) conditions.push({ text: toWildcardQuery(trimmed) });

  if (filters.from) conditions.push({ from: filters.from });
  if (filters.to) conditions.push({ to: filters.to });
  if (filters.subject) conditions.push({ subject: filters.subject });

  if (filters.dateAfter) {
    const d = new Date(filters.dateAfter);
    if (!isNaN(d.getTime())) conditions.push({ after: d.toISOString() });
  }
  if (filters.dateBefore) {
    const d = new Date(filters.dateBefore);
    if (!isNaN(d.getTime())) {
      d.setHours(23, 59, 59, 999);
      conditions.push({ before: d.toISOString() });
    }
  }

  if (filters.hasAttachment === true) conditions.push({ hasAttachment: true });
  else if (filters.hasAttachment === false) conditions.push({ hasAttachment: false });

  if (filters.isUnread === true) conditions.push({ notKeyword: '$seen' });
  else if (filters.isUnread === false) conditions.push({ hasKeyword: '$seen' });

  if (filters.isStarred === true) conditions.push({ hasKeyword: '$flagged' });
  else if (filters.isStarred === false) conditions.push({ notKeyword: '$flagged' });

  if (conditions.length === 1) return conditions[0];
  return { operator: 'AND', conditions };
}

// True when the user has no search/filters active. Only in this case do we
// touch the per-mailbox snapshot cache or use Email/queryChanges — once a
// filter is in play, the queryState belongs to a different query and the
// cached list no longer represents what's on screen.
function isBaseView(searchQuery: string, filters: EmailFilters): boolean {
  return !searchQuery.trim() && Object.keys(filters).length === 0;
}

function snapshotFromActive(state: EmailState): AccountSnapshot {
  // Persist the currently-visible mailbox into its snapshot before tucking
  // the whole account away.
  let mailboxSnapshots = state.mailboxSnapshots;
  if (state.currentMailboxId && isBaseView(state.searchQuery, state.filters)) {
    mailboxSnapshots = {
      ...mailboxSnapshots,
      [state.currentMailboxId]: {
        emails: state.emails,
        total: state.totalEmails,
        queryState: state.queryState,
      },
    };
  }
  return {
    mailboxes: state.mailboxes,
    mailboxState: state.mailboxState,
    emailState: state.emailState,
    currentMailboxId: state.currentMailboxId,
    mailboxSnapshots,
  };
}

function viewFromSnapshot(snap: AccountSnapshot | null): {
  mailboxes: Mailbox[];
  mailboxState?: string;
  emailState?: string;
  currentMailboxId: string | null;
  mailboxSnapshots: Record<string, MailboxSnapshot>;
  emails: Email[];
  totalEmails: number;
  queryState?: string;
} {
  if (!snap) {
    return {
      mailboxes: [],
      mailboxState: undefined,
      emailState: undefined,
      currentMailboxId: null,
      mailboxSnapshots: {},
      emails: [],
      totalEmails: 0,
      queryState: undefined,
    };
  }
  const mailboxSnap = snap.currentMailboxId
    ? snap.mailboxSnapshots[snap.currentMailboxId]
    : undefined;
  return {
    mailboxes: snap.mailboxes,
    mailboxState: snap.mailboxState,
    emailState: snap.emailState,
    currentMailboxId: snap.currentMailboxId,
    mailboxSnapshots: snap.mailboxSnapshots,
    emails: mailboxSnap?.emails ?? [],
    totalEmails: mailboxSnap?.total ?? 0,
    queryState: mailboxSnap?.queryState,
  };
}

// JMAP's maxObjectsInGet bounds how many ids we can pull in one Email/get.
// Chunk to that ceiling (with a small safety fallback) so large change sets
// don't trip 429/413 responses.
async function fetchEmailsChunked(ids: string[]): Promise<Email[]> {
  if (ids.length === 0) return [];
  const cap = Math.max(1, jmapClient.getMaxObjectsInGet());
  const chunk = Math.min(cap, 200);
  if (ids.length <= chunk) return fetchEmails(ids);
  const out: Email[] = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = await fetchEmails(ids.slice(i, i + chunk));
    out.push(...slice);
  }
  return out;
}

// Merge a fresh batch of emails into an existing list keyed by id. New entries
// replace stale ones (keywords/mailboxIds may have changed); destroyed ids are
// dropped. Order is preserved according to the supplied id order — pass the
// authoritative id list from Email/query when re-syncing.
function applyEmailDiff(
  current: Email[],
  orderedIds: string[],
  fetched: Email[],
  destroyed: Set<string>,
): Email[] {
  const byId = new Map<string, Email>();
  for (const e of current) byId.set(e.id, e);
  for (const e of fetched) byId.set(e.id, e);
  const out: Email[] = [];
  for (const id of orderedIds) {
    if (destroyed.has(id)) continue;
    const e = byId.get(id);
    if (e) out.push(e);
  }
  return out;
}

export const useEmailStore = create<EmailState>()(
  persist(
    (set, get) => ({
  accountSnapshots: {},
  activeAccountId: null,

  mailboxes: [],
  mailboxState: undefined,
  emailState: undefined,
  currentMailboxId: null,
  mailboxSnapshots: {},
  emails: [],
  totalEmails: 0,
  queryState: undefined,

  loading: false,
  error: null,
  searchQuery: '',
  filters: {},
  pendingUndo: null,

  // Swap which account's data is currently visible. The previous account's
  // view is tucked into accountSnapshots so a return-trip can restore it
  // without a network call; the new account's view is pulled from its
  // snapshot (or empty defaults if we've never seen it). Callers (auth-store)
  // run the network refresh afterwards.
  setActiveAccount: (accountId) => {
    const state = get();
    if (state.activeAccountId === accountId) return;

    const nextSnapshots = { ...state.accountSnapshots };
    if (state.activeAccountId) {
      nextSnapshots[state.activeAccountId] = snapshotFromActive(state);
    }
    const incoming = accountId ? nextSnapshots[accountId] ?? null : null;
    const view = viewFromSnapshot(incoming);

    set({
      accountSnapshots: nextSnapshots,
      activeAccountId: accountId,
      ...view,
      // UI state is reset on switch — search/filters and pending undo belong
      // to the previous account's intent.
      searchQuery: '',
      filters: {},
      pendingUndo: null,
      error: null,
      loading: false,
    });
  },

  removeAccount: (accountId) => {
    const state = get();
    const { [accountId]: _drop, ...rest } = state.accountSnapshots;
    if (state.activeAccountId === accountId) {
      set({
        accountSnapshots: rest,
        activeAccountId: null,
        mailboxes: [],
        mailboxState: undefined,
        emailState: undefined,
        currentMailboxId: null,
        mailboxSnapshots: {},
        emails: [],
        totalEmails: 0,
        queryState: undefined,
        searchQuery: '',
        filters: {},
        pendingUndo: null,
      });
    } else {
      set({ accountSnapshots: rest });
    }
  },

  clearAllAccounts: () => {
    set({
      accountSnapshots: {},
      activeAccountId: null,
      mailboxes: [],
      mailboxState: undefined,
      emailState: undefined,
      currentMailboxId: null,
      mailboxSnapshots: {},
      emails: [],
      totalEmails: 0,
      queryState: undefined,
      searchQuery: '',
      filters: {},
      pendingUndo: null,
      error: null,
      loading: false,
    });
  },

  fetchMailboxes: async () => {
    // Skip silently when there's no live session. Screens fire this from
    // mount-time useEffects, and on cold start App.tsx renders MainTabs
    // before restoreSession() finishes; without this guard the underlying
    // API call would throw "Not authenticated - call connect() first" and
    // surface as a user-visible error before the real fetch (kicked off by
    // refetchFeatureStores() once the session is live) replaces it.
    if (!jmapClient.isConnected) return;

    const prevState = get().mailboxState;
    try {
      // Incremental path: ask for just what changed since last time. Fall
      // through to a full refetch when the server can't compute the diff or
      // we have no previous state to compare against.
      if (prevState) {
        const changes = await getMailboxChanges(prevState);
        if (changes) {
          // No changes at all — keep the cached list, just bump the state.
          if (
            changes.created.length === 0 &&
            changes.updated.length === 0 &&
            changes.destroyed.length === 0
          ) {
            set({ mailboxState: changes.newState });
            return;
          }
          const toFetch = [...changes.created, ...changes.updated];
          const fetched = toFetch.length > 0
            ? (await getMailboxesByIds(toFetch)).list
            : [];
          const destroyed = new Set(changes.destroyed);
          const byId = new Map<string, Mailbox>();
          for (const m of get().mailboxes) byId.set(m.id, m);
          for (const m of fetched) byId.set(m.id, m);
          for (const id of destroyed) byId.delete(id);
          set({
            mailboxes: Array.from(byId.values()),
            mailboxState: changes.hasMoreChanges ? prevState : changes.newState,
          });
          // hasMoreChanges = there are still pending changes past the
          // server's response cap. Run the same path again to drain.
          if (changes.hasMoreChanges) {
            void get().fetchMailboxes();
          }
          return;
        }
        // changes === null → cannotCalculateChanges. Fall through to full.
      }

      const { list, state } = await getMailboxesWithState();
      set({ mailboxes: list, mailboxState: state });
    } catch (err) {
      console.warn('[email-store] fetchMailboxes failed:', err);
      // Don't overwrite the cached list on a transient failure — the user
      // can still navigate folders. Only surface the error when we have no
      // mailboxes at all to show.
      if (get().mailboxes.length === 0) {
        set({ error: err instanceof Error ? err.message : 'Failed to load mailboxes' });
      }
    }
  },

  selectMailbox: async (mailboxId) => {
    const state = get();
    // Tuck the previously-visible mailbox into its snapshot so a return-trip
    // can restore it without a network call. Only do this for the base view —
    // a filter or search makes the visible list unrepresentative of the
    // cached "no-filter" snapshot.
    let mailboxSnapshots = state.mailboxSnapshots;
    if (
      state.currentMailboxId &&
      state.currentMailboxId !== mailboxId &&
      isBaseView(state.searchQuery, state.filters)
    ) {
      mailboxSnapshots = {
        ...mailboxSnapshots,
        [state.currentMailboxId]: {
          emails: state.emails,
          total: state.totalEmails,
          queryState: state.queryState,
        },
      };
    }

    const incoming = mailboxSnapshots[mailboxId];
    // Swap to the new mailbox's cached view immediately. If there's no
    // snapshot, fall through to the offline cache as a second-best seed;
    // if that's also empty we render the empty-state, not a spinner over
    // a blank list — better than the previous flash to "Loading…".
    let seededEmails: Email[] = incoming?.emails ?? [];
    let seededTotal = incoming?.total ?? 0;
    let seededQueryState = incoming?.queryState;

    if (seededEmails.length === 0) {
      const cacheStore = useOfflineCacheStore.getState();
      if (!cacheStore.hydrated) await cacheStore.hydrate();
      if (cacheStore.totalCount() > 0) {
        try {
          const limit = useSettingsStore.getState().emailsPerPage;
          seededEmails = await cacheStore.getEmailsInMailbox(mailboxId, Math.max(limit, 50));
          seededTotal = seededEmails.length;
        } catch (err) {
          console.warn('[email-store] cache seed failed:', err);
        }
      }
    }

    set({
      currentMailboxId: mailboxId,
      emails: seededEmails,
      totalEmails: seededTotal,
      queryState: seededQueryState,
      mailboxSnapshots,
      loading: true,
      error: null,
      searchQuery: '',
      filters: {},
      pendingUndo: null,
    });

    // Stop here if there's no live session yet — the cached seed already
    // gave the user something to look at, and the refetch driven by
    // restoreSession() / switchAccount will run the network half once the
    // client is connected.
    if (!jmapClient.isConnected) {
      set({ loading: false });
      return;
    }

    await get().refreshEmails();
  },

  loadMoreEmails: async () => {
    const { currentMailboxId, emails, totalEmails, loading, searchQuery, filters } = get();
    if (!currentMailboxId || loading || emails.length >= totalEmails) return;
    if (!jmapClient.isConnected) return;

    set({ loading: true });
    try {
      const filter = buildJmapFilter(currentMailboxId, searchQuery, filters);
      const limit = useSettingsStore.getState().emailsPerPage;
      const { ids } = await queryEmails(currentMailboxId, {
        position: emails.length,
        limit,
        filter,
      });
      const newEmails = ids.length > 0 ? await fetchEmailsChunked(ids) : [];
      const merged = [...emails, ...newEmails];
      const updates: Partial<EmailState> = { emails: merged, loading: false };
      if (isBaseView(searchQuery, filters)) {
        updates.mailboxSnapshots = {
          ...get().mailboxSnapshots,
          [currentMailboxId]: {
            emails: merged,
            total: get().totalEmails,
            queryState: get().queryState,
          },
        };
      }
      set(updates);
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load more' });
    }
  },

  refreshEmails: async () => {
    const state = get();
    const { currentMailboxId, searchQuery, filters, emails: existing, queryState, emailState } = state;
    if (!currentMailboxId) return;
    if (!jmapClient.isConnected) return;
    set({ loading: true, error: null });

    const filter = buildJmapFilter(currentMailboxId, searchQuery, filters);
    const limit = useSettingsStore.getState().emailsPerPage;
    const baseView = isBaseView(searchQuery, filters);

    try {
      // Incremental sync path: requires the base unfiltered view AND a known
      // queryState (so Email/queryChanges has something to diff against).
      // Anything else — search, filter active, first-ever load — falls
      // through to a full re-query.
      if (baseView && queryState) {
        const queryChanges = await getEmailQueryChanges(currentMailboxId, queryState, {
          filter: undefined,
        });
        if (queryChanges) {
          // What's in the visible window now: drop removed ids, then apply
          // added (id, index) entries. Newly added ids need bodies fetched.
          const removed = new Set(queryChanges.removed);
          const addedIds = queryChanges.added.map((a) => a.id);

          // Email/changes catches updates to messages already in our list
          // (e.g. another device toggled $seen) that queryChanges wouldn't
          // report. Skipped when we have no emailState yet — first refresh
          // after a cold start primes it from the Email/get below.
          let updatedIds: string[] = [];
          let destroyedExtra: string[] = [];
          let nextEmailState: string | undefined = emailState;
          if (emailState) {
            const ec = await getEmailChanges(emailState);
            if (ec) {
              updatedIds = ec.updated;
              destroyedExtra = ec.destroyed;
              nextEmailState = ec.newState;
            } else {
              // cannotCalculateChanges → forget the state and rely on the
              // next full re-sync to repopulate it.
              nextEmailState = undefined;
            }
          }

          // Fetch only what we don't already have. `addedIds` are new to the
          // window; `updatedIds` may already be in `existing` but their
          // keywords/mailboxIds need refreshing.
          const existingById = new Map(existing.map((e) => [e.id, e]));
          const idsToFetch = [
            ...addedIds.filter((id) => !existingById.has(id)),
            ...updatedIds.filter((id) => existingById.has(id)),
          ];
          let fetchState: string | undefined;
          let fetched: Email[] = [];
          if (idsToFetch.length > 0) {
            const res = await getEmailsWithState(idsToFetch);
            fetched = res.list;
            fetchState = res.state;
          }

          // Rebuild the visible window order: start with existing emails,
          // drop removed/destroyed, then splice added at their indices.
          const allDestroyed = new Set([...destroyedExtra, ...removed]);
          const kept = existing.filter((e) => !allDestroyed.has(e.id));
          // Map updated entries onto kept array
          const fetchedById = new Map(fetched.map((e) => [e.id, e]));
          const updatedKept = kept.map((e) => fetchedById.get(e.id) ?? e);

          // Insert added entries at the indices the server gave us. Sort
          // ascending by index so each splice lands at the right offset.
          const sortedAdded = [...queryChanges.added].sort((a, b) => a.index - b.index);
          const out = [...updatedKept];
          for (const entry of sortedAdded) {
            const email = fetchedById.get(entry.id);
            if (!email) continue;
            const idx = Math.min(entry.index, out.length);
            out.splice(idx, 0, email);
          }
          // Cap the visible list to the user's page size — Email/queryChanges
          // can push entries past the original window if many were added.
          const trimmed = out.slice(0, Math.max(limit, out.length));

          const nextQueryState = queryChanges.newQueryState;
          const nextTotal = queryChanges.total;

          if (get().currentMailboxId !== currentMailboxId) return;

          set({
            emails: trimmed,
            totalEmails: nextTotal,
            queryState: nextQueryState,
            emailState: nextEmailState ?? fetchState ?? emailState,
            loading: false,
            mailboxSnapshots: {
              ...get().mailboxSnapshots,
              [currentMailboxId]: {
                emails: trimmed,
                total: nextTotal,
                queryState: nextQueryState,
              },
            },
          });
          return;
        }
        // queryChanges === null → cannotCalculateChanges. Drop our queryState
        // and fall through to a full re-query, which will repopulate it.
      }

      // Full re-query path. Used when there's no prior queryState, when the
      // user has search/filters active (queryState only tracks the base
      // query), or when the server returned cannotCalculateChanges above.
      const queryRes = await queryEmails(currentMailboxId, { limit, filter });
      const fetched = queryRes.ids.length > 0
        ? await getEmailsWithState(queryRes.ids)
        : { list: [], state: undefined as string | undefined };

      if (get().currentMailboxId !== currentMailboxId) return;

      const updates: Partial<EmailState> = {
        emails: fetched.list,
        totalEmails: queryRes.total,
        loading: false,
      };
      if (baseView) {
        updates.queryState = queryRes.queryState;
        updates.emailState = fetched.state;
        updates.mailboxSnapshots = {
          ...get().mailboxSnapshots,
          [currentMailboxId]: {
            emails: fetched.list,
            total: queryRes.total,
            queryState: queryRes.queryState,
          },
        };
      }
      set(updates);
    } catch (err) {
      console.warn('[email-store] refreshEmails failed:', err);
      if (get().currentMailboxId !== currentMailboxId) return;
      // Keep whatever's visible; only surface the error when the list is
      // empty. With cached emails on screen the OfflineBanner already
      // tells the user the data is stale.
      if (existing.length === 0) {
        try {
          const cacheStore = useOfflineCacheStore.getState();
          if (!cacheStore.hydrated) await cacheStore.hydrate();
          if (cacheStore.totalCount() > 0) {
            const cached = await cacheStore.getEmailsInMailbox(
              currentMailboxId,
              Math.max(limit, 50),
            );
            if (get().currentMailboxId === currentMailboxId && cached.length > 0) {
              set({ emails: cached, totalEmails: cached.length, loading: false, error: null });
              return;
            }
          }
        } catch (cacheErr) {
          console.warn('[email-store] refresh cache fallback failed:', cacheErr);
        }
      }
      set({
        loading: false,
        error: existing.length > 0 ? null : (err instanceof Error ? err.message : 'Failed to load emails'),
      });
    }
  },

  handleStateChange: async (change) => {
    if (!jmapClient.currentSession) return;
    const accountId = jmapClient.accountId;
    const accountChanges = change.changed?.[accountId];
    if (!accountChanges) return;

    const mailboxChanged = 'Mailbox' in accountChanges;
    const emailChanged = 'Email' in accountChanges || 'EmailDelivery' in accountChanges;
    if (!mailboxChanged && !emailChanged) return;

    if (mailboxChanged) {
      await get().fetchMailboxes();
    }
    if (emailChanged && get().currentMailboxId) {
      await get().refreshEmails();
    }
  },

  setSearchQuery: (query) => {
    set({ searchQuery: query });
    void get().refreshEmails();
  },

  setFilters: (filters) => {
    set({ filters });
    void get().refreshEmails();
  },

  clearSearchAndFilters: () => {
    const { searchQuery, filters } = get();
    if (!searchQuery && Object.keys(filters).length === 0) return;
    set({ searchQuery: '', filters: {} });
    void get().refreshEmails();
  },

  getEmailDetail: async (id) => {
    // Try the network first so the user sees fresh keywords/flags. If that
    // fails (offline / server unreachable), fall back to the offline cache
    // when the message is in it. Without the cache hit, propagate the error
    // so the caller can surface it.
    try {
      const fresh = await getFullEmail(id);
      // Opportunistically refresh the cached copy so the next offline open
      // reflects the latest keywords without needing a full sync.
      const cache = useOfflineCacheStore.getState();
      if (cache.has(id)) {
        try {
          const size = JSON.stringify(fresh).length;
          await cache.put(fresh, size);
        } catch { /* ignore — best-effort refresh */ }
      }
      return fresh;
    } catch (err) {
      const cached = await useOfflineCacheStore.getState().get(id);
      if (cached) return cached;
      throw err;
    }
  },

  markRead: async (emailId) => {
    const email = get().emails.find((e) => e.id === emailId);
    const nextKeywords = { ...(email?.keywords ?? {}), $seen: true };
    await setEmailKeywords(emailId, nextKeywords);
    set({
      emails: get().emails.map((e) =>
        e.id === emailId ? { ...e, keywords: nextKeywords } : e,
      ),
    });
  },

  markUnread: async (emailId) => {
    const email = get().emails.find((e) => e.id === emailId);
    if (!email) return;
    const { $seen, ...rest } = email.keywords;
    await setEmailKeywords(emailId, rest);
    set({
      emails: get().emails.map((e) =>
        e.id === emailId ? { ...e, keywords: rest } : e,
      ),
    });
  },

  toggleStar: async (emailId, starred) => {
    const email = get().emails.find((e) => e.id === emailId);
    if (!email) return;
    const keywords = { ...email.keywords };
    if (starred) {
      keywords.$flagged = true;
    } else {
      delete keywords.$flagged;
    }
    await setEmailKeywords(emailId, keywords);
    set({
      emails: get().emails.map((e) =>
        e.id === emailId ? { ...e, keywords } : e,
      ),
    });
  },

  togglePin: async (emailId, pinned) => {
    const email = get().emails.find((e) => e.id === emailId);
    if (!email) return;
    const keywords = { ...email.keywords };
    if (pinned) {
      keywords.$important = true;
    } else {
      delete keywords.$important;
    }
    await setEmailKeywords(emailId, keywords);
    set({
      emails: get().emails.map((e) =>
        e.id === emailId ? { ...e, keywords } : e,
      ),
    });
  },

  moveToMailbox: async (emailId, fromMailboxId, toMailboxId) => {
    const email = get().emails.find((e) => e.id === emailId);
    const original = email ? { ...email.mailboxIds } : null;

    await moveEmail(emailId, fromMailboxId, toMailboxId);
    set({ emails: get().emails.filter((e) => e.id !== emailId) });

    if (email && original) {
      const targetName = get().mailboxes.find((m) => m.id === toMailboxId)?.name;
      set({
        pendingUndo: {
          kind: 'move',
          label: targetName ? `Email moved to ${targetName}` : 'Email moved',
          createdAt: Date.now(),
          items: [{ email, originalMailboxIds: original }],
        },
      });
    }
  },

  archiveEmail: async (emailId) => {
    const { emails, mailboxes } = get();
    const email = emails.find((e) => e.id === emailId);
    if (!email) return;

    const archiveMailbox = mailboxes.find(
      (m) => m.role === 'archive' || m.name.toLowerCase() === 'archive',
    );
    if (!archiveMailbox) return;
    if (email.mailboxIds?.[archiveMailbox.id]) return;

    const mode = useSettingsStore.getState().archiveMode;
    const original = { ...email.mailboxIds };

    await apiArchiveEmails(
      [{ id: email.id, receivedAt: email.receivedAt }],
      archiveMailbox.id,
      mode,
      mailboxes,
    );

    set({
      emails: get().emails.filter((e) => e.id !== emailId),
      pendingUndo: {
        kind: 'archive',
        label: 'Email archived',
        createdAt: Date.now(),
        items: [{ email, originalMailboxIds: original }],
      },
    });

    // Auto-sort modes may have created new year/month folders - refresh the
    // mailbox list so the sidebar picks them up on the next render.
    if (mode !== 'single') {
      void get().fetchMailboxes();
    }
  },

  deleteEmail: async (emailId, trashMailboxId, currentMailboxId) => {
    const email = get().emails.find((e) => e.id === emailId);
    const original = email ? { ...email.mailboxIds } : null;
    const settings = useSettingsStore.getState();
    const { mailboxes } = get();
    const junkMailbox = mailboxes.find((m) => m.role === 'junk' || m.role === 'spam');
    const inJunk = !!(junkMailbox && email?.mailboxIds?.[junkMailbox.id]);
    const inTrash = currentMailboxId === trashMailboxId;

    // Resolve effective destination:
    // - already in trash → must destroy (no further folder to move to)
    // - in junk and the user opted to skip the trash for junk → destroy
    // - the user set 'permanent' as the global default → destroy
    // - otherwise → move to trash and offer undo
    const destroy =
      inTrash ||
      settings.deleteAction === 'permanent' ||
      (settings.permanentlyDeleteJunk && inJunk);

    if (destroy) {
      // Use the trash mailbox as the "current" so apiDeleteEmail takes the
      // destroy branch even when the source folder isn't trash.
      await apiDeleteEmail(emailId, trashMailboxId, trashMailboxId);
    } else {
      await apiDeleteEmail(emailId, trashMailboxId, currentMailboxId);
    }
    set({ emails: get().emails.filter((e) => e.id !== emailId) });

    // Permanent destroy can't be undone - skip the snackbar so we don't
    // promise an undo we can't deliver.
    if (email && original && !destroy) {
      set({
        pendingUndo: {
          kind: 'delete',
          label: 'Email moved to Trash',
          createdAt: Date.now(),
          items: [{ email, originalMailboxIds: original }],
        },
      });
    }
  },

  undoLast: async () => {
    const entry = get().pendingUndo;
    if (!entry) return;
    set({ pendingUndo: null });

    try {
      await restoreEmailMailboxes(
        entry.items.map((it) => ({ id: it.email.id, mailboxIds: it.originalMailboxIds })),
      );
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Undo failed' });
      return;
    }

    // Re-insert each restored email into the visible list if its original
    // mailboxIds include the current view. Server is the source of truth for
    // ordering, but local re-insertion gives the user instant feedback.
    const { currentMailboxId, emails } = get();
    if (currentMailboxId) {
      const restored = entry.items
        .filter((it) => it.originalMailboxIds[currentMailboxId])
        .map((it) => ({ ...it.email, mailboxIds: it.originalMailboxIds }));
      if (restored.length > 0) {
        const merged = [...restored, ...emails].sort(
          (a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime(),
        );
        set({ emails: merged });
      }
    }
  },

  clearUndo: () => set({ pendingUndo: null }),

  searchEmails: async (query) => {
    const ids = await apiSearchEmails(query);
    if (ids.length === 0) return [];
    return fetchEmails(ids);
  },

  reset: () => set({
    mailboxes: [],
    mailboxState: undefined,
    emailState: undefined,
    currentMailboxId: null,
    mailboxSnapshots: {},
    emails: [],
    totalEmails: 0,
    queryState: undefined,
    loading: false,
    error: null,
    searchQuery: '',
    filters: {},
  }),
    }),
    {
      // Persist the per-account caches and the active view so the UI can
      // render instantly on re-open / account switch, before the JMAP
      // session has finished restoring. auth-store triggers a background
      // refresh once the session is ready.
      name: 'email-cache',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        accountSnapshots: state.accountSnapshots,
        activeAccountId: state.activeAccountId,
        mailboxes: state.mailboxes,
        mailboxState: state.mailboxState,
        emailState: state.emailState,
        currentMailboxId: state.currentMailboxId,
        mailboxSnapshots: state.mailboxSnapshots,
        emails: state.emails,
        totalEmails: state.totalEmails,
        queryState: state.queryState,
      }),
    },
  ),
);
