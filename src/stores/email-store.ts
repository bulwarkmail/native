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
  importEmailBlob,
  setEmailKeywords,
  setKeywordsForEmails,
  moveEmail,
  moveEmails as apiMoveEmails,
  archiveEmails as apiArchiveEmails,
  deleteEmail as apiDeleteEmail,
  deleteEmails as apiDeleteEmails,
  restoreEmailMailboxes,
  searchEmails as apiSearchEmails,
} from '../api/email';
import { toWildcardQuery } from '../lib/search-utils';
import { generateAccountId } from '../lib/account-utils';
import { useSettingsStore } from './settings-store';
import { useOfflineCacheStore } from './offline-cache-store';
import { useOutboxStore, applyOrQueue, applyOrQueueBatch, type OutboxOp } from './outbox-store';

// Keep the offline body cache consistent with an optimistic/queued mutation so
// re-opening a message while offline shows the change. Fire-and-forget.
function patchCache(id: string, changes: { keywords?: Record<string, boolean>; mailboxIds?: Record<string, boolean> }): void {
  void useOfflineCacheStore.getState().patch(id, changes);
}
function dropFromCache(ids: string[]): void {
  void useOfflineCacheStore.getState().remove(ids);
}
// Compute an email's full mailboxIds map after removing one mailbox and adding
// another — the idempotent target the outbox replays for a move/trash.
function mailboxesAfterMove(
  current: Record<string, boolean> | undefined,
  fromMailboxId: string | null,
  toMailboxId: string,
): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  for (const [id, present] of Object.entries(current ?? {})) {
    if (present && id !== fromMailboxId) next[id] = true;
  }
  next[toMailboxId] = true;
  return next;
}

// True only when the JMAP client is actually serving the email-store's active
// account. During an account switch there's a window between
// setActiveAccount() (which swaps the email-store view immediately) and
// jmapClient.loadAccount() resolving, when the client is still on the
// *previous* account. Without this guard, any fetchMailboxes/refreshEmails
// fired in that window (e.g. by an EmailListScreen useEffect reacting to
// the empty new-account view) would return the previous account's data and
// stamp it into the new account's snapshot.
function jmapClientServesActiveAccount(activeAccountId: string | null): boolean {
  if (!activeAccountId) return false;
  if (!jmapClient.isConnected) return false;
  const username = jmapClient.username;
  const serverUrl = jmapClient.serverUrl;
  if (!username || !serverUrl) return false;
  return generateAccountId(username, serverUrl) === activeAccountId;
}

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
  importEmails: (
    files: { uri: string; name: string; mimeType?: string }[],
    mailboxId: string,
  ) => Promise<{ imported: number; failed: number }>;
  handleStateChange: (change: StateChange) => Promise<void>;
  getEmailDetail: (id: string, accountId?: string) => Promise<Email>;
  markRead: (emailId: string, accountId?: string) => Promise<void>;
  markUnread: (emailId: string) => Promise<void>;
  toggleStar: (emailId: string, starred: boolean) => Promise<void>;
  togglePin: (emailId: string, pinned: boolean) => Promise<void>;
  moveToMailbox: (emailId: string, fromMailboxId: string, toMailboxId: string) => Promise<void>;
  archiveEmail: (emailId: string) => Promise<void>;
  deleteEmail: (emailId: string, trashMailboxId: string, currentMailboxId: string) => Promise<void>;
  // ── Batch (multi-select) actions ──────────────────────────────
  archiveEmailsBatch: (emailIds: string[]) => Promise<void>;
  moveEmailsToMailbox: (emailIds: string[], toMailboxId: string) => Promise<void>;
  deleteEmailsBatch: (emailIds: string[], trashMailboxId: string, currentMailboxId: string) => Promise<void>;
  setKeywordForEmails: (emailIds: string[], token: string, on: boolean) => Promise<void>;
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

// View fields to apply when returning from a search/filter to the base view:
// the cached base-view snapshot, shown immediately so the list doesn't keep
// displaying search results while the refresh is in flight (issue #10).
function restoredBaseView(state: EmailState): Partial<EmailState> {
  const snap = state.currentMailboxId
    ? state.mailboxSnapshots[state.currentMailboxId]
    : undefined;
  if (!snap) return {};
  return { emails: snap.emails, totalEmails: snap.total, queryState: snap.queryState };
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

    // Point the offline body cache at the same account so getEmailDetail's
    // fallback and selectMailbox's seed read from the right bucket. Fire-
    // and-forget — the cache returns empty until hydration completes,
    // which is the correct degraded behaviour.
    void useOfflineCacheStore.getState().setAccount(accountId);
    // Load the new account's outbox and try to drain it (no-op when offline or
    // the JMAP client isn't serving this account yet).
    void useOutboxStore.getState().setAccount(accountId).then(() => {
      void useOutboxStore.getState().flush();
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
      void useOfflineCacheStore.getState().setAccount(null);
      void useOutboxStore.getState().setAccount(null);
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
    void useOfflineCacheStore.getState().setAccount(null);
    void useOutboxStore.getState().setAccount(null);
  },

  fetchMailboxes: async () => {
    // Skip silently when there's no live session, or when jmapClient is
    // mid-transition to a different account (see jmapClientServesActiveAccount).
    // Screens fire this from mount-time useEffects, and on cold start
    // App.tsx renders MainTabs before restoreSession() finishes; without
    // this guard the underlying API call would either throw "Not
    // authenticated - call connect() first" or — worse, during an account
    // switch — return the *previous* account's mailboxes and stamp them
    // into the new account's snapshot.
    const activeAccountId = get().activeAccountId;
    if (!jmapClientServesActiveAccount(activeAccountId)) return;

    const prevState = get().mailboxState;
    try {
      // Incremental path: ask for just what changed since last time. Fall
      // through to a full refetch when the server can't compute the diff or
      // we have no previous state to compare against.
      if (prevState) {
        const changes = await getMailboxChanges(prevState);
        // Bail if the user switched accounts during the await — anything we
        // set() now would land in the wrong account's bucket.
        if (get().activeAccountId !== activeAccountId) return;
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
          if (get().activeAccountId !== activeAccountId) return;
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
      if (get().activeAccountId !== activeAccountId) return;
      set({ mailboxes: list, mailboxState: state });
    } catch (err) {
      console.warn('[email-store] fetchMailboxes failed:', err);
      if (get().activeAccountId !== activeAccountId) return;
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

    // Stop here if there's no live session OR jmapClient is mid-transition
    // to a different account. The cached seed already gave the user
    // something to look at, and the refetch driven by restoreSession() /
    // switchAccount will run the network half once the client catches up.
    if (!jmapClientServesActiveAccount(get().activeAccountId)) {
      set({ loading: false });
      return;
    }

    await get().refreshEmails();
  },

  loadMoreEmails: async () => {
    const { currentMailboxId, emails, totalEmails, loading, searchQuery, filters, activeAccountId } = get();
    if (!currentMailboxId || loading || emails.length >= totalEmails) return;
    if (!jmapClientServesActiveAccount(activeAccountId)) return;

    set({ loading: true });
    try {
      const filter = buildJmapFilter(currentMailboxId, searchQuery, filters);
      const limit = useSettingsStore.getState().emailsPerPage;
      const { ids } = await queryEmails(currentMailboxId, {
        position: emails.length,
        limit,
        filter,
      });
      if (get().activeAccountId !== activeAccountId || get().currentMailboxId !== currentMailboxId) return;
      const newEmails = ids.length > 0 ? await fetchEmailsChunked(ids) : [];
      if (get().activeAccountId !== activeAccountId || get().currentMailboxId !== currentMailboxId) return;
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
      if (get().activeAccountId !== activeAccountId) return;
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load more' });
    }
  },

  importEmails: async (files, mailboxId) => {
    // Loaded lazily so the store module stays free of expo-file-system at
    // import time (that native dep can't load in the test/SSR environment).
    const { uploadBytes } = await import('../api/blob');
    const { expandImportableEml } = await import('../lib/eml-import');
    let imported = 0;
    let failed = 0;
    for (const file of files) {
      try {
        // A .eml expands to one message; a .zip to one per .eml it contains.
        const emls = await expandImportableEml(file.uri, file.name, file.mimeType);
        if (emls.length === 0) failed += 1;
        for (const eml of emls) {
          try {
            const { blobId } = await uploadBytes(eml.bytes, 'message/rfc822');
            await importEmailBlob(blobId, mailboxId);
            imported += 1;
          } catch {
            failed += 1;
          }
        }
      } catch {
        failed += 1;
      }
    }
    // Surface freshly imported messages if we imported into the open mailbox.
    if (imported > 0 && get().currentMailboxId === mailboxId) {
      await get().refreshEmails();
    }
    return { imported, failed };
  },

  refreshEmails: async () => {
    const state = get();
    const { currentMailboxId, searchQuery, filters, emails: existing, emailState, activeAccountId } = state;
    if (!currentMailboxId) return;
    if (!jmapClientServesActiveAccount(activeAccountId)) return;
    set({ loading: true, error: null });

    const filter = buildJmapFilter(currentMailboxId, searchQuery, filters);
    const limit = useSettingsStore.getState().emailsPerPage;
    const baseView = isBaseView(searchQuery, filters);

    // A response that lands after the user switched account/mailbox or
    // changed search/filters must not overwrite the newer view.
    const viewChanged = () =>
      get().activeAccountId !== activeAccountId ||
      get().currentMailboxId !== currentMailboxId ||
      get().searchQuery !== searchQuery ||
      get().filters !== filters;

    // The incremental path diffs against the *base-view* list, which lives in
    // the per-mailbox snapshot — NOT `emails`, which may still hold search or
    // filter results (right after clearing a search, or after a cold start
    // that rehydrated a persisted search-result list). Diffing against a
    // non-base list lets Email/queryChanges "confirm" the search results as
    // the whole mailbox and bakes them into the snapshot (issue #10). The
    // snapshot is only trusted when its window is plausibly complete —
    // anything shorter can't be patched incrementally and needs the full
    // re-query below to rebuild it.
    const snap = state.mailboxSnapshots[currentMailboxId];

    try {
      // Incremental sync path: requires the base unfiltered view AND a known
      // queryState (so Email/queryChanges has something to diff against).
      // Anything else — search, filter active, first-ever load — falls
      // through to a full re-query.
      if (
        baseView &&
        snap?.queryState &&
        snap.emails.length >= Math.min(limit, snap.total)
      ) {
        const baseEmails = snap.emails;
        const queryChanges = await getEmailQueryChanges(currentMailboxId, snap.queryState, {
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
          // window; `updatedIds` may already be in the base list but their
          // keywords/mailboxIds need refreshing.
          const existingById = new Map(baseEmails.map((e) => [e.id, e]));
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
          const kept = baseEmails.filter((e) => !allDestroyed.has(e.id));
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

          if (viewChanged()) return;

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

      if (viewChanged()) return;

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
      if (get().activeAccountId !== activeAccountId || get().currentMailboxId !== currentMailboxId) return;
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
            if (
              get().activeAccountId === activeAccountId &&
              get().currentMailboxId === currentMailboxId &&
              cached.length > 0
            ) {
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
    // Drop changes that arrived for a different account than the one we're
    // currently showing (e.g. push notifications received during/just after
    // an account switch).
    if (!jmapClientServesActiveAccount(get().activeAccountId)) return;
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
    const state = get();
    const backToBase =
      !isBaseView(state.searchQuery, state.filters) && isBaseView(query, state.filters);
    set({
      searchQuery: query,
      ...(backToBase ? restoredBaseView(state) : {}),
    });
    void get().refreshEmails();
  },

  setFilters: (filters) => {
    const state = get();
    const backToBase =
      !isBaseView(state.searchQuery, state.filters) && isBaseView(state.searchQuery, filters);
    set({
      filters,
      ...(backToBase ? restoredBaseView(state) : {}),
    });
    void get().refreshEmails();
  },

  clearSearchAndFilters: () => {
    const state = get();
    if (!state.searchQuery && Object.keys(state.filters).length === 0) return;
    set({ searchQuery: '', filters: {}, ...restoredBaseView(state) });
    void get().refreshEmails();
  },

  getEmailDetail: async (id, accountId) => {
    // Try the network first so the user sees fresh keywords/flags. If that
    // fails (offline / server unreachable), fall back to the offline cache
    // when the message is in it. Without the cache hit, propagate the error
    // so the caller can surface it. `accountId` targets a group/shared inbox
    // message opened from the unified view.
    try {
      const fresh = await getFullEmail(id, accountId);
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

  markRead: async (emailId, accountId) => {
    const email = get().emails.find((e) => e.id === emailId);
    const nextKeywords = { ...(email?.keywords ?? {}), $seen: true };
    // A group/shared message opened from the unified inbox lives under another
    // JMAP account and isn't in the active list/cache or the (account-scoped)
    // offline queue — mark it read directly against its owning account.
    if (accountId && !email) {
      await setEmailKeywords(emailId, nextKeywords, accountId);
      return;
    }
    await applyOrQueue({ kind: 'keywords', emailId, keywords: nextKeywords });
    set({
      emails: get().emails.map((e) =>
        e.id === emailId ? { ...e, keywords: nextKeywords } : e,
      ),
    });
    patchCache(emailId, { keywords: nextKeywords });
  },

  markUnread: async (emailId) => {
    const email = get().emails.find((e) => e.id === emailId);
    if (!email) return;
    const { $seen, ...rest } = email.keywords;
    await applyOrQueue({ kind: 'keywords', emailId, keywords: rest });
    set({
      emails: get().emails.map((e) =>
        e.id === emailId ? { ...e, keywords: rest } : e,
      ),
    });
    patchCache(emailId, { keywords: rest });
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
    await applyOrQueue({ kind: 'keywords', emailId, keywords });
    set({
      emails: get().emails.map((e) =>
        e.id === emailId ? { ...e, keywords } : e,
      ),
    });
    patchCache(emailId, { keywords });
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
    await applyOrQueue({ kind: 'keywords', emailId, keywords });
    set({
      emails: get().emails.map((e) =>
        e.id === emailId ? { ...e, keywords } : e,
      ),
    });
    patchCache(emailId, { keywords });
  },

  moveToMailbox: async (emailId, fromMailboxId, toMailboxId) => {
    const email = get().emails.find((e) => e.id === emailId);
    const original = email ? { ...email.mailboxIds } : null;
    const target = mailboxesAfterMove(email?.mailboxIds, fromMailboxId, toMailboxId);

    await applyOrQueue(
      { kind: 'mailboxes', emailId, mailboxIds: target },
      () => moveEmail(emailId, fromMailboxId, toMailboxId),
    );
    set({ emails: get().emails.filter((e) => e.id !== emailId) });
    patchCache(emailId, { mailboxIds: target });

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

    // Online keeps the rich year/month auto-foldering. Offline degrades to the
    // archive root (we can't create folders without a connection); the queued
    // op replays as a plain move into Archive.
    const { queued } = await applyOrQueue(
      { kind: 'mailboxes', emailId, mailboxIds: { [archiveMailbox.id]: true } },
      () => apiArchiveEmails(
        [{ id: email.id, receivedAt: email.receivedAt }],
        archiveMailbox.id,
        mode,
        mailboxes,
      ),
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
    patchCache(emailId, { mailboxIds: { [archiveMailbox.id]: true } });

    // Auto-sort modes may have created new year/month folders - refresh the
    // mailbox list so the sidebar picks them up on the next render. Skip when
    // the action was only queued (no folders were created offline).
    if (mode !== 'single' && !queued) {
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
      await applyOrQueue(
        { kind: 'destroy', emailId },
        () => apiDeleteEmail(emailId, trashMailboxId, trashMailboxId),
      );
      dropFromCache([emailId]);
    } else {
      const target = mailboxesAfterMove(email?.mailboxIds, currentMailboxId, trashMailboxId);
      await applyOrQueue(
        { kind: 'mailboxes', emailId, mailboxIds: target },
        () => apiDeleteEmail(emailId, trashMailboxId, currentMailboxId),
      );
      // "Move to Trash and mark as read" (#323): when the user picked that
      // delete action, also clear unread state for messages moved to trash.
      if (settings.deleteAction === 'trash-and-read' && email && !email.keywords?.$seen) {
        const nextKeywords = { ...email.keywords, $seen: true };
        await applyOrQueue({ kind: 'keywords', emailId, keywords: nextKeywords });
        patchCache(emailId, { mailboxIds: target, keywords: nextKeywords });
      } else {
        patchCache(emailId, { mailboxIds: target });
      }
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

  // ── Batch actions ─────────────────────────────────────────────
  // Each produces a single combined UndoEntry (UndoEntry.items is an array),
  // so a multi-select archive/move/delete is reversed with one snackbar tap.

  archiveEmailsBatch: async (emailIds) => {
    const { emails, mailboxes } = get();
    const archiveMailbox = mailboxes.find(
      (m) => m.role === 'archive' || m.name.toLowerCase() === 'archive',
    );
    if (!archiveMailbox) return;
    const targets = emails.filter(
      (e) => emailIds.includes(e.id) && !e.mailboxIds?.[archiveMailbox.id],
    );
    if (targets.length === 0) return;

    const mode = useSettingsStore.getState().archiveMode;
    const items = targets.map((e) => ({ email: e, originalMailboxIds: { ...e.mailboxIds } }));
    const archiveTarget = { [archiveMailbox.id]: true };

    const { queued } = await applyOrQueueBatch(
      targets.map((e): OutboxOp => ({ kind: 'mailboxes', emailId: e.id, mailboxIds: archiveTarget })),
      () => apiArchiveEmails(
        targets.map((e) => ({ id: e.id, receivedAt: e.receivedAt })),
        archiveMailbox.id,
        mode,
        mailboxes,
      ),
    );

    const removed = new Set(targets.map((e) => e.id));
    set({
      emails: get().emails.filter((e) => !removed.has(e.id)),
      pendingUndo: {
        kind: 'archive',
        label: targets.length === 1 ? 'Email archived' : `${targets.length} emails archived`,
        createdAt: Date.now(),
        items,
      },
    });
    for (const e of targets) patchCache(e.id, { mailboxIds: archiveTarget });

    if (mode !== 'single' && !queued) void get().fetchMailboxes();
  },

  moveEmailsToMailbox: async (emailIds, toMailboxId) => {
    const { emails, currentMailboxId, mailboxes } = get();
    if (!currentMailboxId || toMailboxId === currentMailboxId) return;
    const targets = emails.filter((e) => emailIds.includes(e.id));
    if (targets.length === 0) return;

    const items = targets.map((e) => ({ email: e, originalMailboxIds: { ...e.mailboxIds } }));

    await applyOrQueueBatch(
      targets.map((e): OutboxOp => ({
        kind: 'mailboxes',
        emailId: e.id,
        mailboxIds: mailboxesAfterMove(e.mailboxIds, currentMailboxId, toMailboxId),
      })),
      () => apiMoveEmails(targets.map((e) => e.id), currentMailboxId, toMailboxId),
    );

    const removed = new Set(targets.map((e) => e.id));
    for (const e of targets) {
      patchCache(e.id, { mailboxIds: mailboxesAfterMove(e.mailboxIds, currentMailboxId, toMailboxId) });
    }
    const targetName = mailboxes.find((m) => m.id === toMailboxId)?.name;
    set({
      emails: get().emails.filter((e) => !removed.has(e.id)),
      pendingUndo: {
        kind: 'move',
        label: targetName
          ? `${targets.length === 1 ? 'Email' : `${targets.length} emails`} moved to ${targetName}`
          : 'Emails moved',
        createdAt: Date.now(),
        items,
      },
    });
  },

  deleteEmailsBatch: async (emailIds, trashMailboxId, currentMailboxId) => {
    const { emails, mailboxes } = get();
    const settings = useSettingsStore.getState();
    const junkMailbox = mailboxes.find((m) => m.role === 'junk' || m.role === 'spam');
    const inTrash = currentMailboxId === trashMailboxId;
    const targets = emails.filter((e) => emailIds.includes(e.id));
    if (targets.length === 0) return;

    // Split into permanent-destroy vs move-to-trash following the same policy
    // as the single delete: trash folder, global "permanent" default, or the
    // skip-trash-for-junk option each force a destroy.
    const toDestroy: Email[] = [];
    const toTrash: Email[] = [];
    for (const e of targets) {
      const inJunk = !!(junkMailbox && e.mailboxIds?.[junkMailbox.id]);
      const destroy =
        inTrash ||
        settings.deleteAction === 'permanent' ||
        (settings.permanentlyDeleteJunk && inJunk);
      (destroy ? toDestroy : toTrash).push(e);
    }

    // "Move to Trash and mark as read" (#323): also clear unread state for the
    // moved-to-trash messages when that delete action is selected.
    const toMarkRead =
      settings.deleteAction === 'trash-and-read'
        ? toTrash.filter((e) => !e.keywords?.$seen)
        : [];
    const markReadKeywords = new Map(
      toMarkRead.map((e) => [e.id, { ...e.keywords, $seen: true }]),
    );

    const ops: OutboxOp[] = [
      ...toDestroy.map((e): OutboxOp => ({ kind: 'destroy', emailId: e.id })),
      ...toTrash.map((e): OutboxOp => ({
        kind: 'mailboxes',
        emailId: e.id,
        mailboxIds: mailboxesAfterMove(e.mailboxIds, currentMailboxId, trashMailboxId),
      })),
      ...toMarkRead.map((e): OutboxOp => ({
        kind: 'keywords',
        emailId: e.id,
        keywords: markReadKeywords.get(e.id)!,
      })),
    ];
    await applyOrQueueBatch(ops, async () => {
      if (toDestroy.length > 0) {
        await apiDeleteEmails(toDestroy.map((e) => e.id), trashMailboxId, trashMailboxId);
      }
      if (toTrash.length > 0) {
        await apiMoveEmails(toTrash.map((e) => e.id), currentMailboxId, trashMailboxId);
      }
      if (toMarkRead.length > 0) {
        await setKeywordsForEmails(
          toMarkRead.map((e) => ({ id: e.id, keywords: markReadKeywords.get(e.id)! })),
        );
      }
    });

    if (toDestroy.length > 0) dropFromCache(toDestroy.map((e) => e.id));
    for (const e of toTrash) {
      patchCache(e.id, {
        mailboxIds: mailboxesAfterMove(e.mailboxIds, currentMailboxId, trashMailboxId),
        ...(markReadKeywords.has(e.id) ? { keywords: markReadKeywords.get(e.id) } : {}),
      });
    }

    const removed = new Set(targets.map((e) => e.id));
    set({ emails: get().emails.filter((e) => !removed.has(e.id)) });

    // Only the moved-to-trash items are recoverable; destroyed ones are gone.
    if (toTrash.length > 0) {
      set({
        pendingUndo: {
          kind: 'delete',
          label: toTrash.length === 1 ? 'Email moved to Trash' : `${toTrash.length} emails moved to Trash`,
          createdAt: Date.now(),
          items: toTrash.map((e) => ({ email: e, originalMailboxIds: { ...e.mailboxIds } })),
        },
      });
    }
  },

  setKeywordForEmails: async (emailIds, token, on) => {
    const targets = get().emails.filter((e) => emailIds.includes(e.id));
    if (targets.length === 0) return;
    const updates = targets.map((e) => {
      const keywords = { ...e.keywords };
      if (on) keywords[token] = true;
      else delete keywords[token];
      return { id: e.id, keywords };
    });
    await applyOrQueueBatch(
      updates.map((u): OutboxOp => ({ kind: 'keywords', emailId: u.id, keywords: u.keywords })),
      () => setKeywordsForEmails(updates),
    );
    const byId = new Map(updates.map((u) => [u.id, u.keywords]));
    set({
      emails: get().emails.map((e) =>
        byId.has(e.id) ? { ...e, keywords: byId.get(e.id)! } : e,
      ),
    });
    for (const u of updates) patchCache(u.id, { keywords: u.keywords });
  },

  undoLast: async () => {
    const entry = get().pendingUndo;
    if (!entry) return;
    set({ pendingUndo: null });

    try {
      await applyOrQueueBatch(
        entry.items.map((it): OutboxOp => ({
          kind: 'mailboxes',
          emailId: it.email.id,
          mailboxIds: it.originalMailboxIds,
        })),
        () => restoreEmailMailboxes(
          entry.items.map((it) => ({ id: it.email.id, mailboxIds: it.originalMailboxIds })),
        ),
      );
      for (const it of entry.items) {
        patchCache(it.email.id, { mailboxIds: it.originalMailboxIds });
      }
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
      version: 1,
      // v0 → v1: drop every cached queryState. Pre-v1 builds could persist a
      // search-result list next to the base view's queryState, and the
      // incremental sync path would then "confirm" those search results as
      // the whole mailbox and bake them into the snapshot (issue #10).
      // Without a queryState the next refresh does a full re-query, which
      // rebuilds any poisoned window from the server.
      migrate: (persisted, version) => {
        if (version >= 1) return persisted as EmailState;
        const s = persisted as Pick<
          EmailState,
          'accountSnapshots' | 'mailboxSnapshots' | 'queryState'
        > & Record<string, unknown>;
        const stripQueryStates = (
          snaps: Record<string, MailboxSnapshot> | undefined,
        ): Record<string, MailboxSnapshot> =>
          Object.fromEntries(
            Object.entries(snaps ?? {}).map(([id, snap]) => [
              id,
              { ...snap, queryState: undefined },
            ]),
          );
        const accountSnapshots: Record<string, AccountSnapshot> = {};
        for (const [id, acc] of Object.entries(s.accountSnapshots ?? {})) {
          accountSnapshots[id] = {
            ...acc,
            mailboxSnapshots: stripQueryStates(acc.mailboxSnapshots),
          };
        }
        return {
          ...s,
          accountSnapshots,
          mailboxSnapshots: stripQueryStates(s.mailboxSnapshots),
          queryState: undefined,
        } as unknown as EmailState;
      },
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
