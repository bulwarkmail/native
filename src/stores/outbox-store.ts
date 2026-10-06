// Persistent offline action queue ("outbox") for mail mutations.
//
// Every mutation the app performs on a message reduces to one of four
// idempotent primitives:
//   - keywords:  set or clear individual keywords (read/unread, flag, pin, …)
//   - mailboxes: replace the full mailboxIds map (move, trash)
//   - archive:   file into Archive with the user's year/month auto-foldering
//   - destroy:   permanently delete the message
//
// Because each primitive assigns a target state rather than a delta, replaying
// it is safe regardless of the server's current state, so we can coalesce
// repeated edits to the same message (last-write-wins) and retry on a flaky
// connection without corrupting anything. Keyword ops name only the keywords
// the user changed, so replay never touches ones another client set meanwhile.
//
// When the device is online and nothing is already queued for a message, the
// op runs immediately (preserving today's behaviour, including surfacing real
// server errors to the caller). Otherwise it's persisted to AsyncStorage and
// replayed by flush() once connectivity returns. Storage is keyed per account,
// mirroring offline-cache-store, so queues never leak between logins.

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { generateUUID } from '../lib/uuid';
import { isTransientNetworkError, isAuthError, isStaleLoad, isAccountNotInSession } from '../lib/network-error';
import { activeAppAccountId, clientServesActiveAccount } from '../lib/active-client-account';
import { toast } from './toast-store';
import { t } from './locale-store';
import { useNetworkStore } from './network-store';
import { jmapClient } from '../api/jmap-client';
import {
  patchKeywordsForEmails, setEmailMailboxes, destroyEmails, archiveEmails, unprefixMailboxId,
} from '../api/email';
import { inAccount, type OpScope } from '../api/op-scope';
import type { KeywordPatch } from '../lib/keyword-patch';
import type { ArchiveMode } from './settings-store';

const KEY_PREFIX = 'webmail:outbox:v1:';
const FAILED_SUFFIX = ':failed';
// Give up on an op that the server keeps rejecting (a non-transient failure)
// after this many attempts so one poison entry can't wedge the whole queue.
const MAX_ATTEMPTS = 5;
// Back-off after a transient break (a blip NetInfo never reports, a server
// hiccup): 5 s, 15 s, 45 s, … capped at 5 minutes.
const RETRY_BASE_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;

function storageKey(accountId: string): string {
  return `${KEY_PREFIX}${accountId}`;
}

// `accountId` is the JMAP account the message lives under. Absent for the
// user's own mail (the client's primary account); set when the message belongs
// to a shared/group account, so replay after a reconnect still targets it.
export type OutboxOp =
  | { kind: 'keywords'; emailId: string; accountId?: string; patch: KeywordPatch }
  | { kind: 'mailboxes'; emailId: string; accountId?: string; mailboxIds: Record<string, boolean> }
  | {
      /**
       * Archive with the configured year/month auto-foldering re-applied on
       * replay (the plain `mailboxes` fallback used to land in the Archive
       * root). `archiveMailboxId` is the raw id of the account's Archive.
       */
      kind: 'archive';
      emailId: string;
      accountId?: string;
      archiveMailboxId: string;
      mode: ArchiveMode;
      receivedAt: string;
    }
  | { kind: 'destroy'; emailId: string; accountId?: string };

export interface OutboxEntry {
  id: string;
  op: OutboxOp;
  createdAt: number;
  attempts: number;
  lastError?: string;
}

interface OutboxState {
  // Currently-loaded account bucket. null = detached (no reads/writes).
  activeAccountId: string | null;
  entries: OutboxEntry[];
  /**
   * Ops the server rejected repeatedly. They are kept (not dropped silently)
   * so the user can retry or discard them; the list view is refreshed when an
   * op lands here so the optimistic edit is reverted.
   */
  failed: OutboxEntry[];
  hydrated: boolean;
  flushing: boolean;
  /** Set after an authentication failure; cleared by setAccount()/login. */
  paused: boolean;

  setAccount: (accountId: string | null) => Promise<void>;
  hydrate: () => Promise<void>;
  /** `actedAt`: when the user made `op`, if before now (see `coalesce`). */
  enqueue: (op: OutboxOp, actedAt?: number) => void;
  count: () => number;
  pendingForEmail: (emailId: string) => OutboxEntry[];
  flush: () => Promise<void>;
  /** Move every failed op back into the queue and flush. */
  retryFailed: () => Promise<void>;
  discardFailed: () => void;
  clear: () => Promise<void>;
  /** Remove one account's queued and failed ops from storage (for sign-out), active or not. */
  clearAccount: (accountId: string) => Promise<void>;
}

function persist(accountId: string, entries: OutboxEntry[]): void {
  void AsyncStorage.setItem(storageKey(accountId), JSON.stringify(entries)).catch((err) => {
    console.warn('[outbox] persist failed', err);
  });
}

function persistFailed(accountId: string, failed: OutboxEntry[]): void {
  void AsyncStorage.setItem(storageKey(accountId) + FAILED_SUFFIX, JSON.stringify(failed)).catch((err) => {
    console.warn('[outbox] persist failed-list failed', err);
  });
}

// Keyword ops queued by earlier builds carried the message's whole keyword
// map, which the server took as a replacement. That map can't tell which
// keyword the user changed, so it replays as a patch that only sets the
// keywords it holds (clearing the other half of the exclusive `$junk` /
// `$notjunk` pair) and clears nothing else: an unread or unstar queued back
// then is lost, but no star or tag another client set gets erased.
type LegacyKeywordsOp = { kind: 'keywords'; emailId: string; accountId?: string; keywords: Record<string, boolean> };

function upgradeEntry(entry: OutboxEntry): OutboxEntry {
  const op = entry.op as OutboxOp | LegacyKeywordsOp;
  if (op.kind !== 'keywords' || !('keywords' in op)) return entry;
  const patch: KeywordPatch = {};
  for (const [keyword, on] of Object.entries(op.keywords ?? {})) if (on) patch[keyword] = true;
  if (patch.$junk && !patch.$notjunk) patch.$notjunk = null;
  if (patch.$notjunk && !patch.$junk) patch.$junk = null;
  return { ...entry, op: { kind: 'keywords', emailId: op.emailId, accountId: op.accountId, patch } };
}

async function load(accountId: string, suffix = ''): Promise<OutboxEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(accountId) + suffix);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return (parsed as OutboxEntry[]).map(upgradeEntry);
    }
  } catch (err) {
    console.warn('[outbox] hydrate failed', err);
  }
  return [];
}

/**
 * Run `op` on the connection and JMAP account `at` names, passed explicitly
 * to every API call: the op's own account, or for a legacy op (see `flush`)
 * the primary account of the connection that serves the outbox's account.
 * Every request of the op is bound to that connection.
 */
async function runOp(op: OutboxOp, at: OpScope): Promise<void> {
  const accountId = at.accountId;
  switch (op.kind) {
    case 'keywords':
      return patchKeywordsForEmails([op.emailId], op.patch, at);
    case 'mailboxes':
      return setEmailMailboxes(op.emailId, op.mailboxIds, at);
    case 'archive': {
      // The foldering needs the account's current folder list; read it from
      // the email store lazily (it imports this module, so no static import).
      const { useEmailStore } = await import('./email-store');
      const all = useEmailStore.getState().mailboxes;
      // Own mail is stamped with the primary account id; any other id
      // selects that shared account's folders (none listed: none reused).
      const own = !accountId || accountId === primaryAccountId();
      const scoped = all
        .filter((m) => (own ? !m.isShared : m.isShared && m.accountId === accountId))
        .map((m) => (m.isShared
          ? { ...m, id: m.originalId ?? m.id, parentId: m.parentId ? unprefixMailboxId(m.parentId, m.accountId) : m.parentId }
          : m));
      await archiveEmails(
        [{ id: op.emailId, receivedAt: op.receivedAt }],
        op.archiveMailboxId,
        op.mode,
        scoped,
        at,
      );
      return;
    }
    case 'destroy':
      return destroyEmails([op.emailId], at);
  }
}

/**
 * The live connection and its primary JMAP account, taken in one step, or
 * null when the client has none. Callers take it right after checking that
 * the connection serves the outbox's account (`servesAccount`).
 */
function connectionScope(): OpScope | null {
  const accountId = primaryAccountId();
  return accountId ? { gen: jmapClient.connectionGen, accountId } : null;
}

/** The client's primary JMAP account id, or undefined when it has none. */
function primaryAccountId(): string | undefined {
  try {
    return jmapClient.accountId || undefined;
  } catch {
    return undefined;
  }
}

/**
 * `op` with its JMAP account id made explicit. Own mail (no id) gets the
 * client's primary account id, taken now, and only while the client serves
 * the outbox's account; otherwise the op is left as it is and is handled at
 * replay like a legacy op.
 */
function stampAccount(op: OutboxOp, at?: OpScope | null): OutboxOp {
  if (op.accountId) return op;
  if (at !== undefined) return at ? { ...op, accountId: at.accountId } : op;
  const outboxAccount = useOutboxStore.getState().activeAccountId;
  if (!outboxAccount || !servesAccount(outboxAccount)) return op;
  const primary = primaryAccountId();
  return primary ? { ...op, accountId: primary } : op;
}

// A move-like op replaces the whole mailboxIds map; `mailboxes` and `archive`
// therefore coalesce with each other (the latest wins).
function opFamily(op: OutboxOp): string {
  return op.kind === 'archive' ? 'mailboxes' : op.kind;
}

/**
 * `entries` with `op` queued, coalesced per message (see `enqueue`), or null
 * when nothing changes (a destroy is queued already). `actedAt`, when given,
 * is when the user made `op` (an action queued only after its online attempt
 * failed): an entry queued after that is the later action and wins.
 */
function coalesce(entries: OutboxEntry[], op: OutboxOp, actedAt?: number): OutboxEntry[] | null {
  const createdAt = actedAt ?? Date.now();
  let next = [...entries];
  // Message identity is (account, id): JMAP ids are only unique within an
  // account, and the queue can hold ops for shared accounts alongside own.
  const sameMessage = (other: OutboxOp) =>
    other.emailId === op.emailId && other.accountId === op.accountId;

  if (op.kind === 'destroy') {
    // Destroy is terminal — drop any pending edits for this message and
    // append the destroy so it runs last.
    next = next.filter((e) => !sameMessage(e.op));
    next.push({ id: generateUUID(), op, createdAt, attempts: 0 });
    return next;
  }
  // A queued destroy wins; further edits to a doomed message are pointless.
  if (next.some((e) => sameMessage(e.op) && e.op.kind === 'destroy')) return null;
  // Coalesce: replace any pending op of the same family for this message
  // (full-state replace makes the latest one authoritative; keyword
  // patches merge, the later value winning per keyword). Keep its
  // position so creation order is preserved for replay.
  const idx = next.findIndex((e) => sameMessage(e.op) && opFamily(e.op) === opFamily(op));
  if (idx >= 0) {
    const prev = next[idx].op;
    const prevIsLater = actedAt !== undefined && next[idx].createdAt > actedAt;
    let merged: OutboxOp;
    if (prev.kind === 'keywords' && op.kind === 'keywords') {
      merged = { ...op, patch: prevIsLater ? { ...op.patch, ...prev.patch } : { ...prev.patch, ...op.patch } };
    } else {
      merged = prevIsLater ? prev : op;
    }
    next[idx] = { ...next[idx], op: merged, attempts: 0, lastError: undefined };
  } else {
    next.push({ id: generateUUID(), op, createdAt, attempts: 0 });
  }
  return next;
}

/**
 * Serialised writes to the stored queue of an account that is not the
 * active one; its load waits for them so none is lost to a switch back.
 */
const offBucketWrites = new Map<string, Promise<void>>();

function settledOffBucket(accountId: string): Promise<void> {
  return offBucketWrites.get(accountId) ?? Promise.resolve();
}

/**
 * Queue `ops` in `accountId`'s stored queue without touching the active
 * account's bucket. Existing entries are kept (and coalesced with like
 * `enqueue`); the parked (`:failed`) list is not touched. If the account is
 * active again by the time this runs, the ops go through `enqueue`.
 */
function enqueueForAccount(accountId: string, ops: OutboxOp[], createdAt: number): Promise<boolean> {
  const intoMemory = () => {
    for (const op of ops) useOutboxStore.getState().enqueue(op, createdAt);
  };
  const run = async (): Promise<'memory' | 'stored' | null> => {
    const store = useOutboxStore.getState();
    if (store.activeAccountId === accountId && store.hydrated) {
      intoMemory();
      return 'memory';
    }
    const key = storageKey(accountId);
    let entries: OutboxEntry[];
    try {
      const raw = await AsyncStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) throw new Error('not a list');
      entries = (parsed as OutboxEntry[]).map(upgradeEntry);
    } catch (err) {
      // Unreadable: writing would overwrite whatever is there.
      console.warn('[outbox] could not queue for an inactive account', err);
      return null;
    }
    for (const op of ops) entries = coalesce(entries, op, createdAt) ?? entries;
    await AsyncStorage.setItem(key, JSON.stringify(entries));
    return 'stored';
  };
  const write = settledOffBucket(accountId).then(run).catch((err) => {
    console.warn('[outbox] queue for an inactive account failed', err);
    return null;
  });
  // The account's load waits for the write only (not for the step below,
  // which waits for that load).
  const done = write.then(() => undefined);
  offBucketWrites.set(accountId, done);
  void done.then(() => {
    if (offBucketWrites.get(accountId) === done) offBucketWrites.delete(accountId);
  });
  return write.then(async (where) => {
    // Switched back while it ran, and that load may have read the queue
    // before the write: add the ops in memory too once it is loaded (the
    // coalescing collapses a second copy of an op into the first).
    if (where === 'stored' && useOutboxStore.getState().activeAccountId === accountId) {
      await untilHydratedOrLeft(accountId);
      if (useOutboxStore.getState().activeAccountId === accountId) intoMemory();
    }
    return where !== null;
  });
}

/** Resolves once `accountId`'s bucket is loaded, or another account is active. */
function untilHydratedOrLeft(accountId: string): Promise<void> {
  const ready = (s: OutboxState) => s.activeAccountId !== accountId || s.hydrated;
  if (ready(useOutboxStore.getState())) return Promise.resolve();
  return new Promise((resolve) => {
    const unsub = useOutboxStore.subscribe((s) => {
      if (!ready(s)) return;
      unsub();
      resolve();
    });
  });
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;

function clearRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
}

function scheduleRetry(): void {
  clearRetry();
  const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 3 ** retryAttempt);
  retryAttempt += 1;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void useOutboxStore.getState().flush();
  }, delay);
}

// Revert the optimistic edit the dropped op stood for: re-read the list.
async function refreshAfterDrop(): Promise<void> {
  try {
    const { useEmailStore } = await import('./email-store');
    const store = useEmailStore.getState();
    await Promise.all([store.fetchMailboxes(), store.refreshEmails()]);
  } catch (err) {
    console.warn('[outbox] refresh after drop failed', err);
  }
}

export const useOutboxStore = create<OutboxState>((set, get) => ({
  activeAccountId: null,
  entries: [],
  failed: [],
  hydrated: false,
  flushing: false,
  paused: false,

  setAccount: async (accountId) => {
    const state = get();
    if (state.activeAccountId === accountId) {
      if (!state.hydrated) await get().hydrate();
      set({ paused: false });
      return;
    }
    clearRetry();
    retryAttempt = 0;
    set({ activeAccountId: accountId, entries: [], failed: [], hydrated: false, paused: false });
    if (accountId) {
      await settledOffBucket(accountId);
      const [entries, failed] = await Promise.all([load(accountId), load(accountId, FAILED_SUFFIX)]);
      // Re-check in case another setAccount raced past us.
      if (get().activeAccountId !== accountId) return;
      set({ entries, failed, hydrated: true });
    } else {
      set({ hydrated: true });
    }
  },

  hydrate: async () => {
    const state = get();
    if (state.hydrated) return;
    const accountId = state.activeAccountId;
    if (!accountId) {
      set({ hydrated: true });
      return;
    }
    await settledOffBucket(accountId);
    const [entries, failed] = await Promise.all([load(accountId), load(accountId, FAILED_SUFFIX)]);
    if (get().activeAccountId !== accountId) return;
    set({ entries, failed, hydrated: true });
  },

  enqueue: (op, actedAt) => {
    const accountId = get().activeAccountId;
    if (!accountId) {
      console.warn('[outbox] enqueue with no active account; dropping op', op.kind);
      return;
    }
    const entries = coalesce(get().entries, stampAccount(op), actedAt);
    if (!entries) return;
    set({ entries });
    persist(accountId, entries);
  },

  count: () => get().entries.length,

  pendingForEmail: (emailId) => get().entries.filter((e) => e.op.emailId === emailId),

  flush: async () => {
    if (get().flushing || get().paused) return;
    const accountId = get().activeAccountId;
    if (!accountId) return;
    if (get().entries.length === 0) return;
    // Need a live client that's actually serving this account, and a network.
    if (!jmapClient.isConnected) return;
    if (!useNetworkStore.getState().online) return;
    // The connection must serve this account: during a switch the client can
    // already be on the next account while the outbox is still on this one.
    // Not an error; the next trigger (setAccount, online edge) retries.
    if (!servesAccount(accountId)) return;

    set({ flushing: true });
    let brokeTransient = false;
    let dropped = false;
    try {
      // Process oldest-first so dependent moves replay in the order they were
      // made. We snapshot the order but re-read the live list each iteration,
      // since a concurrent enqueue may have coalesced/removed entries.
      const ordered = [...get().entries].sort((a, b) => a.createdAt - b.createdAt);

      for (const snapshot of ordered) {
        if (get().activeAccountId !== accountId) break;     // account switched
        if (!useNetworkStore.getState().online) break;       // went offline
        if (!jmapClient.isConnected) break;
        if (!servesAccount(accountId)) break;                // client switched

        const entry = get().entries.find((e) => e.id === snapshot.id);
        if (!entry) continue;                                // removed/coalesced

        // An op without an account id was queued by an older build (own
        // mail), or while the client did not serve this account. It runs
        // against the primary account of the connection that serves this
        // outbox, checked just above; it is not migrated on disk.
        // The connection checked just above, taken once for every request of
        // this op (an archive may send several, after an await).
        const at = connectionScope();
        if (!at) break;
        const target = inAccount(at, entry.op.accountId);

        try {
          await runOp(entry.op, target);
          removeEntry(accountId, entry.id);
          retryAttempt = 0;
        } catch (err) {
          if (get().activeAccountId !== accountId) break;
          // Not sent: the client moved to another connection first. The op
          // stays as it is (no error, no attempt counted) for the next flush.
          // Except when the client does serve this account and the op names
          // a JMAP account its session no longer has (a shared account taken
          // away): that is the server's answer, counted like a rejection so
          // the op is parked rather than blocking the queue forever.
          if (isStaleLoad(err) && !(isAccountNotInSession(err) && servesAccount(accountId))) break;
          if (isAuthError(err)) {
            // Revoked password / expired session: nothing will succeed until
            // the user signs in again. Keep the queue and stop trying.
            recordError(accountId, entry.id, err, false);
            set({ paused: true });
            break;
          }
          if (isTransientNetworkError(err)) {
            // Connectivity blip — stop and retry with back-off.
            recordError(accountId, entry.id, err, false);
            brokeTransient = true;
            break;
          }
          // Server rejected it. Count the attempt; park it in `failed` once
          // we've given up so one bad op can't block everything behind it.
          const attempts = (entry.attempts ?? 0) + 1;
          if (attempts >= MAX_ATTEMPTS) {
            console.warn('[outbox] parking op after repeated failures', entry.op.kind, err);
            moveToFailed(accountId, entry.id, err);
            dropped = true;
          } else {
            recordError(accountId, entry.id, err, true);
          }
        }
      }
    } finally {
      set({ flushing: false });
    }
    if (brokeTransient && get().entries.length > 0) scheduleRetry();
    if (dropped) void refreshAfterDrop();
  },

  retryFailed: async () => {
    const accountId = get().activeAccountId;
    if (!accountId) return;
    const failed = get().failed;
    if (failed.length === 0) return;
    const entries = [
      ...get().entries,
      ...failed.map((e) => ({ ...e, attempts: 0, lastError: undefined })),
    ];
    set({ entries, failed: [], paused: false });
    persist(accountId, entries);
    persistFailed(accountId, []);
    await get().flush();
  },

  discardFailed: () => {
    const accountId = get().activeAccountId;
    set({ failed: [] });
    if (accountId) persistFailed(accountId, []);
  },

  clear: async () => {
    const accountId = get().activeAccountId;
    clearRetry();
    set({ entries: [], failed: [] });
    if (accountId) {
      await AsyncStorage.removeItem(storageKey(accountId)).catch(() => undefined);
      await AsyncStorage.removeItem(storageKey(accountId) + FAILED_SUFFIX).catch(() => undefined);
    }
  },

  clearAccount: async (accountId) => {
    // A queue write for it still running would bring the key back.
    await settledOffBucket(accountId);
    // Only the active account's ops live in memory; another account's
    // removal must leave them alone.
    if (get().activeAccountId === accountId) {
      clearRetry();
      set({ entries: [], failed: [] });
    }
    await AsyncStorage.multiRemove([storageKey(accountId), storageKey(accountId) + FAILED_SUFFIX])
      .catch(() => undefined);
  },
}));

// ── Internal helpers that mutate+persist the live list ──────────────────────

/** The client serves app account `accountId`, and the app shows it as active. */
function servesAccount(accountId: string): boolean {
  return activeAppAccountId() === accountId && clientServesActiveAccount();
}

function removeEntry(accountId: string, id: string): void {
  const store = useOutboxStore.getState();
  if (store.activeAccountId !== accountId) return;
  const entries = store.entries.filter((e) => e.id !== id);
  useOutboxStore.setState({ entries });
  persist(accountId, entries);
}

function moveToFailed(accountId: string, id: string, err: unknown): void {
  const store = useOutboxStore.getState();
  if (store.activeAccountId !== accountId) return;
  const entry = store.entries.find((e) => e.id === id);
  const entries = store.entries.filter((e) => e.id !== id);
  const message = err instanceof Error ? err.message : String(err);
  const failed = entry
    ? [...store.failed, { ...entry, attempts: (entry.attempts ?? 0) + 1, lastError: message }]
    : store.failed;
  useOutboxStore.setState({ entries, failed });
  persist(accountId, entries);
  persistFailed(accountId, failed);
}

function recordError(accountId: string, id: string, err: unknown, incrementAttempt: boolean): void {
  const store = useOutboxStore.getState();
  if (store.activeAccountId !== accountId) return;
  const message = err instanceof Error ? err.message : String(err);
  const entries = store.entries.map((e) =>
    e.id === id
      ? { ...e, attempts: incrementAttempt ? (e.attempts ?? 0) + 1 : e.attempts, lastError: message }
      : e,
  );
  useOutboxStore.setState({ entries });
  persist(accountId, entries);
}

// ── Public entry points used by the email-store mutations ───────────────────

export interface ApplyResult {
  /** True when the op was deferred to the queue instead of running now. */
  queued: boolean;
}

// Run a batch of ops now when we're online and nothing is already queued for
// any of the affected messages; otherwise queue them for later replay. An
// optional `onlineRun` lets callers keep a richer single-round-trip online
// path (e.g. batch move) while still degrading to the idempotent primitives
// offline — which replay with the same semantics (an `archive` op re-applies
// the year/month foldering on replay).
//
// The online path runs only while the connection serves the outbox's account.
// During a switch the app can already show the next account (whose rows the
// user acts on) while the client still serves the previous one; an op run
// then would land on the previous account's message with the same id. Such
// ops are queued and replayed once the account is served. `onlineRun` gets
// the connection the action runs on (`at`, own primary account), taken here
// once, and passes it (or `inAccount(at, …)`) to every API call it makes.
export async function applyOrQueueBatch(
  ops: OutboxOp[],
  onlineRun?: (at: OpScope) => Promise<void>,
): Promise<ApplyResult> {
  if (ops.length === 0) return { queued: false };
  const store = useOutboxStore.getState();
  // The account this action is made on, and when: an account switch during
  // the online run must not move its ops to the account switched to.
  const accountId = store.activeAccountId;
  const startedAt = Date.now();
  const at = accountId && servesAccount(accountId) ? connectionScope() : null;
  // Each op names its JMAP account, own mail included (taken now, while the
  // client serves this account; unserved, left for replay to fill in).
  ops = ops.map((op) => stampAccount(op, at));
  const network = useNetworkStore.getState().online && jmapClient.isConnected && !store.paused;
  const online = network && at !== null;
  const hasQueued = ops.some((op) =>
    store.entries.some((e) => e.op.emailId === op.emailId),
  );

  if (online && !hasQueued) {
    try {
      const scope = at!;
      await (onlineRun
        ? onlineRun(scope)
        : Promise.all(ops.map((op) => runOp(op, inAccount(scope, op.accountId)))).then(() => undefined));
      return { queued: false };
    } catch (err) {
      // A real server/validation error should bubble up exactly like before.
      // Only fall through to the queue when the failure is connectivity, or a
      // stop before sending because the client moved to another connection.
      const stale = isStaleLoad(err);
      if (!stale && !isTransientNetworkError(err)) throw err;
      if (accountId && useOutboxStore.getState().activeAccountId !== accountId) {
        // The user switched away meanwhile. The ops go to the queue of the
        // account they were made on (they carry their JMAP account; flush only
        // replays them while that account is active). The caller still sees
        // the failure, so it applies nothing to the account now shown.
        if (await enqueueForAccount(accountId, ops, startedAt)) {
          toast.info(t('outbox.finish_on_switch_back', 'This change will finish when you switch back to that account'));
        }
        throw err;
      }
    }
  }

  if (accountId && !useOutboxStore.getState().hydrated) {
    // Its queue is still loading: queueing in memory now would be replaced by
    // the load, and persisting would overwrite the stored queue.
    await enqueueForAccount(accountId, ops, startedAt);
  } else {
    for (const op of ops) useOutboxStore.getState().enqueue(op, startedAt);
  }
  if (network) void useOutboxStore.getState().flush();
  return { queued: true };
}

export function applyOrQueue(op: OutboxOp, onlineRun?: (at: OpScope) => Promise<void>): Promise<ApplyResult> {
  return applyOrQueueBatch([op], onlineRun);
}
