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
// replayed by flush() once connectivity returns, and not before the auth store
// has resumed the account (see `resumed`). Storage is keyed per account,
// mirroring offline-cache-store, so queues never leak between logins.
//
// Messages sent while offline wait here too (`sends`, see lib/send-queue.ts):
// the same flush sends them after the mutation ops, once each, looking for
// a copy of the message first whenever an earlier attempt may have got
// through.

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { generateUUID } from '../lib/uuid';
import { generateAccountId } from '../lib/account-utils';
import { isTransientNetworkError, isAuthError } from '../lib/network-error';
import { useNetworkStore } from './network-store';
import { jmapClient } from '../api/jmap-client';
import {
  patchKeywordsForEmails, setEmailMailboxes, destroyEmails, archiveEmails, unprefixMailboxId,
} from '../api/email';
import type { KeywordPatch } from '../lib/keyword-patch';
import type { ArchiveMode } from './settings-store';
import {
  afterFailure, canCancel, classifySendFailure, newQueuedSend, restoreAfterRestart, startAttempt,
  type QueuedSend, type QueuedSendPayload,
} from '../lib/send-queue';

const KEY_PREFIX = 'webmail:outbox:v1:';
const FAILED_SUFFIX = ':failed';
const SENDS_SUFFIX = ':sends';
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
  /**
   * Messages sent while offline, oldest first: waiting, on their way, or
   * failed (kept until the user retries, moves them to Drafts or discards
   * them).
   */
  sends: QueuedSend[];
  hydrated: boolean;
  flushing: boolean;
  /** Set after an authentication failure; cleared by setAccount()/resume(). */
  paused: boolean;
  /**
   * False from attaching an account until the auth store calls resume() for
   * it, once the account's session is up and the server behind it was
   * checked (lib/server-change), and again while another account is being
   * signed in (suspend). Until then ops queue and flush waits: the JMAP
   * client may still serve the previous account, and a replaced server may
   * have given the queued ids to other messages.
   */
  resumed: boolean;

  setAccount: (accountId: string | null) => Promise<void>;
  /**
   * The account's session is up and its server was checked: load its queue
   * if needed, then replay it. Only for the account attached, which is the
   * one the mail list shows (the email store attaches it).
   */
  resume: (accountId: string) => Promise<void>;
  /**
   * Hold the queue while the JMAP client signs in to another account (one
   * being added). Returns the account it was resumed for, to resume should
   * that sign-in fail.
   */
  suspend: () => string | null;
  hydrate: () => Promise<void>;
  enqueue: (op: OutboxOp) => void;
  count: () => number;
  pendingForEmail: (emailId: string) => OutboxEntry[];
  flush: () => Promise<void>;
  /** Move every failed op back into the queue and flush. */
  retryFailed: () => Promise<void>;
  /**
   * Queue a message to send once online. `maybeSent`: an attempt already
   * went out without an answer. Returns the entry id, or null with no
   * account attached.
   */
  enqueueSend: (payload: QueuedSendPayload, opts?: { maybeSent?: boolean }) => string | null;
  /** Try a failed message again. */
  retrySend: (id: string) => Promise<void>;
  /**
   * Take a message out of the queue, not while it is on its way. With
   * `keepAsDraft` it is saved to Drafts first (needs the server); it stays
   * queued, as failed, when that fails. Resolves to whether it went.
   */
  cancelSend: (id: string, opts?: { keepAsDraft?: boolean }) => Promise<boolean>;
  discardFailed: () => void;
  clear: () => Promise<void>;
  /**
   * Drop an account's queued and failed ops, loaded or not. Every op names a
   * message by its server id, which a different server can have given to
   * another message (see lib/server-change). Resolves to how many went.
   */
  clearAccount: (accountId: string) => Promise<number>;
}

function persist(accountId: string, entries: OutboxEntry[]): void {
  void AsyncStorage.setItem(storageKey(accountId), JSON.stringify(entries)).catch((err) => {
    console.warn('[outbox] persist failed', err);
  });
}

function persistSends(accountId: string, sends: QueuedSend[]): void {
  void AsyncStorage.setItem(storageKey(accountId) + SENDS_SUFFIX, JSON.stringify(sends)).catch((err) => {
    console.warn('[outbox] persist sends failed', err);
  });
}

async function loadSends(accountId: string): Promise<QueuedSend[]> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(accountId) + SENDS_SUFFIX);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? restoreAfterRestart(parsed as QueuedSend[]) : [];
  } catch (err) {
    console.warn('[outbox] hydrate sends failed', err);
    return [];
  }
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

async function runOp(op: OutboxOp): Promise<void> {
  switch (op.kind) {
    case 'keywords':
      return patchKeywordsForEmails([op.emailId], op.patch, op.accountId);
    case 'mailboxes':
      return setEmailMailboxes(op.emailId, op.mailboxIds, op.accountId);
    case 'archive': {
      // The foldering needs the account's current folder list; read it from
      // the email store lazily (it imports this module, so no static import).
      const { useEmailStore } = await import('./email-store');
      const all = useEmailStore.getState().mailboxes;
      const scoped = all
        .filter((m) => (op.accountId ? m.isShared && m.accountId === op.accountId : !m.isShared))
        .map((m) => (m.isShared
          ? { ...m, id: m.originalId ?? m.id, parentId: m.parentId ? unprefixMailboxId(m.parentId, m.accountId) : m.parentId }
          : m));
      await archiveEmails(
        [{ id: op.emailId, receivedAt: op.receivedAt }],
        op.archiveMailboxId,
        op.mode,
        scoped,
        op.accountId,
      );
      return;
    }
    case 'destroy':
      return destroyEmails([op.emailId], op.accountId);
  }
}

// A move-like op replaces the whole mailboxIds map; `mailboxes` and `archive`
// therefore coalesce with each other (the latest wins).
function opFamily(op: OutboxOp): string {
  return op.kind === 'archive' ? 'mailboxes' : op.kind;
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAttempt = 0;

// Reads of a bucket from storage. A read still running when the account
// changes or its queue is cleared must not put the old entries back, so
// each one carries the epoch it started in; callers of the same account
// share the read in flight.
let loadEpoch = 0;
let bucketLoad: { accountId: string; epoch: number; promise: Promise<void> } | null = null;

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

// Whether the JMAP client serves the account (username@host) whose queue it
// is. The client moves to an account being added or switched to before the
// auth store moves the queue, and it serves no account while it loads one.
// An op replayed through another account's session names the message by an
// id that account may use for another one: own-mail ops take the client's
// primary account.
function clientServes(accountId: string | null): boolean {
  if (!accountId || !jmapClient.isConnected) return false;
  const { username, serverUrl } = jmapClient;
  return !!username && !!serverUrl && generateAccountId(username, serverUrl) === accountId;
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

// Load the attached account's bucket, or join the read already under way.
function loadBucket(accountId: string): Promise<void> {
  if (bucketLoad && bucketLoad.accountId === accountId && bucketLoad.epoch === loadEpoch) {
    return bucketLoad.promise;
  }
  const epoch = ++loadEpoch;
  const promise = (async () => {
    const [entries, failed, sends] = await Promise.all([
      load(accountId), load(accountId, FAILED_SUFFIX), loadSends(accountId),
    ]);
    const store = useOutboxStore.getState();
    if (epoch !== loadEpoch || store.activeAccountId !== accountId) return;
    // Ops the user made while the bucket was loading go after the stored
    // ones, and the stored list is written again with them: their persist
    // replaced it with only the new ops.
    const early = store.entries;
    const merged = early.length > 0 ? [...entries, ...early] : entries;
    const earlySends = store.sends;
    const mergedSends = earlySends.length > 0 ? [...sends, ...earlySends] : sends;
    useOutboxStore.setState({ entries: merged, failed, sends: mergedSends, hydrated: true });
    if (early.length > 0) persist(accountId, merged);
    if (earlySends.length > 0) persistSends(accountId, mergedSends);
  })().finally(() => {
    if (bucketLoad?.promise === promise) bucketLoad = null;
  });
  bucketLoad = { accountId, epoch, promise };
  return promise;
}

export const useOutboxStore = create<OutboxState>((set, get) => ({
  activeAccountId: null,
  entries: [],
  failed: [],
  sends: [],
  hydrated: false,
  flushing: false,
  paused: false,
  resumed: false,

  setAccount: async (accountId) => {
    const state = get();
    if (state.activeAccountId === accountId) {
      if (!state.hydrated) await get().hydrate();
      set({ paused: false });
      return;
    }
    clearRetry();
    retryAttempt = 0;
    // Each attach reads the bucket afresh; a read from before is dropped.
    loadEpoch += 1;
    set({ activeAccountId: accountId, entries: [], failed: [], sends: [], hydrated: false, paused: false, resumed: false });
    if (accountId) {
      await loadBucket(accountId);
    } else {
      set({ hydrated: true });
    }
  },

  resume: async (accountId) => {
    // An older sign-in or switch that ends after a newer one began must not
    // take the queue over for the account it was after.
    if (get().activeAccountId !== accountId) return;
    await get().setAccount(accountId);
    // Another account may have been attached while this one loaded.
    if (get().activeAccountId !== accountId) return;
    set({ resumed: true, paused: false });
    await get().flush();
  },

  suspend: () => {
    const { activeAccountId, resumed } = get();
    clearRetry();
    set({ resumed: false });
    return resumed ? activeAccountId : null;
  },

  hydrate: async () => {
    const state = get();
    if (state.hydrated) return;
    const accountId = state.activeAccountId;
    if (!accountId) {
      set({ hydrated: true });
      return;
    }
    await loadBucket(accountId);
  },

  enqueue: (op) => {
    const accountId = get().activeAccountId;
    if (!accountId) {
      console.warn('[outbox] enqueue with no active account; dropping op', op.kind);
      return;
    }
    let entries = [...get().entries];
    // Message identity is (account, id): JMAP ids are only unique within an
    // account, and the queue can hold ops for shared accounts alongside own.
    const sameMessage = (other: OutboxOp) =>
      other.emailId === op.emailId && other.accountId === op.accountId;

    if (op.kind === 'destroy') {
      // Destroy is terminal — drop any pending edits for this message and
      // append the destroy so it runs last.
      entries = entries.filter((e) => !sameMessage(e.op));
      entries.push({ id: generateUUID(), op, createdAt: Date.now(), attempts: 0 });
    } else {
      // A queued destroy wins; further edits to a doomed message are pointless.
      if (entries.some((e) => sameMessage(e.op) && e.op.kind === 'destroy')) return;
      // Coalesce: replace any pending op of the same family for this message
      // (full-state replace makes the latest one authoritative; keyword
      // patches merge, the later value winning per keyword). Keep its
      // position so creation order is preserved for replay.
      const idx = entries.findIndex((e) => sameMessage(e.op) && opFamily(e.op) === opFamily(op));
      if (idx >= 0) {
        const prev = entries[idx].op;
        const merged: OutboxOp = prev.kind === 'keywords' && op.kind === 'keywords'
          ? { ...op, patch: { ...prev.patch, ...op.patch } }
          : op;
        entries[idx] = { ...entries[idx], op: merged, attempts: 0, lastError: undefined };
      } else {
        entries.push({ id: generateUUID(), op, createdAt: Date.now(), attempts: 0 });
      }
    }

    set({ entries });
    persist(accountId, entries);
  },

  count: () => get().entries.length,

  pendingForEmail: (emailId) => get().entries.filter((e) => e.op.emailId === emailId),

  flush: async () => {
    if (get().flushing || get().paused || !get().resumed || !get().hydrated) return;
    const accountId = get().activeAccountId;
    if (!accountId) return;
    if (get().entries.length === 0 && !hasWaitingSends()) return;
    // Need a live client that's actually serving this account, and a network.
    if (!clientServes(accountId)) return;
    if (!useNetworkStore.getState().online) return;

    set({ flushing: true });
    let brokeTransient = false;
    let dropped = false;
    // An entry that took on a later edit while its op was out runs again.
    let changedInFlight = false;
    try {
      // Process oldest-first so dependent moves replay in the order they were
      // made. We snapshot the order but re-read the live list each iteration,
      // since a concurrent enqueue may have coalesced/removed entries.
      const ordered = [...get().entries].sort((a, b) => a.createdAt - b.createdAt);

      for (const snapshot of ordered) {
        if (get().activeAccountId !== accountId) break;     // account switched
        if (!get().resumed) break;                           // another account signing in
        if (!useNetworkStore.getState().online) break;       // went offline
        // The client can move on while an op is in flight: to an account
        // being added, before the queue moves with it.
        if (!clientServes(accountId)) break;

        const entry = get().entries.find((e) => e.id === snapshot.id);
        if (!entry) continue;                                // removed/coalesced

        try {
          await runOp(entry.op);
          // An edit queued meanwhile was merged into this entry (an Undo of
          // the star being sent): dropping the entry would lose it.
          if (!removeEntry(accountId, entry.id, entry.op)) changedInFlight = true;
          retryAttempt = 0;
        } catch (err) {
          if (get().activeAccountId !== accountId) break;
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
      // Queued messages go after the mutation ops, and only while the
      // connection holds.
      if (!brokeTransient && !get().paused && hasWaitingSends()) {
        const result = await flushSends(accountId);
        if (result === 'transient') brokeTransient = true;
      }
    } finally {
      set({ flushing: false });
    }
    if (brokeTransient && (get().entries.length > 0 || hasWaitingSends())) scheduleRetry();
    else if (changedInFlight) void get().flush();
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

  enqueueSend: (payload, opts) => {
    const accountId = get().activeAccountId;
    if (!accountId) {
      console.warn('[outbox] enqueueSend with no active account');
      return null;
    }
    const send = newQueuedSend(generateUUID(), payload, Date.now(), !!opts?.maybeSent);
    const sends = [...get().sends, send];
    set({ sends });
    persistSends(accountId, sends);
    void get().flush();
    return send.id;
  },

  retrySend: async (id) => {
    const accountId = get().activeAccountId;
    const send = get().sends.find((s) => s.id === id);
    if (!accountId || !send || send.status !== 'failed') return;
    // The attempts start over; an unconfirmed one keeps its mark, so the
    // message is looked for first.
    updateSend(accountId, { ...send, status: 'queued', attempts: 0, lastError: undefined });
    set({ paused: false });
    await get().flush();
  },

  cancelSend: async (id, opts) => {
    const accountId = get().activeAccountId;
    const send = get().sends.find((s) => s.id === id);
    if (!accountId || !send || !canCancel(send)) return false;
    // Out of the queue first, so a flush can't send it while it is saved.
    removeSend(accountId, id);
    if (!opts?.keepAsDraft) return true;
    const p = send.payload;
    try {
      if (!p.draftsMailboxId) throw new Error('No Drafts folder');
      const { saveDraftVersion } = await import('../api/email');
      await saveDraftVersion(p.outgoing, p.draftsMailboxId, p.draftId, undefined, p.draftAccountId);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (get().activeAccountId === accountId) {
        const sends = [...get().sends, { ...send, status: 'failed' as const, lastError: message }]
          .sort((a, b) => a.createdAt - b.createdAt);
        set({ sends });
        persistSends(accountId, sends);
      }
      return false;
    }
  },

  discardFailed: () => {
    const accountId = get().activeAccountId;
    set({ failed: [] });
    if (accountId) persistFailed(accountId, []);
  },

  clear: async () => {
    const accountId = get().activeAccountId;
    clearRetry();
    set({ entries: [], failed: [], sends: [] });
    if (accountId) {
      await AsyncStorage.removeItem(storageKey(accountId)).catch(() => undefined);
      await AsyncStorage.removeItem(storageKey(accountId) + FAILED_SUFFIX).catch(() => undefined);
      await AsyncStorage.removeItem(storageKey(accountId) + SENDS_SUFFIX).catch(() => undefined);
    }
  },

  clearAccount: async (accountId) => {
    const state = get();
    const loaded = state.activeAccountId === accountId && state.hydrated;
    let dropped = loaded ? state.entries.length + state.failed.length + state.sends.length : 0;
    if (state.activeAccountId === accountId) {
      clearRetry();
      // A read of the bucket still under way must not bring the ops back.
      loadEpoch += 1;
      set({ entries: [], failed: [], sends: [], hydrated: true });
    }
    if (!loaded) {
      const [entries, failed, sends] = await Promise.all([
        load(accountId), load(accountId, FAILED_SUFFIX), loadSends(accountId),
      ]);
      dropped = entries.length + failed.length + sends.length;
    }
    await AsyncStorage.removeItem(storageKey(accountId)).catch(() => undefined);
    await AsyncStorage.removeItem(storageKey(accountId) + FAILED_SUFFIX).catch(() => undefined);
    await AsyncStorage.removeItem(storageKey(accountId) + SENDS_SUFFIX).catch(() => undefined);
    return dropped;
  },
}));

// ── Internal helpers that mutate+persist the live list ──────────────────────

/**
 * Drops a replayed entry. With `sent`, only while the entry still holds that
 * op: one an enqueue coalesced into while it was out stays, and false says
 * so.
 */
function removeEntry(accountId: string, id: string, sent?: OutboxOp): boolean {
  const store = useOutboxStore.getState();
  if (store.activeAccountId !== accountId) return true;
  const current = store.entries.find((e) => e.id === id);
  if (current && sent && current.op !== sent) return false;
  const entries = store.entries.filter((e) => e.id !== id);
  useOutboxStore.setState({ entries });
  persist(accountId, entries);
  return true;
}

// ── Queued messages ─────────────────────────────────────────────────────────

function hasWaitingSends(): boolean {
  return useOutboxStore.getState().sends.some((s) => s.status === 'queued');
}

function updateSend(accountId: string, next: QueuedSend): void {
  const store = useOutboxStore.getState();
  if (store.activeAccountId !== accountId) return;
  if (!store.sends.some((s) => s.id === next.id)) return;
  const sends = store.sends.map((s) => (s.id === next.id ? next : s));
  useOutboxStore.setState({ sends });
  persistSends(accountId, sends);
}

function removeSend(accountId: string, id: string): void {
  const store = useOutboxStore.getState();
  if (store.activeAccountId !== accountId) return;
  const sends = store.sends.filter((s) => s.id !== id);
  useOutboxStore.setState({ sends });
  persistSends(accountId, sends);
}

/**
 * Send the waiting messages, oldest first. 'transient' when the connection
 * broke (or an answer never came), so the flush retries with back-off.
 */
async function flushSends(accountId: string): Promise<'done' | 'transient'> {
  const waiting = useOutboxStore.getState().sends
    .filter((s) => s.status === 'queued')
    .sort((a, b) => a.createdAt - b.createdAt);
  if (waiting.length === 0) return 'done';
  const [{ runQueuedSend }, { useEmailStore }] = await Promise.all([
    import('../api/queued-send'),
    import('./email-store'),
  ]);
  for (const snapshot of waiting) {
    const store = useOutboxStore.getState();
    if (store.activeAccountId !== accountId || !store.resumed || store.paused) break;
    if (!useNetworkStore.getState().online || !clientServes(accountId)) break;
    const current = store.sends.find((s) => s.id === snapshot.id);
    if (!current || current.status !== 'queued') continue;     // cancelled or retried meanwhile

    // Marked before the request leaves: from here on it may reach the server.
    const started = startAttempt(current);
    updateSend(accountId, started);
    try {
      const outcome = await runQueuedSend(started, useEmailStore.getState().mailboxes);
      removeSend(accountId, current.id);
      retryAttempt = 0;
      void afterQueuedSend(started, outcome);
    } catch (err) {
      const kind = classifySendFailure(err, isTransientNetworkError);
      const message = err instanceof Error ? err.message : String(err);
      const next = afterFailure(started, kind, message);
      updateSend(accountId, next);
      // Refused, or unconfirmed too often: it waits for the user now, and
      // nothing retries it, so say so whatever the reason.
      if (next.status === 'failed') void notifyQueuedSendFailed(started, message);
      if (kind === 'auth') {
        useOutboxStore.setState({ paused: true });
        break;
      }
      if (kind === 'offline' || kind === 'unconfirmed') return 'transient';
      // Refused: the others go on.
    }
  }
  return 'done';
}

type QueuedSendOutcomeLike = { kind: 'sent'; result: { refusedRecipients?: Array<{ email: string }> } } | { kind: 'alreadySent' };

// Flag the original and say the message went. Lazy imports: these pull in
// the UI stores, which the queue itself doesn't need.
async function afterQueuedSend(send: QueuedSend, outcome: QueuedSendOutcomeLike): Promise<void> {
  const original = send.payload.original;
  if (original) {
    patchKeywordsForEmails([original.emailId], { [original.keyword]: true }, original.accountId).catch(() => undefined);
  }
  try {
    const [{ toast }, { useLocaleStore }, { partlyRefusedWarning }] = await Promise.all([
      import('./toast-store'), import('./locale-store'), import('../lib/send-failure-message'),
    ]);
    const t = useLocaleStore.getState().t;
    const refused = outcome.kind === 'sent' ? outcome.result.refusedRecipients ?? [] : [];
    if (refused.length > 0) {
      const { title, message } = partlyRefusedWarning(refused as Parameters<typeof partlyRefusedWarning>[0], t);
      toast.warning(title, { message, duration: 10_000 });
    } else {
      toast.success(t('outbox.sent', 'Message from the Outbox sent'), { message: send.payload.outgoing.subject || undefined });
    }
  } catch (err) {
    console.warn('[outbox] could not report a queued send', err);
  }
}

async function notifyQueuedSendFailed(send: QueuedSend, message: string): Promise<void> {
  try {
    const [{ toast }, { useLocaleStore }] = await Promise.all([import('./toast-store'), import('./locale-store')]);
    const t = useLocaleStore.getState().t;
    toast.error(t('outbox.send_failed', 'A message in the Outbox could not be sent'), {
      message: [send.payload.outgoing.subject, message].filter(Boolean).join(': '),
    });
  } catch (err) {
    console.warn('[outbox] could not report a failed queued send', err);
  }
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
export async function applyOrQueueBatch(
  ops: OutboxOp[],
  onlineRun?: () => Promise<void>,
): Promise<ApplyResult> {
  if (ops.length === 0) return { queued: false };
  const store = useOutboxStore.getState();
  // Until the auth store resumes the queue, the client may still serve the
  // account being left, or a server not yet checked: queue, replay later.
  // And only through the account whose messages these are.
  const online = useNetworkStore.getState().online
    && clientServes(store.activeAccountId)
    && !store.paused
    && store.resumed;
  const hasQueued = ops.some((op) =>
    store.entries.some((e) => e.op.emailId === op.emailId),
  );

  if (online && !hasQueued) {
    try {
      await (onlineRun ? onlineRun() : Promise.all(ops.map(runOp)).then(() => undefined));
      return { queued: false };
    } catch (err) {
      // A real server/validation error should bubble up exactly like before.
      // Only fall through to the queue when the failure is connectivity.
      if (!isTransientNetworkError(err)) throw err;
    }
  }

  for (const op of ops) store.enqueue(op);
  if (online) void store.flush();
  return { queued: true };
}

export function applyOrQueue(op: OutboxOp, onlineRun?: () => Promise<void>): Promise<ApplyResult> {
  return applyOrQueueBatch([op], onlineRun);
}
