// When Settings → Folders may prune the folder icons of folders that are
// gone. Only a list the server confirmed counts: the own folders are swapped
// in together with their Mailbox state token, while a shared-folder update
// rewrites the array with the old own folders (which may still lack one just
// created) and keeps the token. A cached list at cold start has not been
// read from the server this session (`mailboxListsSynced`).

export interface ShownFolders {
  /** App account whose folders are listed. */
  accountId: string | null;
  /** Own Mailbox state token, changed only when the own list is replaced. */
  mailboxState: string | undefined;
  /** The account's folder lists were read from the server this session. */
  synced: boolean;
  ownIds: string[];
}

export interface FolderIconPrunePlan {
  /** Pass back as `lastKey` so the same list is not pruned twice. */
  key: string;
  accountId: string;
  liveIds: string[];
}

export function folderIconPrunePlan(lastKey: string | null, shown: ShownFolders): FolderIconPrunePlan | null {
  const { accountId, mailboxState, synced, ownIds } = shown;
  if (!accountId || !mailboxState || !synced || ownIds.length === 0) return null;
  const key = `${accountId}|${mailboxState}`;
  if (key === lastKey) return null;
  return { key, accountId, liveIds: ownIds };
}
