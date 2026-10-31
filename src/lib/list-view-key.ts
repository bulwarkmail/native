/**
 * What the message list shows, as one string: the folder, the search and the
 * filters (a tag view is a keyword filter). The list scrolls back to the top
 * when it changes, so another folder, tag or search doesn't open at the
 * offset the last one was left at (webmail #1138).
 */
export function listViewKey(
  currentMailboxId: string | null,
  searchQuery: string,
  filters: object,
): string {
  return JSON.stringify([currentMailboxId, searchQuery.trim(), filters]);
}
