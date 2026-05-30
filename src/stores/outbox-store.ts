// Persistent offline action queue ("outbox") for mail mutations.
//
// Every mutation the app performs on a message reduces to one of three
// idempotent primitives:
//   - keywords:  replace the full keyword map  (read/unread, flag, pin, …)
//   - mailboxes: replace the full mailboxIds map (move, archive, trash)
//   - destroy:   permanently delete the message
//
// Because each primitive assigns the *whole* target state rather than a delta,
// replaying it is safe regardless of the server's current state, so we can
// coalesce repeated edits to the same message (last-write-wins) and retry on a
// flaky connection without corrupting anything.
//
// When the device is online and nothing is already queued for a message, the
// op runs immediately (preserving today's behaviour, including surfacing real
// server errors to the caller). Otherwise it's persisted to AsyncStorage and
// replayed by flush() once connectivity returns. Storage is keyed per account,
// mirroring offline-cache-store, so queues never leak between logins.

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { generateUUID } from '../lib/uuid';
import { isTransientNetworkError } from '../lib/network-error';
import { useNetworkStore } from './network-store';
import { jmapClient } from '../api/jmap-client';
import { setEmailKeywords, setEmailMailboxes, destroyEmails } from '../api/email';

const KEY_PREFIX = 'webmail:outbox:v1:';
// Give up on an op that the server keeps rejecting (a non-transient failure)
// after this many attempts so one poison entry can't wedge the whole queue.
const MAX_ATTEMPTS = 5;

function storageKey(accountId: string): string {
  return `${KEY_PREFIX}${accountId}`;
}

export type OutboxOp =
  | { kind: 'keywords'; emailId: string; keywords: Record<string, boolean> }
  | { kind: 'mailboxes'; emailId: string; mailboxIds: Record<string, boolean> }
  | { kind: 'destroy'; emailId: string };

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
  hydrated: boolean;
  flushing: boolean;

  setAccount: (accountId: string | null) => Promise<void>;
  hydrate: () => Promise<void>;
  enqueue: (op: OutboxOp) => void;
  count: () => number;
  pendingForEmail: (emailId: string) => OutboxEntry[];
  flush: () => Promise<void>;
  clear: () => Promise<void>;
}

function persist(accountId: string, entries: OutboxEntry[]): void {
  void AsyncStorage.setItem(storageKey(accountId), JSON.stringify(entries)).catch((err) => {
    console.warn('[outbox] persist failed', err);
  });
}

async function load(accountId: string): Promise<OutboxEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(accountId));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as OutboxEntry[];
    }
  } catch (err) {
    console.warn('[outbox] hydrate failed', err);
  }
  return [];
}

async function runOp(op: OutboxOp): Promise<void> {
  switch (op.kind) {
    case 'keywords':
      return setEmailKeywords(op.emailId, op.keywords);
    case 'mailboxes':
      return setEmailMailboxes(op.emailId, op.mailboxIds);
    case 'destroy':
      return destroyEmails([op.emailId]);
  }
}

export const useOutboxStore = create<OutboxState>((set, get) => ({
  activeAccountId: null,
  entries: [],
  hydrated: false,
  flushing: false,

  setAccount: async (accountId) => {
    const state = get();
    if (state.activeAccountId === accountId) {
      if (!state.hydrated) await get().hydrate();
      return;
    }
    set({ activeAccountId: accountId, entries: [], hydrated: false });
    if (accountId) {
      const entries = await load(accountId);
      // Re-check in case another setAccount raced past us.
      if (get().activeAccountId !== accountId) return;
      set({ entries, hydrated: true });
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
    const entries = await load(accountId);
    if (get().activeAccountId !== accountId) return;
    set({ entries, hydrated: true });
  },

  enqueue: (op) => {
    const accountId = get().activeAccountId;
    if (!accountId) {
      console.warn('[outbox] enqueue with no active account; dropping op', op.kind);
      return;
    }
    let entries = [...get().entries];
    const { emailId } = op;

    if (op.kind === 'destroy') {
      // Destroy is terminal — drop any pending edits for this message and
      // append the destroy so it runs last.
      entries = entries.filter((e) => e.op.emailId !== emailId);
      entries.push({ id: generateUUID(), op, createdAt: Date.now(), attempts: 0 });
    } else {
      // A queued destroy wins; further edits to a doomed message are pointless.
      if (entries.some((e) => e.op.emailId === emailId && e.op.kind === 'destroy')) return;
      // Coalesce: replace any pending op of the same kind for this message
      // (full-state replace makes the latest one authoritative). Keep its
      // position so creation order is preserved for replay.
      const idx = entries.findIndex((e) => e.op.emailId === emailId && e.op.kind === op.kind);
      if (idx >= 0) {
        entries[idx] = { ...entries[idx], op, attempts: 0, lastError: undefined };
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
    if (get().flushing) return;
    const accountId = get().activeAccountId;
    if (!accountId) return;
    if (get().entries.length === 0) return;
    // Need a live client that's actually serving this account, and a network.
    if (!jmapClient.isConnected) return;
    if (!useNetworkStore.getState().online) return;

    set({ flushing: true });
    try {
      // Process oldest-first so dependent moves replay in the order they were
      // made. We snapshot the order but re-read the live list each iteration,
      // since a concurrent enqueue may have coalesced/removed entries.
      const ordered = [...get().entries].sort((a, b) => a.createdAt - b.createdAt);

      for (const snapshot of ordered) {
        if (get().activeAccountId !== accountId) break;     // account switched
        if (!useNetworkStore.getState().online) break;       // went offline
        if (!jmapClient.isConnected) break;

        const entry = get().entries.find((e) => e.id === snapshot.id);
        if (!entry) continue;                                // removed/coalesced

        try {
          await runOp(entry.op);
          removeEntry(accountId, entry.id);
        } catch (err) {
          if (get().activeAccountId !== accountId) break;
          if (isTransientNetworkError(err)) {
            // Connectivity blip — stop and let the next flush retry from here.
            recordError(accountId, entry.id, err, false);
            break;
          }
          // Server rejected it. Count the attempt; drop once we've given up so
          // one bad op can't block everything behind it.
          const attempts = (entry.attempts ?? 0) + 1;
          if (attempts >= MAX_ATTEMPTS) {
            console.warn('[outbox] dropping op after repeated failures', entry.op.kind, err);
            removeEntry(accountId, entry.id);
          } else {
            recordError(accountId, entry.id, err, true);
          }
        }
      }
    } finally {
      set({ flushing: false });
    }
  },

  clear: async () => {
    const accountId = get().activeAccountId;
    set({ entries: [] });
    if (accountId) {
      await AsyncStorage.removeItem(storageKey(accountId)).catch(() => undefined);
    }
  },
}));

// ── Internal helpers that mutate+persist the live list ──────────────────────

function removeEntry(accountId: string, id: string): void {
  const store = useOutboxStore.getState();
  if (store.activeAccountId !== accountId) return;
  const entries = store.entries.filter((e) => e.id !== id);
  useOutboxStore.setState({ entries });
  persist(accountId, entries);
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
// path (e.g. batch move, or archive's year/month auto-foldering) while still
// degrading to the idempotent primitives offline.
export async function applyOrQueueBatch(
  ops: OutboxOp[],
  onlineRun?: () => Promise<void>,
): Promise<ApplyResult> {
  if (ops.length === 0) return { queued: false };
  const store = useOutboxStore.getState();
  const online = useNetworkStore.getState().online && jmapClient.isConnected;
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
