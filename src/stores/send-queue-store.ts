// Persistent offline send queue. A message sent while offline is stored here
// and replayed once the connection returns; it must never be sent twice.
//
// The send-safety rule: `markSending` is persisted before any request is made,
// so a crash mid-request leaves `sending` on disk. Hydration turns that into
// `uncertain` (the server may or may not have accepted it) and replay then
// checks by Message-ID instead of resending blindly.
//
// Storage is keyed per account (`webmail:sendqueue:v1:<appAccountId>`), separate
// from the mutation outbox. The store makes no network or JMAP calls.

import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { OutgoingEmail } from '../api/email';

const KEY_PREFIX = 'webmail:sendqueue:v1:';
const MAX_ENTRY_BYTES = 1024 * 1024;

function storageKey(appAccountId: string): string {
  return `${KEY_PREFIX}${appAccountId}`;
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

  hydrateAccount: (appAccountId: string) => Promise<void>;
  enqueue: (entry: QueuedSend) => Promise<void>;
  /** Persisted before it resolves; call before any request is made. */
  markSending: (id: string) => Promise<void>;
  complete: (id: string) => Promise<void>;
  markUncertain: (id: string, error: string) => Promise<void>;
  markFailed: (id: string, error: string) => Promise<void>;
  requeue: (id: string) => Promise<void>;
  discard: (id: string) => Promise<void>;
  clearAccount: (appAccountId: string) => Promise<void>;
}

// One write chain per account so back-to-back calls never interleave or lose a
// write. A failed write does not break the chain for later calls.
const chains = new Map<string, Promise<unknown>>();

function serialize<T>(appAccountId: string, task: () => Promise<T>): Promise<T> {
  const prev = chains.get(appAccountId) ?? Promise.resolve();
  const run = prev.then(task, task);
  chains.set(appAccountId, run.catch(() => undefined));
  return run;
}

function persist(appAccountId: string, list: QueuedSend[]): Promise<void> {
  return serialize(appAccountId, () =>
    AsyncStorage.setItem(storageKey(appAccountId), JSON.stringify(list)));
}

async function load(appAccountId: string): Promise<{ list: QueuedSend[]; repaired: boolean }> {
  let repaired = false;
  try {
    const raw = await AsyncStorage.getItem(storageKey(appAccountId));
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const list = (parsed as QueuedSend[]).map((e) => {
          if (e.state !== 'sending') return e;
          repaired = true;
          return { ...e, state: 'uncertain' as const };
        });
        return { list, repaired };
      }
    }
  } catch (err) {
    console.warn('[send-queue] hydrate failed', err);
  }
  return { list: [], repaired };
}

export const useSendQueueStore = create<SendQueueState>((set, get) => {
  // Apply a change to the entry with this id (undefined = remove) and persist
  // the owning account's list before resolving. Unknown ids are a no-op.
  const mutate = async (
    id: string,
    change: (e: QueuedSend) => QueuedSend | undefined,
  ): Promise<void> => {
    const entries = get().entries;
    const appAccountId = Object.keys(entries).find((a) => entries[a].some((e) => e.id === id));
    if (!appAccountId) return;
    const list = entries[appAccountId].flatMap((e) => {
      if (e.id !== id) return [e];
      const next = change(e);
      return next ? [next] : [];
    });
    set({ entries: { ...get().entries, [appAccountId]: list } });
    await persist(appAccountId, list);
  };

  return {
    entries: {},

    hydrateAccount: async (appAccountId) => {
      // Run behind pending writes so we never read a stale bucket.
      await serialize(appAccountId, async () => {
        const { list, repaired } = await load(appAccountId);
        set({ entries: { ...get().entries, [appAccountId]: list } });
        if (repaired) await AsyncStorage.setItem(storageKey(appAccountId), JSON.stringify(list));
      });
    },

    enqueue: async (entry) => {
      if (!entry.messageId || !entry.outgoing?.messageId) {
        throw new Error('A queued send needs a Message-ID');
      }
      const serialized = JSON.stringify(entry);
      if (serialized.length > MAX_ENTRY_BYTES) throw new SendTooLargeToQueueError();
      const list = [...(get().entries[entry.appAccountId] ?? []), entry];
      set({ entries: { ...get().entries, [entry.appAccountId]: list } });
      await persist(entry.appAccountId, list);
    },

    markSending: (id) =>
      mutate(id, (e) => ({ ...e, state: 'sending', attemptStartedAt: new Date().toISOString() })),

    complete: (id) => mutate(id, () => undefined),

    markUncertain: (id, error) => mutate(id, (e) => ({ ...e, state: 'uncertain', lastError: error })),

    markFailed: (id, error) => mutate(id, (e) => ({ ...e, state: 'failed', lastError: error })),

    requeue: (id) =>
      mutate(id, (e) => ({ ...e, state: 'queued', lastError: undefined, attemptStartedAt: undefined })),

    discard: (id) => mutate(id, () => undefined),

    clearAccount: async (appAccountId) => {
      const { [appAccountId]: _gone, ...rest } = get().entries;
      set({ entries: rest });
      await serialize(appAccountId, () => AsyncStorage.removeItem(storageKey(appAccountId)));
    },
  };
});
