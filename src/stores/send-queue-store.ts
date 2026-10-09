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
import { mayRestamp } from '../lib/queue-restamp';

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

/**
 * The entry a stored row holds, or null when hydrate would skip it: unreadable
 * JSON, a row under another key or account, an unknown state, or no message.
 * Shared by everything that counts queued sends, so a count never includes a
 * row the Outbox cannot show.
 */
export function parseQueuedSendRow(appAccountId: string, key: string, raw: string | null): QueuedSend | null {
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

/**
 * Why replay holds a `queued` entry instead of sending it: its schedule cannot
 * be read, the account has no Sent or no Drafts folder, or the session does
 * not serve its JMAP account. A held entry waits for the user (Retry, Save as
 * draft, Discard); it is never sent until the user's Retry clears the hold,
 * with one exception: replay clears `account_unavailable` on an entry that was
 * never attempted once the session serves that account again (releaseHold).
 */
export type HeldReason = 'bad_schedule' | 'no_sent' | 'no_drafts' | 'account_unavailable';

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
  /** `untrusted`: addresses the replay must not trust (untrustedReplyAddresses). */
  replyTo?: { emailIds: string[]; keyword: '$answered' | '$forwarded'; jmapAccountId?: string; untrusted?: string[] };
  createdAt: string;
  state: QueuedSendState;
  attemptStartedAt?: string;
  lastError?: string;
  /** Set on a `queued` entry replay cannot send; cleared by requeue. */
  heldReason?: HeldReason;
  /** When replay last looked for proof of an `uncertain` entry (backoff). */
  lastReconcileAt?: string;
}

export class SendTooLargeToQueueError extends Error {
  constructor(message = 'This message is too large to queue for sending later') {
    super(message);
    this.name = 'SendTooLargeToQueueError';
  }
}

/** An unknown id, an unhydrated account, or a transition the state machine disallows. */
export class SendQueueStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendQueueStateError';
  }
}

/** The account already holds an entry with this Message-ID: the message is in the Outbox. */
export class AlreadyQueuedError extends Error {
  constructor(message = 'This message is already in the Outbox') {
    super(message);
    this.name = 'AlreadyQueuedError';
  }
}

const ID_PATTERN = /^[A-Za-z0-9_-]+$/;

interface SendQueueState {
  /** Loaded queues by app account id. */
  entries: Record<string, QueuedSend[]>;
  /** True once an account's hydrate has succeeded; mutators (except enqueue/clearAccount) need it. */
  hydrated: Record<string, boolean>;

  /** Load an account's rows, merging with memory (memory wins, never downgrades). */
  hydrateAccount: (appAccountId: string) => Promise<void>;
  /**
   * `messageId` is derived from `outgoing.messageId`; any supplied value is
   * ignored. Rejects with AlreadyQueuedError when the account already holds an
   * entry (loaded or, before hydration, on disk) with that Message-ID.
   */
  enqueue: (entry: Omit<QueuedSend, 'messageId'> & { messageId?: string }) => Promise<void>;
  /** Persisted before it resolves; call before any request is made. */
  markSending: (id: string) => Promise<void>;
  complete: (id: string) => Promise<void>;
  markUncertain: (id: string, error: string) => Promise<void>;
  markFailed: (id: string, error: string) => Promise<void>;
  /**
   * failed | uncertain | held queued -> queued: the user's Retry. Clears the
   * hold. Never from `sending`, nor from a `queued` entry that is not held.
   */
  requeue: (id: string) => Promise<void>;
  /** queued -> queued with `heldReason`: replay cannot send it; it waits for the user. */
  hold: (id: string, reason: HeldReason) => Promise<void>;
  /**
   * queued (held `account_unavailable`, never attempted) -> queued: replay saw
   * the account served again. Refused for any other hold reason, for an entry
   * with an `attemptStartedAt`, and in any other state.
   */
  releaseHold: (id: string) => Promise<void>;
  /**
   * queued (held `account_unavailable`, never attempted, no attachments) ->
   * queued on `jmapAccountId`: replay found the entry's account renumbered
   * and its identity on the session's primary (restampTarget). Clears the
   * hold, drops `draftId` and the replied-to email ids (JMAP ids of the old
   * account), and keeps the keyword and the `untrusted` list. Refused in any
   * other state, and onto the account the entry already names.
   */
  restamp: (id: string, jmapAccountId: string) => Promise<void>;
  /** uncertain -> uncertain with `lastReconcileAt` now: replay looked for proof. */
  noteReconcile: (id: string) => Promise<void>;
  /**
   * sending -> queued, for replay only: the request was never made (an
   * account re-check failed after markSending) or never reached the server
   * (an auth error).
   */
  releaseUnsent: (id: string) => Promise<void>;
  /** Removes an entry in any state but `sending` (a send may be in flight). */
  discard: (id: string) => Promise<void>;
  clearAccount: (appAccountId: string) => Promise<void>;
  /**
   * Forget a signed-out account's entries in memory only; its rows stay on
   * disk and load again when the account signs in (hydrateAccount).
   */
  unloadAccount: (appAccountId: string) => Promise<void>;
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

  // Checked transition on one entry: `from` lists the states the entry may be
  // in (checked when the task runs, so it is a compare-and-set); `change`
  // returns the new entry, or undefined to remove it. The row is written
  // before memory changes. Rejects with SendQueueStateError otherwise.
  const transition = (
    id: string,
    from: readonly QueuedSendState[] | ((e: QueuedSend) => boolean),
    change: (e: QueuedSend) => QueuedSend | undefined,
  ): Promise<void> => {
    const allowed = typeof from === 'function' ? from : (e: QueuedSend) => from.includes(e.state);
    const appAccountId = ownerOf(id);
    if (!appAccountId) return Promise.reject(new SendQueueStateError(`Unknown queued send ${id}`));
    return serialize(appAccountId, async () => {
      if (!get().hydrated[appAccountId]) {
        throw new SendQueueStateError(`Account ${appAccountId} is not hydrated`);
      }
      const current = (get().entries[appAccountId] ?? []).find((e) => e.id === id);
      if (!current) throw new SendQueueStateError(`Unknown queued send ${id}`);
      if (!allowed(current)) {
        throw new SendQueueStateError(`Queued send ${id} is ${current.state}; transition not allowed`);
      }
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

  // Loaded entries once the account is hydrated; before that, its rows on disk too.
  const holdsMessageId = async (appAccountId: string, messageId: string): Promise<boolean> => {
    if ((get().entries[appAccountId] ?? []).some((e) => e.messageId === messageId)) return true;
    if (get().hydrated[appAccountId]) return false;
    const prefix = accountPrefix(appAccountId);
    const keys = (await AsyncStorage.getAllKeys()).filter(
      (k) => k.startsWith(prefix) && !k.slice(prefix.length).includes(':'),
    );
    const rows = keys.length ? await AsyncStorage.multiGet(keys) : [];
    return rows.some(([key, raw]) => parseQueuedSendRow(appAccountId, key, raw)?.messageId === messageId);
  };

  return {
    entries: {},
    hydrated: {},

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
          const parsed = parseQueuedSendRow(appAccountId, key, raw);
          if (!parsed || inMemory.has(parsed.id)) continue; // corrupt rows stay on disk untouched
          let entry = parsed;
          if (entry.state === 'sending') {
            entry = { ...entry, state: 'uncertain' };
            // A failed write-back rejects the hydrate with memory untouched.
            await AsyncStorage.setItem(key, JSON.stringify(entry));
          }
          loaded.push(entry);
        }
        loaded.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        for (const e of loaded) owners.set(e.id, appAccountId);
        set({
          entries: { ...get().entries, [appAccountId]: [...memory, ...loaded] },
          hydrated: { ...get().hydrated, [appAccountId]: true },
        });
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
      if (!ID_PATTERN.test(id)) return Promise.reject(new Error(`Invalid queued send id ${id}`));
      const existing = owners.get(id);
      if (existing) return Promise.reject(new Error(`Queued send ${id} already exists`));
      owners.set(id, appAccountId);
      return serialize(appAccountId, async () => {
        try {
          if ((get().entries[appAccountId] ?? []).some((e) => e.id === id)
            || (await AsyncStorage.getItem(rowKey(appAccountId, id))) !== null) {
            throw new Error(`Queued send ${id} already exists`);
          }
          // One entry per message: a second one would send it twice.
          if (await holdsMessageId(appAccountId, entry.messageId)) throw new AlreadyQueuedError();
          await AsyncStorage.setItem(rowKey(appAccountId, id), JSON.stringify(entry));
        } catch (err) {
          // Only release the claim if no loaded entry holds this id.
          if (!(get().entries[appAccountId] ?? []).some((e) => e.id === id)) owners.delete(id);
          throw err;
        }
        setList(appAccountId, [...(get().entries[appAccountId] ?? []), entry]);
      });
    },

    // A held entry is not sent until the user's Retry clears the hold.
    markSending: (id) =>
      transition(id, (e) => e.state === 'queued' && !e.heldReason, (e) => ({
        ...e, state: 'sending', attemptStartedAt: new Date().toISOString(),
      })),

    // From `queued` as well: replay found proof of an uncertain send that the
    // user requeued meanwhile; the proof wins (flushes are single-flight).
    complete: (id) => transition(id, ['sending', 'uncertain', 'queued'], () => undefined),

    markUncertain: (id, error) =>
      transition(id, ['sending'], (e) => ({ ...e, state: 'uncertain', lastError: error, lastReconcileAt: undefined })),

    markFailed: (id, error) =>
      transition(id, ['sending', 'uncertain'], (e) => ({ ...e, state: 'failed', lastError: error })),

    requeue: (id) =>
      transition(
        id,
        (e) => e.state === 'failed' || e.state === 'uncertain' || (e.state === 'queued' && !!e.heldReason),
        (e) => ({
          ...e, state: 'queued', lastError: undefined, attemptStartedAt: undefined, heldReason: undefined, lastReconcileAt: undefined,
        }),
      ),

    hold: (id, reason) => transition(id, ['queued'], (e) => ({ ...e, heldReason: reason })),

    // The only way out of a hold without the user: the entry was held before
    // markSending, so no request for it was ever made.
    releaseHold: (id) =>
      transition(
        id,
        (e) => e.state === 'queued' && e.heldReason === 'account_unavailable' && !e.attemptStartedAt,
        (e) => {
          const { heldReason: _released, ...rest } = e;
          return rest;
        },
      ),

    restamp: (id, jmapAccountId) =>
      transition(
        id,
        (e) => !!jmapAccountId && e.jmapAccountId !== jmapAccountId && mayRestamp(e),
        (e) => {
          const { heldReason: _released, draftId: _draft, replyTo, ...rest } = e;
          return {
            ...rest,
            jmapAccountId,
            draftId: undefined,
            ...(replyTo ? {
              replyTo: {
                ...replyTo,
                emailIds: [],
                ...(replyTo.jmapAccountId === e.jmapAccountId ? { jmapAccountId } : {}),
              },
            } : {}),
          };
        },
      ),

    noteReconcile: (id) => transition(id, ['uncertain'], (e) => ({ ...e, lastReconcileAt: new Date().toISOString() })),

    releaseUnsent: (id) =>
      transition(id, ['sending'], (e) => ({
        ...e, state: 'queued', attemptStartedAt: undefined,
      })),

    discard: (id) => transition(id, ['queued', 'uncertain', 'failed'], () => undefined),

    clearAccount: (appAccountId) =>
      serialize(appAccountId, async () => {
        const prefix = accountPrefix(appAccountId);
        const keys = (await AsyncStorage.getAllKeys()).filter(
          (k) => k.startsWith(prefix) && !k.slice(prefix.length).includes(':'),
        );
        if (keys.length) await AsyncStorage.multiRemove(keys);
        for (const e of get().entries[appAccountId] ?? []) owners.delete(e.id);
        const { [appAccountId]: _gone, ...rest } = get().entries;
        const { [appAccountId]: _h, ...restHydrated } = get().hydrated;
        set({ entries: rest, hydrated: restHydrated });
      }),

    unloadAccount: (appAccountId) =>
      serialize(appAccountId, async () => {
        for (const e of get().entries[appAccountId] ?? []) owners.delete(e.id);
        const { [appAccountId]: _gone, ...rest } = get().entries;
        const { [appAccountId]: _h, ...restHydrated } = get().hydrated;
        set({ entries: rest, hydrated: restHydrated });
      }),
  };
});
