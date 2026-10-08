import { inAccount, type OpScope } from '../api/op-scope';
import type { Mailbox } from '../api/types';

/**
 * Where folder `mailbox` is shared from, on the connection `at` was taken
 * on: its own account (the owner's for a folder shared with the user) and
 * its raw JMAP id there. A shared folder's store id is `<accountId>:<rawId>`,
 * which no server knows, and its raw id repeats in the user's own account.
 */
export function mailboxShareScope(mailbox: Mailbox, at: OpScope): { at: OpScope; id: string } {
  if (!mailbox.isShared) return { at, id: mailbox.id };
  const prefix = `${mailbox.accountId}:`;
  const id = mailbox.originalId
    ?? (mailbox.accountId && mailbox.id.startsWith(prefix) ? mailbox.id.slice(prefix.length) : mailbox.id);
  return { at: inAccount(at, mailbox.accountId), id };
}
