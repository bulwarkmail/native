import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { createPersistStorage, memoizeSlice } from './persist-storage';
import { boundEmailCache, type PersistedEmailCache } from './email-cache-persist';
import type { Email, Mailbox, StateChange, Thread } from '../api/types';
import { jmapClient } from '../api/jmap-client';
import {
  getMailboxes as fetchMailboxes,
  getMailboxesWithState,
  getSharedMailboxes,
  getMailboxesByIds,
  getMailboxChanges,
  queryEmailPage,
  getEmailQueryChanges,
  getEmails as fetchEmails,
  getEmailsWithState,
  getEmailChanges,
  getThreads,
  getFullEmail,
  importEmailBlob,
  patchKeywordsForEmails,
  patchKeywordsPerEmail,
  moveEmail,
  moveEmails as apiMoveEmails,
  archiveEmails as apiArchiveEmails,
  deleteEmail as apiDeleteEmail,
  deleteEmails as apiDeleteEmails,
  restoreEmailMailboxes,
  searchEmails as apiSearchEmails,
  markAsSpam as apiMarkAsSpam,
  undoSpam as apiUndoSpam,
  destroyEmails as apiDestroyEmails,
  unprefixMailboxId,
} from '../api/email';
import { useNetworkStore } from './network-store';
import { JMAPMethodError } from '../api/jmap-result';
import { mailboxesForSiblingOf, mailboxesOfAccount, findJunkMailbox } from '../lib/mailbox-tree';
import { toWildcardQuery } from '../lib/search-utils';
import { orderForMailbox, sanitizeSortLevels, type SortLevel } from '../lib/message-list-order';
import { buildListSort, markKeywordSortUnsupported } from '../lib/keyword-sort-polarity';
import { generateAccountId } from '../lib/account-utils';
import { applyKeywordPatch, revertKeywordPatch, type KeywordPatch } from '../lib/keyword-patch';
import { t } from './locale-store';
import { useSettingsStore } from './settings-store';
import { useOfflineCacheStore } from './offline-cache-store';
import { useOutboxStore, applyOrQueue, applyOrQueueBatch, type OutboxOp } from './outbox-store';

// ── Refresh coalescing ─────────────────────────────────────────────────
// Push events, mount effects and post-action follow-ups all call
// fetchMailboxes()/refreshEmails(); overlapping runs only multiply requests
// (and trip maxConcurrentRequests / 429 on Stalwart). Share the in-flight run
// per key and queue at most one re-run, like the webmail's `coalesceRefresh`
// (#780).
const inflightRefresh = new Map<string, Promise<void>>();
const queuedRefresh = new Set<string>();

function coalesceRefresh(key: string, run: () => Promise<void>): Promise<void> {
  const current = inflightRefresh.get(key);
  if (current) {
    queuedRefresh.add(key);
    return current;
  }
  const p = (async () => {
    try {
      await run();
    } finally {
      inflightRefresh.delete(key);
      if (queuedRefresh.delete(key)) void coalesceRefresh(key, run);
    }
  })();
  inflightRefresh.set(key, p);
  return p;
}

// Accounts that already got their one automatic mailbox re-fetch after an
// empty/failed first load (Stalwart provisions folders lazily at first login,
// #217). Keyed by the registry account id.
const provisionRetried = new Set<string>();

// Keep the offline body cache consistent with an optimistic/queued mutation so
// re-opening a message while offline shows the change. Fire-and-forget.
function patchCache(
  id: string,
  changes: { keywords?: KeywordPatch; mailboxIds?: Record<string, boolean> },
  accountId?: string,
): void {
  void useOfflineCacheStore.getState().patch(id, changes, accountId);
}
function dropFromCache(ids: string[], accountId?: string): void {
  void useOfflineCacheStore.getState().remove(ids, accountId);
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

// Where a folder actually lives. The user's own folders keep their raw JMAP id
// and get no account override, so every existing call path stays exactly as it
// was; a shared (Stalwart group account) folder resolves to its owning account
// plus the unprefixed id the server knows it by.
interface MailboxRef {
  /** JMAP account override — undefined for the user's own folders. */
  accountId?: string;
  /** Id to send to the server, with any `<accountId>:` prefix stripped. */
  id: string;
}

function refFor(mailboxes: Mailbox[], mailboxId: string): MailboxRef {
  const mailbox = mailboxes.find((m) => m.id === mailboxId);
  if (!mailbox?.isShared) return { id: mailboxId };
  return { accountId: mailbox.accountId, id: mailbox.originalId ?? mailboxId };
}

function rawMailboxId(mailboxes: Mailbox[], mailboxId: string): string {
  return refFor(mailboxes, mailboxId).id;
}

// The JMAP account behind the folder currently on screen. Undefined for the
// user's own folders, which keeps every own-mail call on the default path.
function currentAccountId(state: EmailState): string | undefined {
  if (!state.currentMailboxId) return undefined;
  return refFor(state.mailboxes, state.currentMailboxId).accountId;
}

/**
 * A message acted on from the viewer: the copy the viewer holds and the JMAP
 * account it lives in (undefined = the user's own). The loaded list only
 * holds the open folder's account and ids are only unique per account, so a
 * row with the same id is another message unless the accounts match (B3).
 */
export interface ViewedEmail {
  email: Email;
  accountId?: string;
}

// The message an action works on, and whether the loaded list holds it: the
// list's row, but for the viewer only when the list is the message's account;
// otherwise the viewer's copy, and the list is left alone.
function actionTarget(
  state: EmailState,
  emailId: string,
  viewed?: ViewedEmail,
): { email: Email | undefined; listed: boolean } {
  const listed = !viewed || viewed.accountId === currentAccountId(state);
  const row = listed ? state.emails.find((e) => e.id === emailId) : undefined;
  return { email: row ?? viewed?.email, listed };
}

// actionTarget for the selection actions: the viewer only acts on its one message.
function actionTargets(
  state: EmailState,
  emailIds: string[],
  viewed?: ViewedEmail,
): { targets: Email[]; listed: boolean } {
  if (!viewed) return { targets: state.emails.filter((e) => emailIds.includes(e.id)), listed: true };
  const { email, listed } = actionTarget(state, viewed.email.id, viewed);
  return { targets: email ? [email] : [], listed };
}

// Where an action looks up Junk, Inbox or Archive: the viewed message's
// account, otherwise the open folder's.
function actionMailboxes(state: EmailState, viewed?: ViewedEmail): Mailbox[] {
  return viewed
    ? mailboxesOfAccount(state.mailboxes, viewed.accountId)
    : mailboxesForSiblingOf(state.mailboxes, state.currentMailboxId);
}

// Refuse a viewer action aimed at folders outside the message's account:
// the same id there is another message.
function assertViewedAccount(viewed: ViewedEmail | undefined, ...refs: MailboxRef[]): void {
  if (viewed && refs.some((ref) => ref.accountId !== viewed.accountId)) {
    throw new Error(t('email_list.move_same_account', 'Messages can only be moved within the same account'));
  }
}

// Strip the shared-folder id prefix off a whole list. Server-side folder
// matching (archive year/month auto-foldering) compares ids and parent links
// against what Mailbox/set returns, which is always unprefixed.
function toRawMailboxes(mailboxes: Mailbox[]): Mailbox[] {
  return mailboxes.map((m) => (m.isShared
    ? {
      ...m,
      id: m.originalId ?? m.id,
      parentId: m.parentId ? unprefixMailboxId(m.parentId, m.accountId) : m.parentId,
    }
    : m));
}

// Record (or forget, when the server said cannotCalculateChanges) one
// folder list's Email state without disturbing the others'.
function withEmailState(
  states: Record<string, string>,
  mailboxId: string,
  value: string | undefined,
): Record<string, string> {
  if (value === undefined) {
    const { [mailboxId]: _drop, ...rest } = states;
    return rest;
  }
  return { ...states, [mailboxId]: value };
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

/** Folder scope of a search/filter: every folder, the open one, or a store mailbox id. */
export type SearchFolderScope = 'all' | 'current' | (string & {});

export interface EmailFilters {
  from?: string;
  to?: string;
  subject?: string;
  body?: string;
  dateAfter?: string;  // YYYY-MM-DD
  dateBefore?: string; // YYYY-MM-DD
  hasAttachment?: boolean; // undefined = unset, true = with, false = without
  isStarred?: boolean;
  isUnread?: boolean;
  /**
   * Folder scope. Unset means "all folders" while a text query is active
   * (#788) and "the open folder" otherwise; explicit values come from the
   * folder chip in the filter panel.
   */
  folder?: SearchFolderScope;
  /** Tag view (#175): messages carrying this JMAP keyword, across all folders. */
  keyword?: string;
}

/** The folder scope a query runs in, resolving the unset default. */
export function effectiveFolderScope(searchQuery: string, filters: EmailFilters): SearchFolderScope {
  if (filters.keyword) return 'all';
  if (filters.folder) return filters.folder;
  return searchQuery.trim() ? 'all' : 'current';
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
  /** JMAP account the messages live under; unset for the user's own mail. */
  accountId?: string;
  /**
   * Keywords the action also changed (spam / not spam flip
   * `$junk`/`$notjunk`). Undo puts just these back to each item's
   * `originalKeywords`.
   */
  keywordPatch?: KeywordPatch;
  /**
   * Each item is one email's pre-action mailboxIds, used to restore it.
   * `originalKeywords` is set when the action also changed keywords
   * (spam / not spam flip `$junk`/`$notjunk`) so undo puts them back too.
   */
  items: Array<{
    email: Email;
    originalMailboxIds: Record<string, boolean>;
    originalKeywords?: Record<string, boolean>;
  }>;
}

// Cached emails for one mailbox (the base view: no search query, no filters).
// `queryState` is the JMAP queryState for the matching Email/query, used to
// drive Email/queryChanges on the next refresh.
export interface MailboxSnapshot {
  emails: Email[];
  total: number;
  queryState?: string;
}

// Everything we cache for one account so switching accounts can restore the
// previous view instantly instead of going through a network round-trip.
export interface AccountSnapshot {
  mailboxes: Mailbox[];
  mailboxState?: string;       // JMAP Mailbox state (drives Mailbox/changes)
  // JMAP Email state each folder's base-view list was last synced at, keyed
  // by store mailbox id (drives Email/changes). Per list, not per account:
  // refreshing one folder must not move another folder's baseline past
  // changes that folder's cached list has not seen yet.
  emailStates: Record<string, string>;
  currentMailboxId: string | null;
  mailboxSnapshots: Record<string, MailboxSnapshot>;
}

export interface EmailState {
  // ── Per-account persisted caches ──────────────────────────────
  // accountSnapshots is the source of truth for accounts the user is *not*
  // currently viewing. The active account's data lives in the top-level
  // fields below (`mailboxes`, `mailboxSnapshots`, `mailboxState`, `emailStates`,
  // `currentMailboxId`, `emails`, `totalEmails`, `queryState`) so consumers
  // keep reading the same shape they always have.
  accountSnapshots: Record<string, AccountSnapshot>;
  activeAccountId: string | null;

  // ── Active view (the currently-shown account/mailbox) ─────────
  mailboxes: Mailbox[];
  mailboxState?: string;
  emailStates: Record<string, string>;
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
  /**
   * Rows the user just read/unstarred/untagged while an Unread/Starred/tag
   * view was open. They stay in the list until the view is re-opened even
   * though the server query no longer matches them (webmail 1.9.0
   * `retainedInViewIds`).
   */
  retainedIds: string[];
  /**
   * Conversation sizes (Thread/get `emailIds.length`) for the loaded rows'
   * threads, keyed by thread id: a thread's other messages may live in other
   * folders. Cleared when the folder or account changes.
   */
  threadCounts: Record<string, number>;

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
  moveToMailbox: (emailId: string, fromMailboxId: string, toMailboxId: string, viewed?: ViewedEmail) => Promise<void>;
  archiveEmail: (emailId: string) => Promise<void>;
  deleteEmail: (emailId: string, trashMailboxId: string, currentMailboxId: string, viewed?: ViewedEmail) => Promise<void>;
  /**
   * File messages into the current account's Junk and flip `$junk`/`$notjunk`
   * (#850); honours the "trash-and-read" delete action by also marking read.
   * Works for one id or a selection; offers undo. With `viewed`, the viewer's
   * message goes to its own account's Junk (#695).
   */
  markSpam: (emailIds: string[], viewed?: ViewedEmail) => Promise<void>;
  /** Inverse of markSpam: back to Inbox with `$notjunk`. */
  unmarkSpam: (emailIds: string[], viewed?: ViewedEmail) => Promise<void>;
  // ── Batch (multi-select) actions ──────────────────────────────
  archiveEmailsBatch: (emailIds: string[]) => Promise<void>;
  moveEmailsToMailbox: (emailIds: string[], toMailboxId: string) => Promise<void>;
  deleteEmailsBatch: (emailIds: string[], trashMailboxId: string, currentMailboxId: string) => Promise<void>;
  /** Set or clear one keyword (tag, `$seen`, `$flagged`) on a selection in one `Email/set`. */
  setKeywordForEmails: (emailIds: string[], token: string, on: boolean) => Promise<void>;
  undoLast: () => Promise<void>;
  clearUndo: () => void;
  searchEmails: (query: string) => Promise<Email[]>;
  setSearchQuery: (query: string) => void;
  setFilters: (filters: EmailFilters) => void;
  setSortAscending: (ascending: boolean) => void;
  /**
   * Drop every cached queryState/snapshot window (they were built under the
   * previous order) and re-query. Call after any change to the list order.
   */
  invalidateListOrder: () => void;
  clearSearchAndFilters: () => void;
  reset: () => void;
}

function buildJmapFilter(
  searchQuery: string,
  filters: EmailFilters,
): Record<string, unknown> | undefined {
  const conditions: Record<string, unknown>[] = [];

  const trimmed = searchQuery.trim();
  if (trimmed) conditions.push({ text: toWildcardQuery(trimmed) });

  if (filters.keyword) conditions.push({ hasKeyword: filters.keyword });
  if (filters.from) conditions.push({ from: filters.from });
  if (filters.to) conditions.push({ to: filters.to });
  if (filters.subject) conditions.push({ subject: filters.subject });
  if (filters.body) conditions.push({ body: filters.body });

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

  if (conditions.length === 0) return undefined;
  if (conditions.length === 1) return conditions[0];
  return { operator: 'AND', conditions };
}

// The raw mailbox id an Email/query is scoped to: the open folder, an
// explicitly picked folder, or undefined for "all folders" (#788).
function queryScope(state: EmailState, current: MailboxRef): { mailboxId: string | undefined; accountId?: string } {
  const scope = effectiveFolderScope(state.searchQuery, state.filters);
  if (scope === 'current') return { mailboxId: current.id, accountId: current.accountId };
  if (scope === 'all') return { mailboxId: undefined, accountId: current.accountId };
  const ref = refFor(state.mailboxes, scope);
  return { mailboxId: ref.id, accountId: ref.accountId };
}

// Filter keys that don't narrow the query on their own: a folder scope of
// "current" is the default and must not count as an active filter.
function activeFilterKeys(filters: EmailFilters): string[] {
  return Object.keys(filters).filter((k) => {
    const v = (filters as Record<string, unknown>)[k];
    if (v === undefined || v === '') return false;
    if (k === 'folder' && v === 'current') return false;
    return true;
  });
}

// True when the user has no search/filters active. Only in this case do we
// touch the per-mailbox snapshot cache or use Email/queryChanges — once a
// filter is in play, the queryState belongs to a different query and the
// cached list no longer represents what's on screen.
function isBaseView(searchQuery: string, filters: EmailFilters): boolean {
  return !searchQuery.trim() && activeFilterKeys(filters).length === 0;
}

// The Email/query sort for the folder on screen: the configured order presets
// / levels (#718, Inbox-only or every folder) with the server's keyword
// comparator polarity applied, `$pinned` first, and RN's oldest-first toggle
// on the trailing date comparator.
type EmailSort = Array<{ property: string; isAscending: boolean; keyword?: string }>;
function orderFor(state: EmailState): SortLevel[] {
  const { messageListOrder, messageListOrderScope } = useSettingsStore.getState();
  const role = state.currentMailboxId
    ? state.mailboxes.find((m) => m.id === state.currentMailboxId)?.role
    : undefined;
  return orderForMailbox(sanitizeSortLevels(messageListOrder), messageListOrderScope, role);
}
function resolveSort(state: EmailState, accountId: string | undefined): Promise<EmailSort> {
  return buildListSort(accountId ?? jmapClient.accountId, orderFor(state), {
    pinnedFirst: true,
    dateAscending: useSettingsStore.getState().mailSortAscending,
  });
}
// A stable fingerprint of everything that influences the sort, so a response
// built under a previous order is dropped instead of overwriting the view.
function orderFingerprint(): string {
  const s = useSettingsStore.getState();
  return JSON.stringify([s.mailSortAscending, s.messageListOrderScope, s.messageListOrder]);
}
function isUnsupportedSort(err: unknown): boolean {
  return err instanceof JMAPMethodError && err.type === 'unsupportedSort';
}

// Splice rows the user just read/unstarred back into a freshly re-queried
// Unread/Starred view at their previous position (webmail `mergeRetainedRows`).
function mergeRetainedRows(previous: Email[], fresh: Email[], retainedIds: string[]): Email[] {
  if (retainedIds.length === 0) return fresh;
  const freshIds = new Set(fresh.map((e) => e.id));
  const retained = new Set(retainedIds);
  const out = [...fresh];
  previous.forEach((e, index) => {
    if (!retained.has(e.id) || freshIds.has(e.id)) return;
    out.splice(Math.min(index, out.length), 0, e);
  });
  return out;
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
    emailStates: state.emailStates,
    currentMailboxId: state.currentMailboxId,
    mailboxSnapshots,
  };
}

function viewFromSnapshot(snap: AccountSnapshot | null): {
  mailboxes: Mailbox[];
  mailboxState?: string;
  emailStates: Record<string, string>;
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
      emailStates: {},
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
    emailStates: snap.emailStates ?? {},
    currentMailboxId: snap.currentMailboxId,
    mailboxSnapshots: snap.mailboxSnapshots,
    emails: mailboxSnap?.emails ?? [],
    totalEmails: mailboxSnap?.total ?? 0,
    queryState: mailboxSnap?.queryState,
  };
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
  emailStates: {},
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
  retainedIds: [],
  threadCounts: {},

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
      retainedIds: [],
      threadCounts: {},
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
        emailStates: {},
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
      emailStates: {},
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

  fetchMailboxes: () => {
    // Skip silently when there's no live session, or when jmapClient is
    // mid-transition to a different account (see jmapClientServesActiveAccount).
    // Screens fire this from mount-time useEffects, and on cold start
    // App.tsx renders MainTabs before restoreSession() finishes; without
    // this guard the underlying API call would either throw "Not
    // authenticated - call connect() first" or — worse, during an account
    // switch — return the *previous* account's mailboxes and stamp them
    // into the new account's snapshot.
    const activeAccountId = get().activeAccountId;
    if (!jmapClientServesActiveAccount(activeAccountId)) return Promise.resolve();
    return coalesceRefresh(`${activeAccountId}:mailboxes`, () => fetchMailboxesImpl(activeAccountId!));
  },

  selectMailbox: async (mailboxId) => {
    const state = get();
    // Tuck the previously-visible mailbox into its snapshot so a return-trip
    // can restore it without a network call. Only do this for the base view —
    // a filter or search makes the visible list unrepresentative of the
    // cached "no-filter" snapshot.
    let mailboxSnapshots = state.mailboxSnapshots;
    const baseView = isBaseView(state.searchQuery, state.filters);
    if (state.currentMailboxId && state.currentMailboxId !== mailboxId && baseView) {
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
    // With a search/filter active the search is kept and re-run in the new
    // folder (#553), so the current results stay on screen until it lands.
    let seededEmails: Email[] = baseView ? incoming?.emails ?? [] : state.emails;
    let seededTotal = baseView ? incoming?.total ?? 0 : state.totalEmails;
    const seededQueryState = baseView ? incoming?.queryState : undefined;

    if (baseView && seededEmails.length === 0) {
      const cacheStore = useOfflineCacheStore.getState();
      if (!cacheStore.hydrated) await cacheStore.hydrate();
      if (cacheStore.totalCount() > 0) {
        try {
          const limit = useSettingsStore.getState().emailsPerPage;
          // Cached messages carry raw JMAP mailboxIds, so look up by the
          // unprefixed id rather than the sidebar's shared-folder key.
          seededEmails = await cacheStore.getEmailsInMailbox(
            rawMailboxId(state.mailboxes, mailboxId),
            Math.max(limit, 50),
            refFor(state.mailboxes, mailboxId).accountId,
          );
          // The cache returns newest-first; flip for an ascending sort.
          if (useSettingsStore.getState().mailSortAscending) seededEmails.reverse();
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
      pendingUndo: null,
      retainedIds: [],
      threadCounts: {},
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
    const state = get();
    const { currentMailboxId, emails, totalEmails, loading, searchQuery, filters, activeAccountId } = state;
    // Rows kept on screen after they stopped matching the query (read in the
    // Unread view, unstarred in Starred, untagged in a tag view) are no longer
    // part of the server's result; counting them would skip as many messages.
    const retained = new Set(state.retainedIds);
    const position = emails.filter((e) => !retained.has(e.id)).length;
    if (!currentMailboxId || loading || position >= totalEmails) return;
    if (!jmapClientServesActiveAccount(activeAccountId)) return;

    set({ loading: true });
    try {
      const scope = queryScope(state, refFor(state.mailboxes, currentMailboxId));
      const filter = buildJmapFilter(searchQuery, filters);
      const limit = useSettingsStore.getState().emailsPerPage;
      const { list, total, threads } = await queryEmailPage(scope.mailboxId, {
        position,
        limit,
        sort: await resolveSort(state, scope.accountId),
        filter,
        accountId: scope.accountId,
        threads: !useSettingsStore.getState().disableThreading,
      });
      if (get().activeAccountId !== activeAccountId || get().currentMailboxId !== currentMailboxId) return;
      // A message that arrived between pages shifts positions and would come
      // back a second time — drop ids we already show (duplicate keys).
      const existingIds = new Set(get().emails.map((e) => e.id));
      const newEmails = list.filter((e) => !existingIds.has(e.id));
      const merged = [...get().emails, ...newEmails];
      // The server's current count: a read in the Unread view has shrunk it
      // since the list was loaded, and a stale total keeps load-more asking
      // for a page that isn't there.
      const updates: Partial<EmailState> = {
        emails: merged,
        totalEmails: total,
        threadCounts: withThreadCounts(get().threadCounts, threads),
        loading: false,
      };
      if (isBaseView(searchQuery, filters)) {
        updates.mailboxSnapshots = {
          ...get().mailboxSnapshots,
          [currentMailboxId]: {
            emails: merged,
            total,
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
    // Both the blob upload and the import have to target the folder's owning
    // account, or the import references a blob the server can't see.
    const ref = refFor(get().mailboxes, mailboxId);
    let imported = 0;
    let failed = 0;
    for (const file of files) {
      try {
        // A .eml expands to one message; a .zip to one per .eml it contains.
        const emls = await expandImportableEml(file.uri, file.name, file.mimeType);
        if (emls.length === 0) failed += 1;
        for (const eml of emls) {
          try {
            const { blobId } = await uploadBytes(eml.bytes, 'message/rfc822', ref.accountId);
            await importEmailBlob(blobId, ref.id, undefined, ref.accountId);
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

  refreshEmails: () => {
    const { currentMailboxId, activeAccountId } = get();
    if (!currentMailboxId) return Promise.resolve();
    if (!jmapClientServesActiveAccount(activeAccountId)) return Promise.resolve();
    return coalesceRefresh(`${activeAccountId}:emails`, refreshEmailsImpl);
  },

  handleStateChange: async (change) => {
    if (!jmapClient.currentSession) return;
    // Drop changes that arrived for a different account than the one we're
    // currently showing (e.g. push notifications received during/just after
    // an account switch).
    if (!jmapClientServesActiveAccount(get().activeAccountId)) return;
    // Push/EventSource state changes cover every account in the session, so a
    // shared (group account) mailbox reports under its own account id. Fold
    // them all in: any account's Mailbox change refreshes the folder list, but
    // only the account behind the open folder needs its message list re-read.
    const primaryId = jmapClient.accountId;
    const state = get();
    const currentAccountId =
      state.currentMailboxId
        ? refFor(state.mailboxes, state.currentMailboxId).accountId ?? primaryId
        : primaryId;
    const known = new Set([primaryId, ...jmapClient.getSharedMailAccounts().map((a) => a.id)]);

    let mailboxChanged = false;
    let emailChanged = false;
    for (const [accountId, accountChanges] of Object.entries(change.changed ?? {})) {
      if (!known.has(accountId) || !accountChanges) continue;
      if ('Mailbox' in accountChanges) mailboxChanged = true;
      if (accountId !== currentAccountId) continue;
      if ('Email' in accountChanges || 'EmailDelivery' in accountChanges) emailChanged = true;
    }
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
    if (state.searchQuery === query) return;
    const backToBase =
      !isBaseView(state.searchQuery, state.filters) && isBaseView(query, state.filters);
    set({
      searchQuery: query,
      retainedIds: [],
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
      retainedIds: [],
      ...(backToBase ? restoredBaseView(state) : {}),
    });
    void get().refreshEmails();
  },

  setSortAscending: (ascending) => {
    const settings = useSettingsStore.getState();
    if (settings.mailSortAscending === ascending) return;
    settings.updateSetting('mailSortAscending', ascending);
    get().invalidateListOrder();
  },

  invalidateListOrder: () => {
    // Every cached queryState and snapshot window was built under the old
    // order — drop them all (active view and tucked-away accounts) so the
    // next refresh does a full re-query instead of running
    // Email/queryChanges against a differently-sorted query.
    const accountSnapshots: Record<string, AccountSnapshot> = {};
    for (const [id, acc] of Object.entries(get().accountSnapshots)) {
      accountSnapshots[id] = { ...acc, mailboxSnapshots: {} };
    }
    set({ queryState: undefined, mailboxSnapshots: {}, accountSnapshots });
    void get().refreshEmails();
  },

  clearSearchAndFilters: () => {
    const state = get();
    if (!state.searchQuery && activeFilterKeys(state.filters).length === 0) return;
    set({ searchQuery: '', filters: {}, retainedIds: [], ...restoredBaseView(state) });
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
      if (cache.has(id, accountId)) {
        try {
          const size = JSON.stringify(fresh).length;
          await cache.put(fresh, size, accountId);
        } catch { /* ignore — best-effort refresh */ }
      }
      return fresh;
    } catch (err) {
      const cached = await useOfflineCacheStore.getState().get(id, accountId);
      if (cached) return cached;
      throw err;
    }
  },

  markRead: async (emailId, accountId) => {
    const state = get();
    const email = state.emails.find((e) => e.id === emailId);
    // Only `$seen` goes to the server: the message may not be in the list at
    // all, and a whole keyword map would erase its stars and tags.
    const patch = { $seen: true };
    // A group/shared message opened from the unified inbox lives under another
    // JMAP account and isn't in the active list/cache or the (account-scoped)
    // offline queue — mark it read directly against its owning account.
    if (accountId && !email) {
      await patchKeywordsForEmails([emailId], patch, accountId);
      return;
    }
    const owner = accountId ?? currentAccountId(state);
    await applyOrQueue({ kind: 'keywords', emailId, accountId: owner, patch });
    set({
      emails: get().emails.map((e) =>
        e.id === emailId ? { ...e, keywords: applyKeywordPatch(e.keywords, patch) } : e,
      ),
      ...(state.filters.isUnread === true ? { retainedIds: retain(get().retainedIds, [emailId]) } : {}),
    });
    patchCache(emailId, { keywords: patch }, owner);
  },

  markUnread: async (emailId) => {
    const state = get();
    const email = state.emails.find((e) => e.id === emailId);
    if (!email) return;
    const patch = { $seen: null };
    await applyOrQueue({
      kind: 'keywords',
      emailId,
      accountId: currentAccountId(state),
      patch,
    });
    set({
      emails: get().emails.map((e) =>
        e.id === emailId ? { ...e, keywords: applyKeywordPatch(e.keywords, patch) } : e,
      ),
      ...(state.filters.isUnread === false ? { retainedIds: retain(get().retainedIds, [emailId]) } : {}),
    });
    patchCache(emailId, { keywords: patch }, currentAccountId(state));
  },

  toggleStar: async (emailId, starred) => {
    const state = get();
    const email = state.emails.find((e) => e.id === emailId);
    if (!email) return;
    const patch = { $flagged: starred ? true : null };
    await applyOrQueue({
      kind: 'keywords',
      emailId,
      accountId: currentAccountId(state),
      patch,
    });
    set({
      emails: get().emails.map((e) =>
        e.id === emailId ? { ...e, keywords: applyKeywordPatch(e.keywords, patch) } : e,
      ),
      ...(state.filters.isStarred !== undefined && state.filters.isStarred !== starred
        ? { retainedIds: retain(get().retainedIds, [emailId]) }
        : {}),
    });
    patchCache(emailId, { keywords: patch }, currentAccountId(state));
  },

  togglePin: async (emailId, pinned) => {
    const state = get();
    const email = state.emails.find((e) => e.id === emailId);
    if (!email) return;
    // `$pinned` is what the webmail reads and writes; a pin set as
    // `$important` was invisible to it (and vice versa).
    const patch = { $pinned: pinned ? true : null };
    await applyOrQueue({
      kind: 'keywords',
      emailId,
      accountId: currentAccountId(state),
      patch,
    });
    set({
      emails: get().emails.map((e) =>
        e.id === emailId ? { ...e, keywords: applyKeywordPatch(e.keywords, patch) } : e,
      ),
    });
    patchCache(emailId, { keywords: patch }, currentAccountId(state));
  },

  markSpam: async (emailIds, viewed) => {
    const state = get();
    const { targets, listed } = actionTargets(state, emailIds, viewed);
    if (targets.length === 0) return;
    const scoped = actionMailboxes(state, viewed);
    const junkMailbox = findJunkMailbox(scoped);
    if (!junkMailbox) {
      set({ error: t('email_list.no_junk_folder', 'Could not find a Spam/Junk folder on the server.') });
      return;
    }
    const junk = refFor(state.mailboxes, junkMailbox.id);
    const markRead = useSettingsStore.getState().deleteAction === 'trash-and-read';
    const junkTarget = { [junk.id]: true };
    const keywordPatch: KeywordPatch = { $junk: true, $notjunk: null, ...(markRead ? { $seen: true } : {}) };
    const items = targets.map((e) => ({
      email: e,
      originalMailboxIds: { ...e.mailboxIds },
      originalKeywords: { ...e.keywords },
    }));

    await applyOrQueueBatch(
      targets.flatMap((e): OutboxOp[] => [
        { kind: 'mailboxes', emailId: e.id, accountId: junk.accountId, mailboxIds: junkTarget },
        { kind: 'keywords', emailId: e.id, accountId: junk.accountId, patch: keywordPatch },
      ]),
      () => apiMarkAsSpam(targets.map((e) => e.id), junk.id, junk.accountId, { markRead }),
    );

    const removed = new Set(listed ? targets.map((e) => e.id) : []);
    set({
      emails: get().emails.filter((e) => !removed.has(e.id)),
      pendingUndo: {
        kind: 'spam',
        label: targets.length === 1
          ? t('email_list.marked_as_spam', 'Marked as spam')
          : t('email_list.marked_as_spam_count', `${targets.length} emails marked as spam`, { count: targets.length }),
        createdAt: Date.now(),
        accountId: junk.accountId,
        keywordPatch,
        items,
      },
    });
    for (const e of targets) patchCache(e.id, { mailboxIds: junkTarget, keywords: keywordPatch }, junk.accountId);
  },

  unmarkSpam: async (emailIds, viewed) => {
    const state = get();
    const { targets, listed } = actionTargets(state, emailIds, viewed);
    if (targets.length === 0) return;
    const scoped = actionMailboxes(state, viewed);
    const inboxMailbox = scoped.find((m) => m.role === 'inbox');
    if (!inboxMailbox) return;
    const inbox = refFor(state.mailboxes, inboxMailbox.id);
    const inboxTarget = { [inbox.id]: true };
    const keywordPatch: KeywordPatch = { $junk: null, $notjunk: true };
    const items = targets.map((e) => ({
      email: e,
      originalMailboxIds: { ...e.mailboxIds },
      originalKeywords: { ...e.keywords },
    }));

    await applyOrQueueBatch(
      targets.flatMap((e): OutboxOp[] => [
        { kind: 'mailboxes', emailId: e.id, accountId: inbox.accountId, mailboxIds: inboxTarget },
        { kind: 'keywords', emailId: e.id, accountId: inbox.accountId, patch: keywordPatch },
      ]),
      () => apiUndoSpam(targets.map((e) => e.id), inbox.id, inbox.accountId),
    );

    const removed = new Set(listed ? targets.map((e) => e.id) : []);
    set({
      emails: get().emails.filter((e) => !removed.has(e.id)),
      pendingUndo: {
        kind: 'spam',
        label: targets.length === 1
          ? t('email_list.marked_not_spam', 'Marked as not spam')
          : t('email_list.marked_not_spam_count', `${targets.length} emails marked as not spam`, { count: targets.length }),
        createdAt: Date.now(),
        accountId: inbox.accountId,
        keywordPatch,
        items,
      },
    });
    for (const e of targets) patchCache(e.id, { mailboxIds: inboxTarget, keywords: keywordPatch }, inbox.accountId);
  },

  moveToMailbox: async (emailId, fromMailboxId, toMailboxId, viewed) => {
    const state = get();
    const { email, listed } = actionTarget(state, emailId, viewed);
    const from = refFor(state.mailboxes, fromMailboxId);
    const to = refFor(state.mailboxes, toMailboxId);
    assertViewedAccount(viewed, from, to);
    // A single Email/set is scoped to one account: a move between the user's
    // own folders and a shared account's (or between two shared accounts) is
    // a copy-then-delete across accounts (webmail 1.7.2), online only.
    if (from.accountId !== to.accountId) {
      if (!email) return;
      try {
        await crossAccountMove([email], from, to);
      } catch (err) {
        set({ error: err instanceof Error ? err.message : t('notifications.move_failed', 'Move failed') });
        return;
      }
      set({ emails: get().emails.filter((e) => e.id !== emailId) });
      dropFromCache([emailId], from.accountId);
      return;
    }
    const original = email ? { ...email.mailboxIds } : null;
    const target = mailboxesAfterMove(email?.mailboxIds, from.id, to.id);

    await applyOrQueue(
      { kind: 'mailboxes', emailId, accountId: from.accountId, mailboxIds: target },
      () => moveEmail(emailId, from.id, to.id, from.accountId),
    );
    if (listed) set({ emails: get().emails.filter((e) => e.id !== emailId) });
    patchCache(emailId, { mailboxIds: target }, from.accountId);

    if (email && original) {
      const targetName = mailboxPath(get().mailboxes, toMailboxId);
      set({
        pendingUndo: {
          kind: 'move',
          label: targetName
            ? t('notifications.moved_to_mailbox', `Email moved to ${targetName}`, { mailbox: targetName })
            : t('notifications.email_moved', 'Email moved'),
          createdAt: Date.now(),
          accountId: from.accountId,
          items: [{ email, originalMailboxIds: original }],
        },
      });
    }
  },

  archiveEmail: async (emailId) => {
    const state = get();
    const email = state.emails.find((e) => e.id === emailId);
    if (!email) return;

    // Archive into the *same account's* Archive folder — a shared mailbox's
    // messages can't be filed into the user's own.
    const scoped = mailboxesForSiblingOf(state.mailboxes, state.currentMailboxId);
    const archiveMailbox = scoped.find(
      (m) => m.role === 'archive' || m.name.toLowerCase() === 'archive',
    );
    if (!archiveMailbox) return;
    const archive = refFor(state.mailboxes, archiveMailbox.id);
    if (email.mailboxIds?.[archive.id]) return;

    const mode = useSettingsStore.getState().archiveMode;
    const original = { ...email.mailboxIds };

    // Online keeps the rich year/month auto-foldering. Offline degrades to the
    // archive root (we can't create folders without a connection); the queued
    // op replays as a plain move into Archive.
    const { queued } = await applyOrQueue(
      {
        kind: 'archive',
        emailId,
        accountId: archive.accountId,
        archiveMailboxId: archive.id,
        mode,
        receivedAt: email.receivedAt,
      },
      () => apiArchiveEmails(
        [{ id: email.id, receivedAt: email.receivedAt }],
        archive.id,
        mode,
        toRawMailboxes(scoped),
        archive.accountId,
      ),
    );

    set({
      emails: get().emails.filter((e) => e.id !== emailId),
      pendingUndo: {
        kind: 'archive',
        label: t('notifications.email_archived', 'Email archived'),
        createdAt: Date.now(),
        accountId: archive.accountId,
        items: [{ email, originalMailboxIds: original }],
      },
    });
    patchCache(emailId, { mailboxIds: { [archive.id]: true } }, archive.accountId);

    // Auto-sort modes may have created new year/month folders - refresh the
    // mailbox list so the sidebar picks them up on the next render. Skip when
    // the action was only queued (no folders were created offline).
    if (mode !== 'single' && !queued) {
      void get().fetchMailboxes();
    }
  },

  deleteEmail: async (emailId, trashMailboxId, currentMailboxId, viewed) => {
    const state = get();
    const { email, listed } = actionTarget(state, emailId, viewed);
    const original = email ? { ...email.mailboxIds } : null;
    const settings = useSettingsStore.getState();
    const trash = refFor(state.mailboxes, trashMailboxId);
    const source = refFor(state.mailboxes, currentMailboxId);
    assertViewedAccount(viewed, trash, source);
    const junkMailbox = mailboxesForSiblingOf(state.mailboxes, currentMailboxId)
      .find((m) => m.role === 'junk' || m.role === 'spam');
    const junkId = junkMailbox ? rawMailboxId(state.mailboxes, junkMailbox.id) : null;
    const inJunk = !!(junkId && email?.mailboxIds?.[junkId]);
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
        { kind: 'destroy', emailId, accountId: trash.accountId },
        () => apiDeleteEmail(emailId, trash.id, trash.id, trash.accountId),
      );
      dropFromCache([emailId], trash.accountId);
    } else {
      const target = mailboxesAfterMove(email?.mailboxIds, source.id, trash.id);
      await applyOrQueue(
        { kind: 'mailboxes', emailId, accountId: source.accountId, mailboxIds: target },
        () => apiDeleteEmail(emailId, trash.id, source.id, source.accountId),
      );
      // "Move to Trash and mark as read" (#323): when the user picked that
      // delete action, also clear unread state for messages moved to trash.
      if (settings.deleteAction === 'trash-and-read' && email && !email.keywords?.$seen) {
        const patch = { $seen: true };
        await applyOrQueue({
          kind: 'keywords',
          emailId,
          accountId: source.accountId,
          patch,
        });
        patchCache(emailId, { mailboxIds: target, keywords: patch }, source.accountId);
      } else {
        patchCache(emailId, { mailboxIds: target }, source.accountId);
      }
    }
    if (listed) set({ emails: get().emails.filter((e) => e.id !== emailId) });

    // Permanent destroy can't be undone - skip the snackbar so we don't
    // promise an undo we can't deliver.
    if (email && original && !destroy) {
      set({
        pendingUndo: {
          kind: 'delete',
          label: t('email_list.moved_to_trash', 'Email moved to Trash'),
          createdAt: Date.now(),
          accountId: source.accountId,
          items: [{ email, originalMailboxIds: original }],
        },
      });
    }
  },

  // ── Batch actions ─────────────────────────────────────────────
  // Each produces a single combined UndoEntry (UndoEntry.items is an array),
  // so a multi-select archive/move/delete is reversed with one snackbar tap.

  archiveEmailsBatch: async (emailIds) => {
    const state = get();
    const scoped = mailboxesForSiblingOf(state.mailboxes, state.currentMailboxId);
    const archiveMailbox = scoped.find(
      (m) => m.role === 'archive' || m.name.toLowerCase() === 'archive',
    );
    if (!archiveMailbox) return;
    const archive = refFor(state.mailboxes, archiveMailbox.id);
    const targets = state.emails.filter(
      (e) => emailIds.includes(e.id) && !e.mailboxIds?.[archive.id],
    );
    if (targets.length === 0) return;

    const mode = useSettingsStore.getState().archiveMode;
    const items = targets.map((e) => ({ email: e, originalMailboxIds: { ...e.mailboxIds } }));
    const archiveTarget = { [archive.id]: true };

    const { queued } = await applyOrQueueBatch(
      targets.map((e): OutboxOp => ({
        kind: 'archive',
        emailId: e.id,
        accountId: archive.accountId,
        archiveMailboxId: archive.id,
        mode,
        receivedAt: e.receivedAt,
      })),
      () => apiArchiveEmails(
        targets.map((e) => ({ id: e.id, receivedAt: e.receivedAt })),
        archive.id,
        mode,
        toRawMailboxes(scoped),
        archive.accountId,
      ),
    );

    const removed = new Set(targets.map((e) => e.id));
    set({
      emails: get().emails.filter((e) => !removed.has(e.id)),
      pendingUndo: {
        kind: 'archive',
        label: targets.length === 1
          ? t('notifications.email_archived', 'Email archived')
          : t('email_list.emails_archived_count', `${targets.length} emails archived`, { count: targets.length }),
        createdAt: Date.now(),
        accountId: archive.accountId,
        items,
      },
    });
    for (const e of targets) patchCache(e.id, { mailboxIds: archiveTarget }, archive.accountId);

    if (mode !== 'single' && !queued) void get().fetchMailboxes();
  },

  moveEmailsToMailbox: async (emailIds, toMailboxId) => {
    const { emails, currentMailboxId, mailboxes } = get();
    if (!currentMailboxId || toMailboxId === currentMailboxId) return;
    const source = refFor(mailboxes, currentMailboxId);
    const to = refFor(mailboxes, toMailboxId);
    const targets = emails.filter((e) => emailIds.includes(e.id));
    if (targets.length === 0) return;
    // See moveToMailbox: one Email/set can't span two accounts — copy+delete.
    if (source.accountId !== to.accountId) {
      try {
        await crossAccountMove(targets, source, to);
      } catch (err) {
        set({ error: err instanceof Error ? err.message : t('notifications.move_failed', 'Move failed') });
        return;
      }
      const moved = new Set(targets.map((e) => e.id));
      set({ emails: get().emails.filter((e) => !moved.has(e.id)) });
      dropFromCache(targets.map((e) => e.id), source.accountId);
      return;
    }

    const items = targets.map((e) => ({ email: e, originalMailboxIds: { ...e.mailboxIds } }));

    await applyOrQueueBatch(
      targets.map((e): OutboxOp => ({
        kind: 'mailboxes',
        emailId: e.id,
        accountId: source.accountId,
        mailboxIds: mailboxesAfterMove(e.mailboxIds, source.id, to.id),
      })),
      () => apiMoveEmails(targets.map((e) => e.id), source.id, to.id, source.accountId),
    );

    const removed = new Set(targets.map((e) => e.id));
    for (const e of targets) {
      patchCache(e.id, { mailboxIds: mailboxesAfterMove(e.mailboxIds, source.id, to.id) }, source.accountId);
    }
    const targetName = mailboxPath(mailboxes, toMailboxId);
    set({
      emails: get().emails.filter((e) => !removed.has(e.id)),
      pendingUndo: {
        kind: 'move',
        label: targetName
          ? (targets.length === 1
            ? t('notifications.moved_to_mailbox', `Email moved to ${targetName}`, { mailbox: targetName })
            : t('email_list.emails_moved_to', `${targets.length} emails moved to ${targetName}`, { count: targets.length, mailbox: targetName }))
          : t('notifications.emails_moved', 'Emails moved'),
        createdAt: Date.now(),
        accountId: source.accountId,
        items,
      },
    });
  },

  deleteEmailsBatch: async (emailIds, trashMailboxId, currentMailboxId) => {
    const { emails, mailboxes } = get();
    const settings = useSettingsStore.getState();
    const trash = refFor(mailboxes, trashMailboxId);
    const source = refFor(mailboxes, currentMailboxId);
    const junkMailbox = mailboxesForSiblingOf(mailboxes, currentMailboxId)
      .find((m) => m.role === 'junk' || m.role === 'spam');
    const junkId = junkMailbox ? rawMailboxId(mailboxes, junkMailbox.id) : null;
    const inTrash = currentMailboxId === trashMailboxId;
    const targets = emails.filter((e) => emailIds.includes(e.id));
    if (targets.length === 0) return;

    // Split into permanent-destroy vs move-to-trash following the same policy
    // as the single delete: trash folder, global "permanent" default, or the
    // skip-trash-for-junk option each force a destroy.
    const toDestroy: Email[] = [];
    const toTrash: Email[] = [];
    for (const e of targets) {
      const inJunk = !!(junkId && e.mailboxIds?.[junkId]);
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
    const markReadIds = new Set(toMarkRead.map((e) => e.id));
    const markReadPatch = { $seen: true };

    const ops: OutboxOp[] = [
      ...toDestroy.map((e): OutboxOp => ({
        kind: 'destroy',
        emailId: e.id,
        accountId: trash.accountId,
      })),
      ...toTrash.map((e): OutboxOp => ({
        kind: 'mailboxes',
        emailId: e.id,
        accountId: source.accountId,
        mailboxIds: mailboxesAfterMove(e.mailboxIds, source.id, trash.id),
      })),
      ...toMarkRead.map((e): OutboxOp => ({
        kind: 'keywords',
        emailId: e.id,
        accountId: source.accountId,
        patch: markReadPatch,
      })),
    ];
    await applyOrQueueBatch(ops, async () => {
      if (toDestroy.length > 0) {
        await apiDeleteEmails(toDestroy.map((e) => e.id), trash.id, trash.id, trash.accountId);
      }
      if (toTrash.length > 0) {
        await apiMoveEmails(toTrash.map((e) => e.id), source.id, trash.id, source.accountId);
      }
      if (toMarkRead.length > 0) {
        await patchKeywordsForEmails([...markReadIds], markReadPatch, source.accountId);
      }
    });

    if (toDestroy.length > 0) dropFromCache(toDestroy.map((e) => e.id), trash.accountId);
    for (const e of toTrash) {
      patchCache(e.id, {
        mailboxIds: mailboxesAfterMove(e.mailboxIds, source.id, trash.id),
        ...(markReadIds.has(e.id) ? { keywords: markReadPatch } : {}),
      }, source.accountId);
    }

    const removed = new Set(targets.map((e) => e.id));
    set({ emails: get().emails.filter((e) => !removed.has(e.id)) });

    // Only the moved-to-trash items are recoverable; destroyed ones are gone.
    if (toTrash.length > 0) {
      set({
        pendingUndo: {
          kind: 'delete',
          label: toTrash.length === 1
            ? t('email_list.moved_to_trash', 'Email moved to Trash')
            : t('email_list.moved_to_trash_count', `${toTrash.length} emails moved to Trash`, { count: toTrash.length }),
          createdAt: Date.now(),
          accountId: source.accountId,
          items: toTrash.map((e) => ({ email: e, originalMailboxIds: { ...e.mailboxIds } })),
        },
      });
    }
  },

  setKeywordForEmails: async (emailIds, token, on) => {
    const state = get();
    const targets = state.emails.filter((e) => emailIds.includes(e.id));
    if (targets.length === 0) return;
    const owner = currentAccountId(state);
    const ids = targets.map((e) => e.id);
    const patch = { [token]: on ? true : null };
    await applyOrQueueBatch(
      ids.map((id): OutboxOp => ({
        kind: 'keywords',
        emailId: id,
        accountId: owner,
        patch,
      })),
      () => patchKeywordsForEmails(ids, patch, owner),
    );
    const touched = new Set(ids);
    set({
      emails: get().emails.map((e) =>
        touched.has(e.id) ? { ...e, keywords: applyKeywordPatch(e.keywords, patch) } : e,
      ),
      // Reading inside Unread, unstarring inside Starred or untagging inside
      // that tag's view keeps the rows until it's re-opened.
      ...(leavesView(state.filters, token, on)
        ? { retainedIds: retain(get().retainedIds, ids) }
        : {}),
    });
    for (const id of ids) patchCache(id, { keywords: patch }, owner);
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
          accountId: entry.accountId,
          mailboxIds: it.originalMailboxIds,
        })),
        () => restoreEmailMailboxes(
          entry.items.map((it) => ({ id: it.email.id, mailboxIds: it.originalMailboxIds })),
          entry.accountId,
        ),
      );
      // Spam / not-spam also flipped `$junk`/`$notjunk` (and maybe `$seen`):
      // put those keywords back as they were, leaving the rest alone.
      const keywordPatch = entry.keywordPatch;
      const keywordUndo = keywordPatch
        ? entry.items.map((it) => ({ id: it.email.id, patch: revertKeywordPatch(keywordPatch, it.originalKeywords) }))
        : [];
      if (keywordUndo.length > 0) {
        await applyOrQueueBatch(
          keywordUndo.map((u): OutboxOp => ({
            kind: 'keywords',
            emailId: u.id,
            accountId: entry.accountId,
            patch: u.patch,
          })),
          () => patchKeywordsPerEmail(keywordUndo, entry.accountId),
        );
      }
      const undoById = new Map(keywordUndo.map((u) => [u.id, u.patch]));
      for (const it of entry.items) {
        const patch = undoById.get(it.email.id);
        patchCache(it.email.id, {
          mailboxIds: it.originalMailboxIds,
          ...(patch ? { keywords: patch } : {}),
        }, entry.accountId);
      }
    } catch (err) {
      set({ error: err instanceof Error ? err.message : t('email_list.undo_failed', 'Undo failed') });
      return;
    }

    // Re-insert each restored email into the visible list if its original
    // mailboxIds include the current view. Server is the source of truth for
    // ordering, but local re-insertion gives the user instant feedback. Only
    // into a list of the same account: mailbox ids repeat across accounts.
    const { currentMailboxId, emails, mailboxes } = get();
    if (currentMailboxId && entry.accountId === currentAccountId(get())) {
      const currentRawId = rawMailboxId(mailboxes, currentMailboxId);
      const restored = entry.items
        .filter((it) => it.originalMailboxIds[currentRawId])
        .map((it) => ({
          ...it.email,
          mailboxIds: it.originalMailboxIds,
          ...(it.originalKeywords ? { keywords: it.originalKeywords } : {}),
        }));
      if (restored.length > 0) {
        const ascending = useSettingsStore.getState().mailSortAscending;
        const merged = [...restored, ...emails].sort((a, b) => {
          const byDate = new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime();
          return ascending ? -byDate : byDate;
        });
        set({ emails: merged });
      }
    }
  },

  clearUndo: () => set({ pendingUndo: null }),

  searchEmails: async (query) => {
    // Search the account whose folder is open, so a shared mailbox searches
    // its own messages rather than the user's.
    const owner = currentAccountId(get());
    const ids = await apiSearchEmails(query, undefined, 30, owner);
    if (ids.length === 0) return [];
    return fetchEmails(ids, owner);
  },

  reset: () => set({
    mailboxes: [],
    mailboxState: undefined,
    emailStates: {},
    currentMailboxId: null,
    mailboxSnapshots: {},
    emails: [],
    totalEmails: 0,
    queryState: undefined,
    loading: false,
    error: null,
    searchQuery: '',
    filters: {},
    retainedIds: [],
    threadCounts: {},
  }),
    }),
    {
      // Persist the per-account caches and the active view so the UI can
      // render instantly on re-open / account switch, before the JMAP
      // session has finished restoring. auth-store triggers a background
      // refresh once the session is ready.
      name: 'email-cache',
      storage: createPersistStorage(),
      version: 2,
      // v0 → v1: drop every cached queryState. Pre-v1 builds could persist a
      // search-result list next to the base view's queryState, and the
      // incremental sync path would then "confirm" those search results as
      // the whole mailbox and bake them into the snapshot (issue #10).
      // Without a queryState the next refresh does a full re-query, which
      // rebuilds any poisoned window from the server.
      //
      // v1 → v2: the single `emailState` became `emailStates`, keyed per JMAP
      // account so shared (group account) folders track their own. The old
      // token is dropped; the next refresh re-primes it from Email/get.
      migrate: (persisted, version) => {
        const s = persisted as Pick<
          EmailState,
          'accountSnapshots' | 'mailboxSnapshots' | 'queryState'
        > & Record<string, unknown>;

        const dropEmailState = (input: Record<string, unknown>): Record<string, unknown> => {
          const { emailState: _drop, ...rest } = input;
          return { ...rest, emailStates: {} };
        };

        if (version >= 2) return persisted as EmailState;
        if (version >= 1) {
          const accountSnapshots: Record<string, AccountSnapshot> = {};
          for (const [id, acc] of Object.entries(s.accountSnapshots ?? {})) {
            accountSnapshots[id] = dropEmailState(
              acc as unknown as Record<string, unknown>,
            ) as unknown as AccountSnapshot;
          }
          return { ...dropEmailState(s), accountSnapshots } as unknown as EmailState;
        }

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
          accountSnapshots[id] = dropEmailState({
            ...acc,
            mailboxSnapshots: stripQueryStates(acc.mailboxSnapshots),
          }) as unknown as AccountSnapshot;
        }
        return {
          ...dropEmailState(s),
          accountSnapshots,
          mailboxSnapshots: stripQueryStates(s.mailboxSnapshots),
          queryState: undefined,
        } as unknown as EmailState;
      },
      // The active view is stored the way an account switch tucks it away,
      // so its folder is in the row once and `merge` rebuilds `emails` from
      // it. Bounded so Android can still read the row back. Memoised on
      // everything `snapshotFromActive` reads, so a set() that only flips
      // `loading` or `error` isn't written.
      partialize: memoizeSlice(
        (state: EmailState) => [
          state.accountSnapshots, state.activeAccountId, state.mailboxes, state.mailboxState,
          state.emailStates, state.currentMailboxId, state.mailboxSnapshots, state.emails,
          state.totalEmails, state.queryState, state.searchQuery, state.filters,
        ],
        (state): PersistedEmailCache => boundEmailCache({
          accountSnapshots: state.accountSnapshots,
          activeAccountId: state.activeAccountId,
          ...snapshotFromActive(state),
        }),
      ),
      merge: (persisted, current) => {
        if (!persisted) return current;
        const cache = persisted as PersistedEmailCache;
        return { ...current, ...cache, ...viewFromSnapshot(cache) };
      },
    },
  ),
);

// Copy-then-delete across accounts (webmail `crossAccountMoveEmails`, 1.7.2):
// download each message's blob from the source account, upload it to the
// target account, Email/import it into the target folder with its keywords,
// then destroy the original. Online only — there is no idempotent replay.
async function crossAccountMove(targets: Email[], from: MailboxRef, to: MailboxRef): Promise<void> {
  if (!useNetworkStore.getState().online || !jmapClient.isConnected) {
    throw new Error(t('email_list.cross_account_move_offline', 'Moving between accounts needs a connection'));
  }
  const { uploadBytes } = await import('../api/blob');
  for (const e of targets) {
    const full = e.blobId ? e : await getFullEmail(e.id, from.accountId);
    if (!full.blobId) throw new Error('Message has no blob');
    const bytes = await jmapClient.fetchBlobArrayBuffer(full.blobId, undefined, 'message/rfc822', from.accountId);
    const { blobId } = await uploadBytes(new Uint8Array(bytes), 'message/rfc822', to.accountId);
    const keywords: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(e.keywords ?? {})) if (v) keywords[k] = true;
    await importEmailBlob(blobId, to.id, keywords, to.accountId);
    await apiDestroyEmails([e.id], from.accountId);
  }
}

// ── Refresh implementations (wrapped by coalesceRefresh above) ─────────

function retain(current: string[], ids: string[]): string[] {
  const set = new Set(current);
  for (const id of ids) set.add(id);
  return [...set];
}

// Whether setting `token` to `on` makes a row stop matching the open Unread,
// Starred or tag view (the rows are then retained, like markRead/toggleStar).
function leavesView(filters: EmailFilters, token: string, on: boolean): boolean {
  if (!on && filters.keyword === token) return true;
  if (token === '$seen') return filters.isUnread === on;
  if (token === '$flagged') return filters.isStarred !== undefined && filters.isStarred !== on;
  return false;
}

/** "Parent / Child" path of a folder for toasts, like the webmail (1.5.0). */
function mailboxPath(mailboxes: Mailbox[], mailboxId: string): string | undefined {
  const byId = new Map(mailboxes.map((m) => [m.id, m]));
  let node = byId.get(mailboxId);
  if (!node) return undefined;
  const parts = [node.name];
  let guard = 0;
  while (node?.parentId && guard++ < 16) {
    node = byId.get(node.parentId);
    if (node) parts.unshift(node.name);
  }
  return parts.join(' / ');
}

async function fetchMailboxesImpl(activeAccountId: string): Promise<void> {
  const get = useEmailStore.getState;
  const set = useEmailStore.setState;
    const prevState = get().mailboxState;
    // Swap in a freshly-synced set of own folders while leaving the shared
    // (group account) ones alone, and vice versa — the two are fetched by
    // separate calls and must not clobber each other.
    const replaceOwn = (own: Mailbox[], mailboxState?: string) => {
      set({
        mailboxes: [...own, ...get().mailboxes.filter((m) => m.isShared)],
        ...(mailboxState !== undefined ? { mailboxState } : {}),
      });
    };

    try {
      let drainAgain = false;

      // Incremental path: ask for just what changed since last time. Fall
      // through to a full refetch when the server can't compute the diff or
      // we have no previous state to compare against.
      let syncedOwn = false;
      if (prevState) {
        const changes = await getMailboxChanges(prevState);
        // Bail if the user switched accounts during the await — anything we
        // set() now would land in the wrong account's bucket.
        if (get().activeAccountId !== activeAccountId) return;
        if (changes) {
          syncedOwn = true;
          // No changes at all — keep the cached list, just bump the state.
          if (
            changes.created.length === 0 &&
            changes.updated.length === 0 &&
            changes.destroyed.length === 0
          ) {
            set({ mailboxState: changes.newState });
          } else {
            const toFetch = [...changes.created, ...changes.updated];
            const fetched = toFetch.length > 0
              ? (await getMailboxesByIds(toFetch)).list
              : [];
            if (get().activeAccountId !== activeAccountId) return;
            const destroyed = new Set(changes.destroyed);
            const byId = new Map<string, Mailbox>();
            for (const m of get().mailboxes) {
              if (!m.isShared) byId.set(m.id, m);
            }
            for (const m of fetched) byId.set(m.id, m);
            for (const id of destroyed) byId.delete(id);
            replaceOwn(
              Array.from(byId.values()),
              changes.hasMoreChanges ? prevState : changes.newState,
            );
            // hasMoreChanges = there are still pending changes past the
            // server's response cap. Run the same path again to drain.
            drainAgain = changes.hasMoreChanges;
          }
        }
        // changes === null → cannotCalculateChanges. Fall through to full.
      }

      if (!syncedOwn) {
        const { list, state } = await getMailboxesWithState();
        if (get().activeAccountId !== activeAccountId) return;
        replaceOwn(list, state);
      }

      // Shared/group accounts have their own Mailbox state tokens, and there
      // are only ever a handful of them, so they're re-read in full rather
      // than diffed. Failing to reach one must not lose the own folders we
      // just synced, hence the separate try.
      try {
        const shared = await getSharedMailboxes();
        if (get().activeAccountId !== activeAccountId) return;
        set({ mailboxes: [...get().mailboxes.filter((m) => !m.isShared), ...shared] });
      } catch (err) {
        console.warn('[email-store] shared mailbox fetch failed:', err);
      }

      if (drainAgain) void get().fetchMailboxes();
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

  // Stalwart provisions the system folders lazily on first login (#217): an
  // empty or failed first Mailbox/get gets one automatic retry after ~2 s.
  if (get().mailboxes.length === 0 && !provisionRetried.has(activeAccountId)) {
    provisionRetried.add(activeAccountId);
    setTimeout(() => {
      if (get().activeAccountId === activeAccountId && get().mailboxes.length === 0) {
        void get().fetchMailboxes();
      }
    }, 2000);
  }
}

// Record Thread/get results as conversation sizes for the list's badges.
function withThreadCounts(counts: Record<string, number>, threads: Thread[]): Record<string, number> {
  if (threads.length === 0) return counts;
  const next = { ...counts };
  for (const th of threads) next[th.id] = th.emailIds.length;
  return next;
}

// Conversation sizes for rows no list page brought any for: restored from a
// snapshot, or added by Email/queryChanges. Fire-and-forget; the loaded-page
// count stands in until they land (and if the request fails).
async function fillThreadCounts(emails: Email[], accountId: string | undefined): Promise<void> {
  if (useSettingsStore.getState().disableThreading) return;
  const { threadCounts, currentMailboxId, activeAccountId } = useEmailStore.getState();
  const missing = Array.from(new Set(
    emails.map((e) => e.threadId).filter((id) => id && threadCounts[id] === undefined),
  ));
  if (missing.length === 0) return;
  try {
    const threads = await getThreads(missing, accountId);
    const now = useEmailStore.getState();
    if (now.currentMailboxId !== currentMailboxId || now.activeAccountId !== activeAccountId) return;
    useEmailStore.setState({ threadCounts: withThreadCounts(now.threadCounts, threads) });
  } catch {
    /* keep the loaded-page count */
  }
}

async function refreshEmailsImpl(): Promise<void> {
  const get = useEmailStore.getState;
  const set = useEmailStore.setState;
    const state = get();
    const { currentMailboxId, searchQuery, filters, emails: existing, activeAccountId } = state;
    if (!currentMailboxId) return;
    if (!jmapClientServesActiveAccount(activeAccountId)) return;
    set({ loading: true, error: null });

    // A shared (group account) folder is queried against its owning account
    // with its unprefixed id; own folders resolve to no override at all.
    const ref = refFor(state.mailboxes, currentMailboxId);
    // The Email state this folder's list was last synced at: the list's own
    // baseline for Email/changes (webmail `emailListSync`).
    const emailState = state.emailStates[currentMailboxId];
    const scope = queryScope(state, ref);
    const filter = buildJmapFilter(searchQuery, filters);
    const { emailsPerPage: limit, mailSortAscending: sortAscending } =
      useSettingsStore.getState();
    const orderKey = orderFingerprint();
    let sort = await resolveSort(state, scope.accountId);
    const baseView = isBaseView(searchQuery, filters);

    // A response that lands after the user switched account/mailbox or
    // changed search/filters/sort must not overwrite the newer view.
    const viewChanged = () =>
      get().activeAccountId !== activeAccountId ||
      get().currentMailboxId !== currentMailboxId ||
      get().searchQuery !== searchQuery ||
      get().filters !== filters ||
      orderFingerprint() !== orderKey;
    if (viewChanged()) return;

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
      // Incremental sync path: requires the base unfiltered view, a known
      // queryState (so Email/queryChanges has something to diff against)
      // AND the list's Email state (so Email/changes can refresh rows it
      // already holds). Anything else — search, filter active, first-ever
      // load — falls through to a full re-query.
      if (
        baseView &&
        snap?.queryState &&
        emailState &&
        snap.emails.length >= Math.min(limit, snap.total)
      ) {
        const baseEmails = snap.emails;
        const queryChanges = await getEmailQueryChanges(ref.id, snap.queryState, {
          sort,
          filter: undefined,
          accountId: ref.accountId,
        });
        if (queryChanges) {
          // What's in the visible window now: drop removed ids, then apply
          // added (id, index) entries. Newly added ids need bodies fetched.
          const removed = new Set(queryChanges.removed);
          const addedIds = queryChanges.added.map((a) => a.id);

          // Email/changes catches updates to messages already in our list
          // (e.g. another device toggled $seen) that queryChanges wouldn't
          // report. It runs from the list's own state, so changes made while
          // another folder was open are not skipped.
          let updatedIds: string[] = [];
          let destroyedExtra: string[] = [];
          let nextEmailState: string | undefined = emailState;
          // Drain `hasMoreChanges`: the server caps one response, so keep
          // asking from the returned state until the delta is complete
          // (bounded so a runaway server can't loop us forever).
          let since: string | undefined = emailState;
          for (let round = 0; since && round < 10; round++) {
            const ec = await getEmailChanges(since, undefined, ref.accountId);
            if (!ec) {
              // cannotCalculateChanges → forget the state so the next
              // refresh re-queries the list and records a fresh one.
              nextEmailState = undefined;
              break;
            }
            updatedIds.push(...ec.updated);
            destroyedExtra.push(...ec.destroyed);
            nextEmailState = ec.newState;
            since = ec.hasMoreChanges && ec.newState !== since ? ec.newState : undefined;
          }

          // Fetch every added id, including ones the list already holds:
          // `inMailbox` is a mutable filter, so the server reports each
          // updated message as removed and re-added, and that row has to
          // come back at its new index with fresh keywords. `updatedIds`
          // refreshes rows Email/changes saw change in place.
          const existingById = new Map(baseEmails.map((e) => [e.id, e]));
          const idsToFetch = Array.from(new Set([
            ...addedIds,
            ...updatedIds.filter((id) => existingById.has(id)),
          ]));
          let fetched: Email[] = [];
          if (idsToFetch.length > 0) {
            fetched = (await getEmailsWithState(idsToFetch, ref.accountId)).list;
          }

          // Rebuild the visible window order: start with existing emails,
          // drop removed/destroyed, then splice added at their indices.
          // Added ids are dropped too, so a row the server re-adds without
          // also listing it as removed can't end up in the list twice.
          const allDestroyed = new Set([...destroyedExtra, ...removed, ...addedIds]);
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
            // An index past the end of the loaded window belongs to a page
            // load-more hasn't fetched; clamping it onto the end would skip
            // the rows in between.
            if (!email || entry.index > out.length) continue;
            out.splice(entry.index, 0, email);
          }
          // Keep the window at what the user had scrolled to (at least one
          // page) — Email/queryChanges can push entries past the original
          // window when many were added; `total` still drives load-more.
          const trimmed = out.slice(0, Math.max(limit, baseEmails.length));

          const nextQueryState = queryChanges.newQueryState;
          const nextTotal = queryChanges.total;

          if (viewChanged()) return;

          set({
            emails: trimmed,
            totalEmails: nextTotal,
            queryState: nextQueryState,
            emailStates: withEmailState(
              get().emailStates,
              currentMailboxId,
              nextEmailState,
            ),
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
          void fillThreadCounts(trimmed, ref.accountId);
          return;
        }
        // queryChanges === null → cannotCalculateChanges. Drop our queryState
        // and fall through to a full re-query, which will repopulate it.
      }

      // Full re-query path. Used when there's no prior queryState, when the
      // user has search/filters active (queryState only tracks the base
      // query), or when the server returned cannotCalculateChanges above.
      // One request carries the query, its messages and (for the
      // conversation badges) their threads.
      const threads = !useSettingsStore.getState().disableThreading;
      let queryRes: Awaited<ReturnType<typeof queryEmailPage>>;
      try {
        queryRes = await queryEmailPage(scope.mailboxId, { limit, sort, filter, accountId: scope.accountId, threads });
      } catch (err) {
        // The server refused a hasKeyword comparator (unsupportedSort): drop
        // the keyword levels for this account and re-run with the rest.
        if (!isUnsupportedSort(err)) throw err;
        markKeywordSortUnsupported(scope.accountId ?? jmapClient.accountId);
        sort = await resolveSort(state, scope.accountId);
        queryRes = await queryEmailPage(scope.mailboxId, { limit, sort, filter, accountId: scope.accountId, threads });
      }

      if (viewChanged()) return;

      const updates: Partial<EmailState> = {
        // Rows the user just read/unstarred in this filtered view stay put
        // until the view is re-opened, instead of vanishing under them.
        emails: baseView ? queryRes.list : mergeRetainedRows(get().emails, queryRes.list, get().retainedIds),
        totalEmails: queryRes.total,
        threadCounts: withThreadCounts(get().threadCounts, queryRes.threads),
        loading: false,
      };
      if (baseView) {
        updates.queryState = queryRes.queryState;
        // Email/get reports a state even for an empty result; should a
        // server leave it out, keep the list's previous one rather than
        // dropping it.
        if (queryRes.state) {
          updates.emailStates = withEmailState(get().emailStates, currentMailboxId, queryRes.state);
        }
        updates.mailboxSnapshots = {
          ...get().mailboxSnapshots,
          [currentMailboxId]: {
            emails: queryRes.list,
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
              ref.id,
              Math.max(limit, 50),
              ref.accountId,
            );
            if (sortAscending) cached.reverse();
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
}
