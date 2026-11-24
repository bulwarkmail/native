import type { Mailbox } from '../api/types';
import { mailboxesForSiblingOf, ownMailboxes } from './mailbox-tree';

/** What Android back does on a list screen (mail, contacts). */
export type ListBackStep = 'clear-selection' | 'clear-search' | 'open-inbox' | 'leave';

/**
 * Back works through the list's own layers first: selection mode ends, then
 * an open search (and on mail its filters) clears, then the mail list goes
 * from another folder to the Inbox, as other mail apps do. Only a plain list
 * lets back `leave`: on the mail root that closes the app, on another tab it
 * goes back to Mail. A search used to exit the app straight away, and so did
 * any folder.
 */
export function listBackStep(state: {
  selecting: boolean;
  searching: boolean;
  /** Mail only: a folder other than the Inbox is open. */
  outsideInbox?: boolean;
}): ListBackStep {
  if (state.selecting) return 'clear-selection';
  if (state.searching) return 'clear-search';
  if (state.outsideInbox) return 'open-inbox';
  return 'leave';
}

/**
 * The Inbox back leads to from the open folder. Within a shared account it is
 * that account's Inbox first, as other mail apps keep back inside the account
 * that is open; from there, or from a shared account without one, it is the
 * user's own Inbox, where the app starts. Null when the user's own Inbox is
 * open already or there is none.
 */
export function inboxBackTarget(mailboxes: Mailbox[], currentMailboxId: string | null): string | null {
  const own = ownMailboxes(mailboxes).find((m) => m.role === 'inbox');
  if (!own || !currentMailboxId || own.id === currentMailboxId) return null;
  const current = mailboxes.find((m) => m.id === currentMailboxId);
  if (current?.isShared && current.role !== 'inbox') {
    const shared = mailboxesForSiblingOf(mailboxes, currentMailboxId).find((m) => m.role === 'inbox');
    if (shared) return shared.id;
  }
  return own.id;
}
