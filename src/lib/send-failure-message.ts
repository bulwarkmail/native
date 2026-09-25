import { RequestTimeoutError } from '../api/jmap-client';
import { ScheduleTooLateError, SubmissionQuotaError } from '../api/jmap-result';

type Translate = (key: string, fallback?: string) => string;

/**
 * What to tell the user about a send (or reschedule) that failed (webmail
 * send-failure-message). Most errors carry the server's own description;
 * these are the ones it would misrepresent or leave unexplained:
 * - a full submission quota: Stalwart asks the user to "delete some", but
 *   the app has already removed every record it may, so only an
 *   administrator can help;
 * - a timeout, which is not a clean failure: the message may have gone out
 *   with only the answer lost, so point at Sent rather than invite a re-send
 *   (#702);
 * - a hold beyond the server's limit.
 */
export function sendFailureMessage(error: unknown, t: Translate): string {
  if (error instanceof SubmissionQuotaError) {
    return t(
      'email_composer.submission_quota',
      'The server has too many sent-message records for this account. Bulwark removed the ones it could; if this keeps happening, ask your administrator to raise the email submission limit.',
    );
  }
  if (error instanceof RequestTimeoutError) {
    return t(
      'email_composer.send_timeout_body',
      'The message may already have gone out. Check your Sent folder before sending it again.',
    );
  }
  if (error instanceof ScheduleTooLateError) {
    return t('email_composer.schedule_too_late_body', 'That is later than this server allows. Pick an earlier time.');
  }
  return error instanceof Error && error.message
    ? error.message
    : t('notifications.error_sending', 'Failed to send email');
}
