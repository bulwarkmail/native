import { create } from 'zustand';
import type { Mailbox } from '../api/types';
import { resolveFolderRef } from '../lib/folder-ref';

/**
 * A `mail/folder/<ref>` link, parked for the mail list: it may not be
 * mounted yet, or its account's folders not loaded. Folder ids repeat
 * across accounts, so the target names the signed-in account it was opened
 * for (after any `?account=` switch) and is never resolved against another
 * account's folders.
 */
export interface MailFolderTarget {
  ref: string;
  appAccountId: string;
  /**
   * The folder the list showed when the link came in (after the switch).
   * Another one open by the time the target resolves means the user moved
   * on, and the link is dropped (webmail mail-app.tsx does the same). Null
   * when nothing was open, as on a cold start: then the Inbox the list
   * picks by itself while the folders load is no choice of the user's, so
   * no check is made.
   */
  fromMailboxId: string | null;
}

interface PendingMailFolderState {
  target: MailFolderTarget | null;
  set: (target: MailFolderTarget | null) => void;
  consume: () => MailFolderTarget | null;
}

export const usePendingMailFolder = create<PendingMailFolderState>((set, get) => ({
  target: null,
  set: (target) => set({ target }),
  consume: () => {
    const target = get().target;
    if (target) set({ target: null });
    return target;
  },
}));

export function setPendingMailFolder(target: MailFolderTarget | null): void {
  usePendingMailFolder.getState().set(target);
}

/**
 * Sign-out: forget a link parked for `appAccountId`, or any link when null.
 * Left parked, it would open its folder when the same account signs in again
 * later in this process.
 */
export function dropPendingMailFolder(appAccountId: string | null): void {
  const { target } = usePendingMailFolder.getState();
  if (target && (appAccountId === null || target.appAccountId === appAccountId)) setPendingMailFolder(null);
}

export interface MailFolderView {
  /** The account the mail list shows (email-store `activeAccountId`). */
  shownAccountId: string | null;
  /** That account's folders, own and shared. */
  mailboxes: Mailbox[];
  /** Whether those folders were read from the server this launch, not only the cache. */
  synced: boolean;
  /** The folder the list shows. */
  currentMailboxId: string | null;
}

export type MailFolderPlan =
  | { action: 'open'; mailboxId: string }
  | { action: 'already_open' }
  | { action: 'wait' }
  | { action: 'drop' }
  | { action: 'not_found'; toast: 'deep_link.folder_not_found' };

/**
 * What the mail list does with `target`: drop it when another account is
 * shown or the user opened another folder since, wait while the folders are not there yet (a cold start, a folder
 * the cached list may not have yet), open the folder it names, or say it is
 * gone once the server's list is in.
 */
export function planMailFolderOpen(target: MailFolderTarget, view: MailFolderView): MailFolderPlan {
  if (!view.shownAccountId) return { action: 'wait' };
  if (view.shownAccountId !== target.appAccountId) return { action: 'drop' };
  if (target.fromMailboxId !== null && view.currentMailboxId !== target.fromMailboxId) return { action: 'drop' };
  if (view.mailboxes.length === 0) return { action: 'wait' };
  const mailboxId = resolveFolderRef(target.ref, view.mailboxes);
  if (mailboxId === view.currentMailboxId && mailboxId) return { action: 'already_open' };
  if (mailboxId) return { action: 'open', mailboxId };
  return view.synced ? { action: 'not_found', toast: 'deep_link.folder_not_found' } : { action: 'wait' };
}
