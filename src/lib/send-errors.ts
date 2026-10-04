import { RequestTimeoutError } from '../api/jmap-client';
import {
  RecipientsRejectedError,
  SendUnconfirmedError,
  ScheduleTooLateError,
  formatRejectedRecipients,
} from '../api/jmap-result';

/** The alert a failed send shows, shared by the composer and quick reply. */
export function sendErrorAlert(
  e: unknown,
  t: (key: string, fallback?: string) => string,
): { title: string; message: string } {
  if (e instanceof RecipientsRejectedError) {
    return {
      title: t('email_composer.send_recipients_rejected', 'Not sent - the server rejected every recipient.'),
      message: formatRejectedRecipients(e.recipients),
    };
  }
  if (e instanceof RequestTimeoutError || e instanceof SendUnconfirmedError) {
    // The request may have reached the server; a blind retry would send the
    // message twice (#702).
    return {
      title: t('email_composer.send_timeout_title', 'No answer from the server'),
      message: t(
        'email_composer.send_timeout_body',
        'The message may already have gone out. Check your Sent folder before sending it again.',
      ),
    };
  }
  if (e instanceof ScheduleTooLateError) {
    // The server refused the hold; the pickers now only offer times within
    // the limit it named.
    return {
      title: t('email_composer.schedule_too_late_title', 'Too far ahead'),
      message: t('email_composer.schedule_too_late_body', 'That is later than this server allows. Pick an earlier time.'),
    };
  }
  return {
    title: t('email_composer.send_failed', 'Send failed'),
    message: e instanceof Error ? e.message : t('notifications.error_sending', 'Failed to send email'),
  };
}

/** Recipients the server accepted: a refused address is not someone to trust. */
export function withoutRefused<T extends { email: string }>(
  recipients: T[],
  refused: { email: string }[] | undefined,
): T[] {
  if (!refused?.length) return recipients;
  const gone = new Set(refused.map((r) => r.email.toLowerCase()));
  return recipients.filter((r) => !gone.has(r.email.toLowerCase()));
}
