/**
 * What the message list shows, as one string: the account, the folder, the
 * search and the filters (a tag view is a keyword filter). The list scrolls
 * back to the top when it changes, so another folder, tag or search doesn't
 * open at the offset the last one was left at (webmail #1138). The account
 * counts on its own: Stalwart gives every account's Inbox the same id, so a
 * switch to another account's Inbox kept the old offset and its newest mail
 * sat above the fold.
 */
export function listViewKey(
  accountId: string | null,
  currentMailboxId: string | null,
  searchQuery: string,
  filters: object,
): string {
  return JSON.stringify([accountId, currentMailboxId, searchQuery.trim(), filters]);
}
