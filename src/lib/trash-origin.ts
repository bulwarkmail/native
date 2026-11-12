/**
 * Where a message was before it went to Trash, so "Restore" can put it back
 * there (webmail lib/trash-origin.ts, e8d8486b8). JMAP doesn't keep that, so
 * this device notes it when the app moves mail to Trash. A message deleted
 * elsewhere, or one whose folder is gone, goes back to the Inbox of its own
 * account. Kept in memory and in AsyncStorage, the last 2000 messages.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const KEY = 'bulwark.trashOrigin.v1';
const KEPT = 2000;

interface OriginMailbox {
  id: string;
  role?: string | null;
  isShared?: boolean;
  accountId?: string;
  myRights?: { mayAddItems?: boolean } | null;
}

// Insertion order is age: the oldest go first when the list is full.
let origins = new Map<string, string>();
let loaded: Promise<void> | null = null;

// Email ids repeat across accounts; the Trash folder's list id doesn't.
const keyOf = (emailId: string, trashMailboxId: string) => `${trashMailboxId}|${emailId}`;

/** Reads what an earlier run noted; later notes of this run win. */
export function loadTrashOrigins(): Promise<void> {
  loaded ??= (async () => {
    try {
      const raw = await AsyncStorage.getItem(KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      const merged = new Map<string, string>();
      for (const [key, mailboxId] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof mailboxId === 'string') merged.set(key, mailboxId);
      }
      for (const [key, mailboxId] of origins) {
        merged.delete(key);
        merged.set(key, mailboxId);
      }
      origins = merged;
    } catch {
      // Unreadable: Restore goes to the Inbox.
    }
  })();
  return loaded;
}

function persist(): void {
  try {
    void AsyncStorage.setItem(KEY, JSON.stringify(Object.fromEntries(origins))).catch(() => undefined);
  } catch {
    // Storage off: Restore goes to the Inbox.
  }
}

/** Notes the folder (its list id) each message left for the Trash folder `trashMailboxId`. */
export function rememberTrashOrigins(emailIds: readonly string[], fromMailboxId: string, trashMailboxId: string): void {
  if (emailIds.length === 0) return;
  void loadTrashOrigins();
  for (const id of emailIds) {
    const key = keyOf(id, trashMailboxId);
    origins.delete(key);
    origins.set(key, fromMailboxId);
  }
  for (const key of [...origins.keys()].slice(0, Math.max(0, origins.size - KEPT))) origins.delete(key);
  persist();
}

/** The Inbox of the account a message in `trash` lives in. */
function inboxFor(trash: OriginMailbox | undefined, mailboxes: readonly OriginMailbox[]): OriginMailbox | undefined {
  if (trash?.isShared) return mailboxes.find((m) => m.isShared && m.role === 'inbox' && m.accountId === trash.accountId);
  return mailboxes.find((m) => !m.isShared && m.role === 'inbox');
}

/**
 * Where Restore puts a message of the Trash folder `trashMailboxId`: the
 * folder it was in, if that still exists and takes mail, else its account's
 * Inbox.
 */
export function restoreTarget(
  emailId: string,
  trashMailboxId: string,
  mailboxes: readonly OriginMailbox[],
): string | undefined {
  const trash = mailboxes.find((m) => m.id === trashMailboxId);
  const origin = origins.get(keyOf(emailId, trashMailboxId));
  const mailbox = origin ? mailboxes.find((m) => m.id === origin) : undefined;
  if (mailbox && mailbox.role !== 'trash' && mailbox.myRights?.mayAddItems !== false
    && !!mailbox.isShared === !!trash?.isShared && (!trash?.isShared || mailbox.accountId === trash.accountId)) {
    return mailbox.id;
  }
  return inboxFor(trash, mailboxes)?.id;
}

/** One place for several messages: where they all came from, or the Inbox when they differ. */
export function restoreTargetForAll(
  emailIds: readonly string[],
  trashMailboxId: string,
  mailboxes: readonly OriginMailbox[],
): string | undefined {
  if (emailIds.length === 0) return undefined;
  const targets = new Set(emailIds.map((id) => restoreTarget(id, trashMailboxId, mailboxes)));
  if (targets.size === 1) return [...targets][0];
  return inboxFor(mailboxes.find((m) => m.id === trashMailboxId), mailboxes)?.id;
}

export function resetTrashOriginsForTests(): void {
  origins = new Map();
  loaded = null;
}
