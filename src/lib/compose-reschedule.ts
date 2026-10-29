// What a failed "Send now" or reschedule leaves behind, and how to say so.
// The original is cancelled before its replacement is made (#1308), so a
// failure can end three ways: nothing changed (the cancel failed), the
// original was put back under a new submission id (RescheduleRestoredError),
// or the message is no longer scheduled and back in Drafts
// (RescheduleLostError). The undo bar and the Scheduled list both follow
// the message to its new id, or drop it.

import { RescheduleLostError, RescheduleRestoredError } from '../api/email';
import { ScheduleTooLateError } from '../api/jmap-result';
import type { TranslateFn } from '../stores/locale-store';
import { rescheduleFailureNotice } from './send-failure-message';

/** The submission a failed reschedule put back, which now stands for the message; null when none did. */
export function restoredSubmission(err: unknown): { emailSubmissionId: string; sendAt?: string } | null {
  return err instanceof RescheduleRestoredError
    ? { emailSubmissionId: err.restoredSubmissionId, sendAt: err.restoredSendAt }
    : null;
}

/** Whether the message is not scheduled any more after the failure. */
export function rescheduleLostMessage(err: unknown): boolean {
  return err instanceof RescheduleLostError;
}

/**
 * The alert or toast for a failed reschedule. `formatWhen` formats an ISO
 * time for "still scheduled for …"; `scheduledAt` is the time it was
 * scheduled for before.
 */
export function rescheduleErrorNotice(
  err: unknown,
  t: TranslateFn,
  failTitle: string,
  formatWhen?: (iso: string) => string,
  scheduledAt?: string,
): { title: string; message: string } {
  if (err instanceof RescheduleLostError) {
    return {
      title: failTitle,
      message: err.inDrafts
        ? t('scheduled.reschedule_lost_drafts', 'The message is no longer scheduled. It is back in Drafts, where you can send it again.')
        : t('scheduled.reschedule_lost', 'The message is no longer scheduled. Check Drafts and Sent before sending it again.'),
    };
  }
  if (err instanceof RescheduleRestoredError) {
    const when = err.restoredSendAt ?? scheduledAt;
    if (err.reason instanceof ScheduleTooLateError) {
      return {
        title: t('email_composer.schedule_too_late_title', 'Too far ahead'),
        message: t('email_composer.schedule_too_late_body', 'That is later than this server allows. Pick an earlier time.'),
      };
    }
    return rescheduleFailureNotice(err.reason, t, failTitle, when && formatWhen ? formatWhen(when) : undefined);
  }
  return rescheduleFailureNotice(err, t, failTitle, scheduledAt && formatWhen ? formatWhen(scheduledAt) : undefined);
}
