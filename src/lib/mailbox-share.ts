import { inAccount, type OpScope } from '../api/op-scope';
import type { Mailbox } from '../api/types';
import { t } from '../stores/locale-store';

/**
 * Where folder `mailbox` is shared from, on the connection `at` was taken
 * on: its own account (the owner's for a folder shared with the user) and
 * its raw JMAP id there. A shared folder's store id is `<accountId>:<rawId>`,
 * which no server knows, and its raw id repeats in the user's own account.
 */
export function mailboxShareScope(mailbox: Mailbox, at: OpScope): { at: OpScope; id: string } {
  if (!mailbox.isShared) return { at, id: mailbox.id };
  // With no owner account the scope would stay the user's own, where the
  // same raw id names another folder.
  if (!mailbox.accountId) {
    throw new Error(t('sharing.folder_owner_unknown', 'Could not tell whose folder this is, so it can\'t be shared.'));
  }
  const prefix = `${mailbox.accountId}:`;
  const id = mailbox.originalId
    ?? (mailbox.id.startsWith(prefix) ? mailbox.id.slice(prefix.length) : mailbox.id);
  return { at: inAccount(at, mailbox.accountId), id };
}
