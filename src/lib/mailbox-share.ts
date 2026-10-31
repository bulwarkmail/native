import type { Mailbox } from '../api/types';

// Folder sharing (webmail mailbox-share-dialog.tsx and the Share entry of
// mailbox-context-menu.tsx): which folders offer it, and where it is kept.

/**
 * Where a folder's sharing is read and written: a folder of a shared or
 * group account lives under its owner's account with the owner's id.
 */
export function mailboxShareRef(mailbox: Pick<Mailbox, 'id' | 'originalId' | 'isShared' | 'accountId'>): {
  mailboxId: string;
  accountId: string | undefined;
} {
  return {
    mailboxId: mailbox.originalId || mailbox.id,
    accountId: mailbox.isShared ? mailbox.accountId : undefined,
  };
}

/**
 * Whether the folder's menu offers "Share": the server takes shareWith on
 * folders (mail:share), and a folder someone shared with the user may be
 * passed on only with their permission (webmail mailbox-context-menu.tsx).
 */
export function canShareMailbox(
  mailbox: Pick<Mailbox, 'isShared' | 'myRights'>,
  serverSupportsSharing: boolean,
): boolean {
  if (!serverSupportsSharing) return false;
  return !mailbox.isShared || (mailbox.myRights as { mayShare?: boolean } | undefined)?.mayShare === true;
}
