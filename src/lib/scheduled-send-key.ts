// Scheduled sends of the own and a group or shared account are listed
// together, and submission ids repeat across accounts (Stalwart numbers each
// account's records from the start). So a row is the pair of account and
// submission id: by the id alone, cancelling or rescheduling one account's
// message also took the other's row off the list or rewrote it, and the undo
// snackbar of one was cleared by an action on the other (webmail e314e5666).

import type { ScheduledEmail } from '../api/email';

type Keyed = Pick<ScheduledEmail, 'accountId' | 'emailSubmissionId'>;

/** The list key of a scheduled send. */
export function scheduledSendKey(item: Keyed): string {
  return `${item.accountId}|${item.emailSubmissionId}`;
}

/** Whether two scheduled sends are the same record. */
export function sameScheduledSend(a: Keyed, b: Keyed): boolean {
  return a.accountId === b.accountId && a.emailSubmissionId === b.emailSubmissionId;
}

/**
 * Whether the undo snackbar's pending send is this row. The pending send
 * names no account for a send from the own account (`ownAccountId`).
 */
export function isPendingSend(
  pending: { emailSubmissionId: string; accountId?: string } | null | undefined,
  item: Keyed,
  ownAccountId: string,
): boolean {
  return !!pending && sameScheduledSend({ accountId: pending.accountId ?? ownAccountId, emailSubmissionId: pending.emailSubmissionId }, item);
}
