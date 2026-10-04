// Persistent offline send queue. A message sent while offline is stored here
// and replayed once the connection returns; it must never be sent twice.
//
// The send-safety rule: `markSending` is persisted before any request is made,
// so a crash mid-request leaves `sending` on disk. Hydration turns that into
// `uncertain` (the server may or may not have accepted it) and replay then
// checks by Message-ID instead of resending blindly.
//
// Storage is one AsyncStorage row per entry, `webmail:sendqueue:v1:<appAccountId>:<entryId>`,
// separate from the mutation outbox (`webmail:outbox:v1:*`, never touched here).
// Every operation runs as one task on a per-account promise chain, reads the
// state when it runs, and updates memory only after its row write succeeded.
// The store makes no network or JMAP calls.

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { OutgoingEmail } from '../api/email';

const KEY_PREFIX = 'webmail:sendqueue:v1:';
const MAX_ENTRY_BYTES = 1024 * 1024;

function accountPrefix(appAccountId: string): string {
  return `${KEY_PREFIX}${appAccountId}:`;
}

function rowKey(appAccountId: string, id: string): string {
  return `${accountPrefix(appAccountId)}${id}`;
}

function utf8Length(str: string): number {
  let n = 0;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i++; }
    else n += 3;
  }
  return n;
}

const STATES: readonly string[] = ['queued', 'sending', 'uncertain', 'failed'];

function parseRow(appAccountId: string, key: string, raw: string | null): QueuedSend | null {
  if (!raw) return null;
  try {
    const e = JSON.parse(raw) as QueuedSend;
    if (!e || typeof e !== 'object') return null;
    if (typeof e.id !== 'string' || !e.id || key !== rowKey(appAccountId, e.id)) return null;
    if (e.appAccountId !== appAccountId || !STATES.includes(e.state)) return null;
    if (!e.outgoing || typeof e.outgoing !== 'object' || typeof e.messageId !== 'string') return null;
    return e;
  } catch {
    return null;
  }
}

export function stripMessageIdBrackets(id: string): string {
  return id.trim().replace(/^<+/, '').replace(/>+$/, '');
}

export type QueuedSendState = 'queued' | 'sending' | 'uncertain' | 'failed';

export interface QueuedSend {
  id: string;
  appAccountId: string;
  jmapAccountId: string;
  identityId: string;
  /** Attachments as blob ids only. */
  outgoing: OutgoingEmail;
  /** The Message-ID the send will carry (outgoing.messageId). */
  messageId: string;
  /** Server draft to remove after a successful send. */
  draftId?: string;
  /** ISO time for a scheduled send; absent = send now. */
  sendAt?: string;
  replyTo?: { emailIds: string[]; keyword: '$answered' | '$forwarded' };
  createdAt: string;
  state: QueuedSendState;
  attemptStartedAt?: string;
  lastError?: string;
}

export class SendTooLargeToQueueError extends Error {
  constructor(message = 'This message is too large to queue for sending later') {
    super(message);
    this.name = 'SendTooLargeToQueueError';
  }
}

interface SendQueueState {
  /** Loaded queues by app account id. */
  entries: Record<string, QueuedSend[]>;

  /** Load an account's rows, merging with memory (memory wins, never downgrades). */
  hydrateAccount: (appAccountId: string) => Promise<void>;
  /** `messageId` is derived from `outgoing.messageId`; any supplied value is ignored. */
  enqueue: (entry: Omit<QueuedSend, 'messageId'> & { messageId?: string }) => Promise<void>;
  /** Persisted before it resolves; call before any request is made. */
  markSending: (id: string) => Promise<void>;
  complete: (id: string) => Promise<void>;
  markUncertain: (id: string, error: string) => Promise<void>;
  markFailed: (id: string, error: string) => Promise<void>;
  requeue: (id: string) => Promise<void>;
  discard: (id: string) => Promise<void>;
  clearAccount: (appAccountId: string) => Promise<void>;
}

// One task chain per account; a failed task does not break the chain.
const chains = new Map<string, Promise<unknown>>();

function serialize<T>(appAccountId: string, task: () => Promise<T>): Promise<T> {
  const prev = chains.get(appAccountId) ?? Promise.resolve();
  const run = prev.then(task, task);
  chains.set(appAccountId, run.catch(() => undefined));
  return run;
}

// id -> account, registered synchronously at enqueue so a method called right
// after enqueue (before its task has run) still lands on the right chain.
const owners = new Map<string, string>();

export const useSendQueueStore = create<SendQueueState>((set, get) => {
  const setList = (appAccountId: string, list: QueuedSend[]) =>
    set({ entries: { ...get().entries, [appAccountId]: list } });

  const ownerOf = (id: string): string | undefined => {
    const known = owners.get(id);
    if (known) return known;
    const entries = get().entries;
    return Object.keys(entries).find((a) => entries[a].some((e) => e.id === id));
  };

  // Change (or remove, when `change` returns undefined) one entry: write its
  // row, then update memory. Unknown ids are a no-op.
  const mutate = (id: string, change: (e: QueuedSend) => QueuedSend | undefined): Promise<void> => {
    const appAccountId = ownerOf(id);
    if (!appAccountId) return Promise.resolve();
    return serialize(appAccountId, async () => {
      const list = get().entries[appAccountId] ?? [];
      const current = list.find((e) => e.id === id);
      if (!current) return;
      const next = change(current);
      if (next) {
        await AsyncStorage.setItem(rowKey(appAccountId, id), JSON.stringify(next));
        setList(appAccountId, (get().entries[appAccountId] ?? []).map((e) => (e.id === id ? next : e)));
      } else {
        await AsyncStorage.removeItem(rowKey(appAccountId, id));
        setList(appAccountId, (get().entries[appAccountId] ?? []).filter((e) => e.id !== id));
        owners.delete(id);
      }
    });
  };

  return {
    entries: {},

    hydrateAccount: (appAccountId) =>
      serialize(appAccountId, async () => {
        const prefix = accountPrefix(appAccountId);
        const keys = (await AsyncStorage.getAllKeys()).filter(
          (k) => k.startsWith(prefix) && !k.slice(prefix.length).includes(':'),
        );
        const rows = keys.length ? await AsyncStorage.multiGet(keys) : [];
        const memory = get().entries[appAccountId] ?? [];
        const inMemory = new Set(memory.map((e) => e.id));
        const loaded: QueuedSend[] = [];
        for (const [key, raw] of rows) {
          const parsed = parseRow(appAccountId, key, raw);
          if (!parsed || inMemory.has(parsed.id)) continue; // corrupt rows stay on disk untouched
          let entry = parsed;
          if (entry.state === 'sending') {
            entry = { ...entry, state: 'uncertain' };
            try {
              await AsyncStorage.setItem(key, JSON.stringify(entry));
            } catch (err) {
              console.warn('[send-queue] could not write back repaired row', err);
            }
          }
          loaded.push(entry);
        }
        loaded.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        for (const e of loaded) owners.set(e.id, appAccountId);
        setList(appAccountId, [...memory, ...loaded]);
      }),

    enqueue: (input) => {
      const raw = input.outgoing?.messageId;
      if (typeof raw !== 'string' || !stripMessageIdBrackets(raw)) {
        return Promise.reject(new Error('A queued send needs a Message-ID'));
      }
      const entry: QueuedSend = { ...input, messageId: stripMessageIdBrackets(raw) };
      if (utf8Length(JSON.stringify(entry)) > MAX_ENTRY_BYTES) {
        return Promise.reject(new SendTooLargeToQueueError());
      }
      const { appAccountId, id } = entry;
      const existing = owners.get(id);
      if (existing) return Promise.reject(new Error(`Queued send ${id} already exists`));
      owners.set(id, appAccountId);
      return serialize(appAccountId, async () => {
        try {
          if ((get().entries[appAccountId] ?? []).some((e) => e.id === id)
            || (await AsyncStorage.getItem(rowKey(appAccountId, id))) !== null) {
            throw new Error(`Queued send ${id} already exists`);
          }
          await AsyncStorage.setItem(rowKey(appAccountId, id), JSON.stringify(entry));
        } catch (err) {
          // Only release the claim if no loaded entry holds this id.
          if (!(get().entries[appAccountId] ?? []).some((e) => e.id === id)) owners.delete(id);
          throw err;
        }
        setList(appAccountId, [...(get().entries[appAccountId] ?? []), entry]);
      });
    },

    markSending: (id) =>
      mutate(id, (e) => ({ ...e, state: 'sending', attemptStartedAt: new Date().toISOString() })),

    complete: (id) => mutate(id, () => undefined),

    markUncertain: (id, error) => mutate(id, (e) => ({ ...e, state: 'uncertain', lastError: error })),

    markFailed: (id, error) => mutate(id, (e) => ({ ...e, state: 'failed', lastError: error })),

    requeue: (id) =>
      mutate(id, (e) => ({ ...e, state: 'queued', lastError: undefined, attemptStartedAt: undefined })),

    discard: (id) => mutate(id, () => undefined),

    clearAccount: (appAccountId) =>
      serialize(appAccountId, async () => {
        const prefix = accountPrefix(appAccountId);
        const keys = (await AsyncStorage.getAllKeys()).filter(
          (k) => k.startsWith(prefix) && !k.slice(prefix.length).includes(':'),
        );
        if (keys.length) await AsyncStorage.multiRemove(keys);
        for (const e of get().entries[appAccountId] ?? []) owners.delete(e.id);
        const { [appAccountId]: _gone, ...rest } = get().entries;
        set({ entries: rest });
      }),
  };
});
