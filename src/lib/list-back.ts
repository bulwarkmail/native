import type { Mailbox } from '../api/types';
import { ownMailboxes } from './mailbox-tree';

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
 * The Inbox back leads to from the open folder: the user's own, also from a
 * shared account's folder, since that is where the app starts. Null when the
 * Inbox is open already or the account has none.
 */
export function inboxBackTarget(mailboxes: Mailbox[], currentMailboxId: string | null): string | null {
  const inbox = ownMailboxes(mailboxes).find((m) => m.role === 'inbox');
  if (!inbox || !currentMailboxId || inbox.id === currentMailboxId) return null;
  return inbox.id;
}
