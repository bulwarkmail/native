// Persistent cache for full email bodies (and optional attachment blobs)
// powering offline mail viewing. Bodies are JSON-serialised and kept in
// AsyncStorage; attachment blobs go to expo-file-system under
// `Paths.document/offline-attachments/`. The store also exposes the live
// progress state the OfflineCacheBanner reads from.
//
// Storage is keyed by the email-store's `activeAccountId` so logged-in
// accounts don't leak cached bodies into each other. The store loads one
// account's bucket at a time (the active one); switching accounts via
// setAccount() persists the current bucket then hydrates the new one.

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Email } from '../api/types';
import { applyKeywordPatch, type KeywordPatch } from '../lib/keyword-patch';

const INDEX_KEY_PREFIX = 'webmail:offline-cache:index:v2:';
const ENTRY_KEY_PREFIX = 'webmail:offline-cache:entry:v2:';

function indexKey(accountId: string): string {
  return `${INDEX_KEY_PREFIX}${accountId}`;
}

function entryKey(accountId: string, emailId: string): string {
  return `${ENTRY_KEY_PREFIX}${accountId}:${emailId}`;
}

// Index/entry key of a message. JMAP ids are only unique per account, so a
// message from a shared (group) account is namespaced by its owning JMAP
// account id; the user's own mail keeps the bare id (backwards compatible).
export function cacheKey(emailId: string, jmapAccountId?: string): string {
  return jmapAccountId ? `${jmapAccountId}:${emailId}` : emailId;
}

export interface OfflineCacheIndexEntry {
  id: string;
  receivedAt: string;
  size: number;          // approx bytes of cached payload
  cachedAt: number;
  /** Owning JMAP account for a shared/group message; unset for own mail. */
  jmapAccountId?: string;
}

interface CacheIndex {
  entries: Record<string, OfflineCacheIndexEntry>;
}

export type SyncPhase = 'idle' | 'scanning' | 'fetching' | 'done' | 'error' | 'cancelled';

export interface SyncState {
  phase: SyncPhase;
  total: number;       // total emails the sync expects to process
  completed: number;   // emails processed (skipped or fetched)
  fetched: number;     // emails actually downloaded (not already cached)
  bytes: number;       // bytes downloaded this run
  message?: string;    // human-readable status (errors etc.)
  startedAt?: number;
  finishedAt?: number;
}

const IDLE: SyncState = { phase: 'idle', total: 0, completed: 0, fetched: 0, bytes: 0 };
const EMPTY_INDEX: CacheIndex = { entries: {} };

interface OfflineCacheState {
  // Currently-loaded bucket. null = no account active (no reads/writes).
  activeAccountId: string | null;
  index: CacheIndex;
  hydrated: boolean;
  sync: SyncState;
  // Allows the sync orchestrator to abort mid-run when the user disables the
  // setting or kicks off a fresh sync. Stored on the singleton because
  // AbortControllers need to survive across the function boundary.
  abortRequested: boolean;

  // Point the store at the given account, hydrating its bucket from
  // AsyncStorage. Pass null to detach (no reads/writes will hit storage).
  setAccount: (accountId: string | null) => Promise<void>;
  hydrate: () => Promise<void>;
  has: (id: string, jmapAccountId?: string) => boolean;
  get: (id: string, jmapAccountId?: string) => Promise<Email | null>;
  put: (email: Email, approxBytes: number, jmapAccountId?: string) => Promise<void>;
  // Apply a change to a cached email (no-op when not cached). Used to keep the
  // cached body consistent with an optimistic/queued mutation so a re-open
  // while offline reflects the new keywords / mailboxIds. `keywords` is a
  // patch (only the keywords it names change); `mailboxIds` replaces the map.
  patch: (
    id: string,
    changes: { keywords?: KeywordPatch; mailboxIds?: Record<string, boolean> },
    jmapAccountId?: string,
  ) => Promise<void>;
  remove: (ids: string[], jmapAccountId?: string) => Promise<void>;
  // Evict oldest-received entries until the cache fits within maxBytes. Keeps
  // the persisted cache from growing without bound on a noisy account.
  evictToFit: (maxBytes: number) => Promise<void>;
  clearAll: () => Promise<void>;

  // Returns cached emails whose `mailboxIds` include the given mailbox,
  // sorted by `receivedAt` descending. Used by selectMailbox to seed the
  // list when the network is unavailable. Loads each entry from
  // AsyncStorage; the index doesn't carry the mailbox set.
  getEmailsInMailbox: (mailboxId: string, limit?: number, jmapAccountId?: string) => Promise<Email[]>;

  totalSize: () => number;
  totalCount: () => number;

  setSyncState: (next: Partial<SyncState>) => void;
  resetSync: () => void;
  requestAbort: () => void;
  consumeAbort: () => boolean;
}

function persistIndex(accountId: string, index: CacheIndex): void {
  void AsyncStorage.setItem(indexKey(accountId), JSON.stringify(index)).catch((err) => {
    console.warn('[offline-cache] persist index failed', err);
  });
}

async function loadIndex(accountId: string): Promise<CacheIndex> {
  try {
    const raw = await AsyncStorage.getItem(indexKey(accountId));
    if (raw) {
      const parsed = JSON.parse(raw) as CacheIndex;
      if (parsed && typeof parsed === 'object' && parsed.entries) {
        return parsed;
      }
    }
  } catch (err) {
    console.warn('[offline-cache] hydrate failed', err);
  }
  return { entries: {} };
}

export const useOfflineCacheStore = create<OfflineCacheState>((set, get) => ({
  activeAccountId: null,
  index: { entries: {} },
  hydrated: false,
  sync: { ...IDLE },
  abortRequested: false,

  setAccount: async (accountId) => {
    const state = get();
    if (state.activeAccountId === accountId) {
      // Same account — make sure we've hydrated.
      if (!state.hydrated) await get().hydrate();
      return;
    }
    // Drop any in-flight sync state from the previous account; the abort flag
    // makes runOfflineSync stop on its next chunk boundary.
    set({
      activeAccountId: accountId,
      index: { ...EMPTY_INDEX },
      hydrated: false,
      sync: { ...IDLE },
      abortRequested: true,
    });
    if (accountId) {
      const index = await loadIndex(accountId);
      // Re-check in case another setAccount call raced past us.
      if (get().activeAccountId !== accountId) return;
      set({ index, hydrated: true, abortRequested: false });
    } else {
      set({ hydrated: true, abortRequested: false });
    }
  },

  hydrate: async () => {
    const state = get();
    if (state.hydrated) return;
    const accountId = state.activeAccountId;
    if (!accountId) {
      // No active account yet — mark hydrated so callers that block on this
      // (selectMailbox cache-seed path) don't spin. Reads will return empty.
      set({ hydrated: true });
      return;
    }
    const index = await loadIndex(accountId);
    if (get().activeAccountId !== accountId) return;
    set({ index, hydrated: true });
  },

  has: (id, jmapAccountId) => Boolean(get().index.entries[cacheKey(id, jmapAccountId)]),

  get: async (id, jmapAccountId) => {
    const state = get();
    if (!state.activeAccountId) return null;
    const key = cacheKey(id, jmapAccountId);
    if (!state.index.entries[key]) return null;
    try {
      const raw = await AsyncStorage.getItem(entryKey(state.activeAccountId, key));
      if (!raw) return null;
      return JSON.parse(raw) as Email;
    } catch (err) {
      console.warn('[offline-cache] get failed', id, err);
      return null;
    }
  },

  put: async (email, approxBytes, jmapAccountId) => {
    const state = get();
    const accountId = state.activeAccountId;
    if (!accountId) return;
    const key = cacheKey(email.id, jmapAccountId);
    try {
      await AsyncStorage.setItem(entryKey(accountId, key), JSON.stringify(email));
    } catch (err) {
      console.warn('[offline-cache] put failed', email.id, err);
      return;
    }
    // Re-read the active account in case it changed while we were awaiting
    // AsyncStorage — don't stamp the new account's index with the old
    // account's entry.
    if (get().activeAccountId !== accountId) return;
    const nextEntries = {
      ...get().index.entries,
      [key]: {
        id: email.id,
        receivedAt: email.receivedAt,
        size: approxBytes,
        cachedAt: Date.now(),
        ...(jmapAccountId ? { jmapAccountId } : {}),
      },
    };
    const index = { entries: nextEntries };
    set({ index });
    persistIndex(accountId, index);
  },

  patch: async (id, changes, jmapAccountId) => {
    const accountId = get().activeAccountId;
    const key = cacheKey(id, jmapAccountId);
    if (!accountId || !get().index.entries[key]) return;
    try {
      const raw = await AsyncStorage.getItem(entryKey(accountId, key));
      if (!raw) return;
      const email = JSON.parse(raw) as Email;
      const updated: Email = {
        ...email,
        ...(changes.mailboxIds ? { mailboxIds: changes.mailboxIds } : {}),
        ...(changes.keywords ? { keywords: applyKeywordPatch(email.keywords, changes.keywords) } : {}),
      };
      if (get().activeAccountId !== accountId) return;
      await AsyncStorage.setItem(entryKey(accountId, key), JSON.stringify(updated));
    } catch (err) {
      console.warn('[offline-cache] patch failed', id, err);
    }
  },

  remove: async (ids, jmapAccountId) => {
    if (ids.length === 0) return;
    const accountId = get().activeAccountId;
    if (!accountId) return;
    const keys = ids.map((id) => cacheKey(id, jmapAccountId));
    await Promise.all(
      keys.map((key) => AsyncStorage.removeItem(entryKey(accountId, key)).catch(() => undefined)),
    );
    if (get().activeAccountId !== accountId) return;
    const next = { ...get().index.entries };
    for (const key of keys) delete next[key];
    const index = { entries: next };
    set({ index });
    persistIndex(accountId, index);
  },

  evictToFit: async (maxBytes) => {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) return;
    const accountId = get().activeAccountId;
    if (!accountId) return;
    let total = get().totalSize();
    if (total <= maxBytes) return;
    // Drop the oldest mail first (by receivedAt) — that's what users expect a
    // bounded "recent mail" cache to shed when it overflows.
    const sorted = Object.values(get().index.entries).sort((a, b) => {
      const at = a.receivedAt ? new Date(a.receivedAt).getTime() : 0;
      const bt = b.receivedAt ? new Date(b.receivedAt).getTime() : 0;
      return at - bt;
    });
    const toRemove: Array<{ id: string; jmapAccountId?: string }> = [];
    for (const entry of sorted) {
      if (total <= maxBytes) break;
      toRemove.push({ id: entry.id, jmapAccountId: entry.jmapAccountId });
      total -= entry.size;
    }
    // Group by namespace so each remove() call addresses the right keys.
    const byAccount = new Map<string | undefined, string[]>();
    for (const r of toRemove) {
      const list = byAccount.get(r.jmapAccountId);
      if (list) list.push(r.id); else byAccount.set(r.jmapAccountId, [r.id]);
    }
    for (const [jmapAccountId, ids] of byAccount) await get().remove(ids, jmapAccountId);
  },

  clearAll: async () => {
    const accountId = get().activeAccountId;
    if (!accountId) return;
    const ids = Object.keys(get().index.entries);
    await Promise.all(
      ids.map((id) => AsyncStorage.removeItem(entryKey(accountId, id)).catch(() => undefined)),
    );
    if (get().activeAccountId !== accountId) return;
    const index = { entries: {} };
    set({ index, sync: { ...IDLE } });
    persistIndex(accountId, index);
  },

  getEmailsInMailbox: async (mailboxId, limit = 200, jmapAccountId) => {
    const state = get();
    const accountId = state.activeAccountId;
    if (!accountId) return [];
    // Sort the index by receivedAt descending first so we don't have to read
    // entries we won't return — the index already carries receivedAt. Only
    // the requested namespace (own mail, or one shared account) is scanned.
    const sorted = Object.values(state.index.entries).filter((e) => e.jmapAccountId === jmapAccountId).sort((a, b) => {
      const at = a.receivedAt ? new Date(a.receivedAt).getTime() : 0;
      const bt = b.receivedAt ? new Date(b.receivedAt).getTime() : 0;
      return bt - at;
    });
    const matches: Email[] = [];
    for (const entry of sorted) {
      if (matches.length >= limit) break;
      try {
        const raw = await AsyncStorage.getItem(entryKey(accountId, cacheKey(entry.id, entry.jmapAccountId)));
        if (!raw) continue;
        const email = JSON.parse(raw) as Email;
        if (email.mailboxIds?.[mailboxId]) {
          matches.push(email);
        }
      } catch {
        // skip corrupt entries — they'll be replaced on next sync
      }
    }
    return matches;
  },

  totalSize: () => {
    let n = 0;
    for (const e of Object.values(get().index.entries)) n += e.size;
    return n;
  },

  totalCount: () => Object.keys(get().index.entries).length,

  setSyncState: (next) => set({ sync: { ...get().sync, ...next } }),

  resetSync: () => set({ sync: { ...IDLE }, abortRequested: false }),

  requestAbort: () => set({ abortRequested: true }),

  consumeAbort: () => {
    const v = get().abortRequested;
    if (v) set({ abortRequested: false });
    return v;
  },
}));
