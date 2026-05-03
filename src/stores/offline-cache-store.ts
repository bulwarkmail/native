// Persistent cache for full email bodies (and optional attachment blobs)
// powering offline mail viewing. Bodies are JSON-serialised and kept in
// AsyncStorage; attachment blobs go to expo-file-system under
// `Paths.document/offline-attachments/`. The store also exposes the live
// progress state the OfflineCacheBanner reads from.

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Email } from '../api/types';

const INDEX_KEY = 'webmail:offline-cache:index:v1';
const ENTRY_KEY_PREFIX = 'webmail:offline-cache:entry:v1:';

function entryKey(id: string): string {
  return `${ENTRY_KEY_PREFIX}${id}`;
}

export interface OfflineCacheIndexEntry {
  id: string;
  receivedAt: string;
  size: number;          // approx bytes of cached payload
  cachedAt: number;
}

interface CacheIndex {
  // Per-account is keyed at the storage layer (one app session = one account
  // active at a time). Cross-account separation is left to a future change.
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

interface OfflineCacheState {
  index: CacheIndex;
  hydrated: boolean;
  sync: SyncState;
  // Allows the sync orchestrator to abort mid-run when the user disables the
  // setting or kicks off a fresh sync. Stored on the singleton because
  // AbortControllers need to survive across the function boundary.
  abortRequested: boolean;

  hydrate: () => Promise<void>;
  has: (id: string) => boolean;
  get: (id: string) => Promise<Email | null>;
  put: (email: Email, approxBytes: number) => Promise<void>;
  remove: (ids: string[]) => Promise<void>;
  clearAll: () => Promise<void>;

  // Returns cached emails whose `mailboxIds` include the given mailbox,
  // sorted by `receivedAt` descending. Used by selectMailbox to seed the
  // list when the network is unavailable. Loads each entry from
  // AsyncStorage; the index doesn't carry the mailbox set.
  getEmailsInMailbox: (mailboxId: string, limit?: number) => Promise<Email[]>;

  totalSize: () => number;
  totalCount: () => number;

  setSyncState: (next: Partial<SyncState>) => void;
  resetSync: () => void;
  requestAbort: () => void;
  consumeAbort: () => boolean;
}

function persistIndex(index: CacheIndex): void {
  void AsyncStorage.setItem(INDEX_KEY, JSON.stringify(index)).catch((err) => {
    console.warn('[offline-cache] persist index failed', err);
  });
}

export const useOfflineCacheStore = create<OfflineCacheState>((set, get) => ({
  index: { entries: {} },
  hydrated: false,
  sync: { ...IDLE },
  abortRequested: false,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(INDEX_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as CacheIndex;
        if (parsed && typeof parsed === 'object' && parsed.entries) {
          set({ index: parsed, hydrated: true });
          return;
        }
      }
    } catch (err) {
      console.warn('[offline-cache] hydrate failed', err);
    }
    set({ hydrated: true });
  },

  has: (id) => Boolean(get().index.entries[id]),

  get: async (id) => {
    if (!get().index.entries[id]) return null;
    try {
      const raw = await AsyncStorage.getItem(entryKey(id));
      if (!raw) return null;
      return JSON.parse(raw) as Email;
    } catch (err) {
      console.warn('[offline-cache] get failed', id, err);
      return null;
    }
  },

  put: async (email, approxBytes) => {
    try {
      await AsyncStorage.setItem(entryKey(email.id), JSON.stringify(email));
    } catch (err) {
      console.warn('[offline-cache] put failed', email.id, err);
      return;
    }
    const nextEntries = {
      ...get().index.entries,
      [email.id]: {
        id: email.id,
        receivedAt: email.receivedAt,
        size: approxBytes,
        cachedAt: Date.now(),
      },
    };
    const index = { entries: nextEntries };
    set({ index });
    persistIndex(index);
  },

  remove: async (ids) => {
    if (ids.length === 0) return;
    await Promise.all(
      ids.map((id) => AsyncStorage.removeItem(entryKey(id)).catch(() => undefined)),
    );
    const next = { ...get().index.entries };
    for (const id of ids) delete next[id];
    const index = { entries: next };
    set({ index });
    persistIndex(index);
  },

  clearAll: async () => {
    const ids = Object.keys(get().index.entries);
    await Promise.all(
      ids.map((id) => AsyncStorage.removeItem(entryKey(id)).catch(() => undefined)),
    );
    const index = { entries: {} };
    set({ index, sync: { ...IDLE } });
    persistIndex(index);
  },

  getEmailsInMailbox: async (mailboxId, limit = 200) => {
    // Sort the index by receivedAt descending first so we don't have to read
    // entries we won't return — the index already carries receivedAt.
    const sorted = Object.values(get().index.entries).sort((a, b) => {
      const at = a.receivedAt ? new Date(a.receivedAt).getTime() : 0;
      const bt = b.receivedAt ? new Date(b.receivedAt).getTime() : 0;
      return bt - at;
    });
    const matches: Email[] = [];
    for (const entry of sorted) {
      if (matches.length >= limit) break;
      try {
        const raw = await AsyncStorage.getItem(entryKey(entry.id));
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
