// "Cancel send" and "Edit" of a scheduled message: the submission is
// cancelled and the message goes back to Drafts, so nothing sits in Sent
// looking sent (webmail cancelScheduledEmailForEdit, 780b64461). A message
// held in a shared or group account goes back to that account's Drafts.

import { cancelScheduledSend, restoreEmailToDraft, type ScheduledEmail } from '../api/email';
import type { Mailbox } from '../api/types';
import { mailboxesOfAccount } from './mailbox-tree';

/** The account to pass to the mail calls for `item`: undefined for the own one. */
export function scheduledAccountOverride(item: Pick<ScheduledEmail, 'accountId'>, ownAccountId: string): string | undefined {
  return item.accountId !== ownAccountId ? item.accountId : undefined;
}

/** Where a cancelled scheduled message is now. */
export interface CancelledToDrafts {
  /** Back in Drafts. False: still in Sent, but no longer scheduled. */
  inDrafts: boolean;
  /**
   * Why the move to Drafts failed after the cancel went through. The send is
   * cancelled all the same: the row goes, and the user hears it stayed in
   * Sent rather than "Cancel failed".
   */
  moveError?: unknown;
}

/**
 * Cancel the scheduled send and move the message back into Drafts. It stays
 * in Sent when the account has no Drafts folder or the move fails (see
 * CancelledToDrafts). A failed cancel throws and moves nothing.
 */
export async function cancelScheduledToDrafts(
  item: Pick<ScheduledEmail, 'accountId' | 'emailSubmissionId' | 'emailId'>,
  mailboxes: Mailbox[],
  ownAccountId: string,
): Promise<CancelledToDrafts> {
  await cancelScheduledSend(item.emailSubmissionId, item.accountId);
  const scope = mailboxesOfAccount(mailboxes, scheduledAccountOverride(item, ownAccountId));
  const drafts = scope.find((m) => m.role === 'drafts');
  const sent = scope.find((m) => m.role === 'sent');
  if (!drafts) return { inDrafts: false };
  try {
    await restoreEmailToDraft(
      item.emailId,
      drafts.originalId ?? drafts.id,
      sent ? (sent.originalId ?? sent.id) : undefined,
      item.accountId,
    );
  } catch (moveError) {
    return { inDrafts: false, moveError };
  }
  return { inDrafts: true };
}
