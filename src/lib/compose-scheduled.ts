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

/**
 * Cancel the scheduled send and move the message back into Drafts. Resolves
 * with whether it is in Drafts now: false when the account has no Drafts
 * folder, where it stays in Sent. A failed cancel throws and moves nothing.
 */
export async function cancelScheduledToDrafts(
  item: Pick<ScheduledEmail, 'accountId' | 'emailSubmissionId' | 'emailId'>,
  mailboxes: Mailbox[],
  ownAccountId: string,
): Promise<boolean> {
  await cancelScheduledSend(item.emailSubmissionId, item.accountId);
  const scope = mailboxesOfAccount(mailboxes, scheduledAccountOverride(item, ownAccountId));
  const drafts = scope.find((m) => m.role === 'drafts');
  const sent = scope.find((m) => m.role === 'sent');
  if (!drafts) return false;
  await restoreEmailToDraft(
    item.emailId,
    drafts.originalId ?? drafts.id,
    sent ? (sent.originalId ?? sent.id) : undefined,
    item.accountId,
  );
  return true;
}
