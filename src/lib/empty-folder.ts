import type { Mailbox } from '../api/types';
import type { DeleteAction } from '../stores/settings-store';
import { emptyMailbox, moveMailboxContents } from '../api/email';
import type { OpScope } from '../api/op-scope';
import { inAccount } from '../api/op-scope';
import { findTrashMailbox, mailboxesOfAccount } from './mailbox-tree';

export type EmptyFolderPlan =
  | { kind: 'destroy' }
  | { kind: 'trash'; trash: Mailbox; markRead: boolean }
  /** A move was wanted but the folder's own account has no Trash. */
  | { kind: 'no-trash' };

/**
 * What "Empty folder" does to `mailbox` (webmail `emptyFolderMovesToTrash`).
 * Trash and Junk destroy, as does every delete for users who chose permanent
 * deletion; any other folder is moved to the Trash of the account that owns
 * it: ids repeat across accounts, and another account's Trash is not a
 * destination. A folder that is itself the Trash is never "moved to Trash".
 */
export function planEmptyFolder(
  mailboxes: Mailbox[],
  mailbox: Mailbox,
  deleteAction: DeleteAction,
): EmptyFolderPlan {
  if (mailbox.role === 'trash' || mailbox.role === 'junk' || mailbox.role === 'spam') return { kind: 'destroy' };
  if (deleteAction === 'permanent') return { kind: 'destroy' };
  const owned = mailboxesOfAccount(mailboxes, mailbox.isShared ? mailbox.accountId : undefined);
  const trash = findTrashMailbox(owned);
  if (!trash) return { kind: 'no-trash' };
  if (trash.id === mailbox.id) return { kind: 'destroy' };
  return { kind: 'trash', trash, markRead: deleteAction === 'trash-and-read' };
}

/**
 * Run a plan on `mailbox` under scope `at` (taken at the tap by
 * `requireShownAccountScope`). Throws a message-bearing Error when only part
 * of the folder could be moved, so the caller's one error path reports it.
 */
export async function runEmptyFolder(plan: EmptyFolderPlan, mailbox: Mailbox, at: OpScope): Promise<void> {
  const accountId = mailbox.isShared ? mailbox.accountId : undefined;
  const from = mailbox.originalId ?? mailbox.id;
  if (plan.kind === 'no-trash') throw new Error('Trash mailbox not found - cannot move emails to trash');
  if (plan.kind === 'destroy') {
    await emptyMailbox(from, inAccount(at, accountId));
    return;
  }
  const to = plan.trash.originalId ?? plan.trash.id;
  const { moved, failed } = await moveMailboxContents(from, to, inAccount(at, accountId), plan.markRead);
  if (failed > 0) {
    throw new Error(`${moved} moved to Trash, ${failed} could not be moved. The rest were left in the folder.`);
  }
}
