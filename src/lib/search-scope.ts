import type { Mailbox } from '../api/types';

// The folder scope of a search with no folder picked: every folder except
// Spam and Trash, like the webmail's default "All folders except Spam and
// Trash" scope. The explicit "All folders" pick covers those two as well.

/**
 * The raw (owner-account) ids of one JMAP account's Trash and Junk folders,
 * Trash first; only the ones the account has. Shared folders carry a store
 * prefix, so their `originalId` is what the server knows them by.
 */
export function trashAndJunkIds(mailboxes: Mailbox[], accountId: string): string[] {
  return (['trash', 'junk'] as const)
    .map((role) => mailboxes.find((m) => m.accountId === accountId && m.role === role))
    .filter((m): m is Mailbox => Boolean(m))
    .map((m) => m.originalId ?? m.id);
}

/** The condition that leaves `ids` out of an Email/query, or null when there are none. */
export function exclusionFilter(ids: string[]): { inMailboxOtherThan: string[] } | null {
  return ids.length > 0 ? { inMailboxOtherThan: ids } : null;
}

/**
 * The scope a search starts with when no folder is picked: Spam and Trash
 * search themselves, since that is what a search from inside them looks for;
 * every other folder searches all folders except Spam and Trash.
 */
export function defaultSearchScopeFor(current: Mailbox | undefined): 'all' | 'current' {
  return current?.role === 'trash' || current?.role === 'junk' ? 'current' : 'all';
}
