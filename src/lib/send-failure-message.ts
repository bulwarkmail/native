import { NetworkError, RequestTimeoutError } from '../api/jmap-client';
import { useNetworkStore } from '../stores/network-store';
import {
  NoLongerScheduledError, RecipientsRefusedError, ScheduleTooLateError, SubmissionQuotaError, formatRefusedRecipients,
  type RefusedRecipient,
} from '../api/jmap-result';
import type { MessageParams } from '../i18n/format';

type Translate = (key: string, fallback?: string, params?: MessageParams) => string;

/**
 * What to tell the user about a send (or reschedule) that failed (webmail
 * send-failure-message). Most errors carry the server's own description;
 * these are the ones it would misrepresent or leave unexplained:
 * - a full submission quota on Stalwart: it asks the user to "delete some",
 *   but the app has already removed every record it may, so only an
 *   administrator can help. Another server's overQuota may stand for any
 *   sending limit, so its own description goes with a generic sentence;
 * - a timeout, which is not a clean failure: the message may have gone out
 *   with only the answer lost, so point at Sent rather than invite a re-send
 *   (#702);
 * - a hold beyond the server's limit;
 * - "Send now" or a reschedule that found the message gone out, or no longer
 *   scheduled, while it made room for the replacement;
 * - every recipient refused: the server took the submission, so nothing
 *   else would say that the message went nowhere. Its reply per address
 *   goes with it.
 */
export function sendFailureMessage(error: unknown, t: Translate): string {
  if (error instanceof SubmissionQuotaError) {
    return error.countsRecords
      ? t(
        'email_composer.submission_quota',
        'The server has too many sent-message records for this account. Bulwark removed the ones it could; if this keeps happening, ask your administrator to raise the email submission limit.',
      )
      : t(
        'email_composer.submission_limit',
        'The server refused to send the message because a limit was reached: {reason}',
        { reason: error.description || error.type },
      );
  }
  if (error instanceof NoLongerScheduledError) {
    return error.sent
      ? t('scheduled.already_sent', 'This message was already sent.')
      : t('scheduled.no_longer_scheduled', 'This message is no longer scheduled.');
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
  if (error instanceof RecipientsRefusedError) {
    return t('email_composer.recipients_refused', 'Not sent: the server refused {recipients}.', {
      recipients: formatRefusedRecipients(error.recipients),
    });
  }
  return error instanceof Error && error.message
    ? error.message
    : t('notifications.error_sending', 'Failed to send email');
}

/**
 * sendFailureMessage for a message the user is writing (composer, quick
 * reply): a send that never reached the server because the device is
 * offline says so, and that the text is still there, instead of "Network
 * request failed" (webmail email-composer.tsx send_offline). The server is
 * unreachable when the transport failed (the client's NetworkError, or a
 * bare fetch TypeError) or the device reports no connection.
 */
export function composerSendFailureMessage(error: unknown, t: Translate): string {
  const offline = error instanceof NetworkError
    || error instanceof TypeError
    || !useNetworkStore.getState().online;
  if (offline && !(error instanceof RequestTimeoutError)) {
    return t(
      'email_composer.send_offline',
      'You seem to be offline. The message is still here, send it again once you are back online.',
    );
  }
  return sendFailureMessage(error, t);
}

/**
 * The title and message for a "Send now" or reschedule that failed: most
 * failures get `failTitle` and sendFailureMessage (webmail
 * rescheduleFailureToast). When the server refused recipients of the
 * replacement that the original had been taken for, the original was kept
 * for all of its recipients and still goes out at its old time,
 * `scheduledAt` (formatted) when known. That leads, and nothing says "not
 * sent": it would invite sending the message a second time.
 */
export function rescheduleFailureNotice(
  error: unknown,
  t: Translate,
  failTitle: string,
  scheduledAt?: string,
): { title: string; message: string } {
  if (!(error instanceof RecipientsRefusedError)) return { title: failTitle, message: sendFailureMessage(error, t) };
  return {
    title: scheduledAt
      ? t('email_viewer.still_scheduled_at', 'The message is still scheduled for {date}.', { date: scheduledAt })
      : t('email_viewer.still_scheduled', 'The message is still scheduled.'),
    message: t('email_viewer.reschedule_recipients_refused', 'Nothing was changed: the server refused {recipients}.', {
      recipients: formatRefusedRecipients(error.recipients),
    }),
  };
}

/**
 * The warning after a send that the server took for some recipients only:
 * nothing else, not even a bounce, would tell the user who never gets it.
 * The addresses and replies go in the message, which a toast shows on more
 * lines than its title.
 */
export function partlyRefusedWarning(recipients: RefusedRecipient[], t: Translate): { title: string; message: string } {
  return {
    title: t('email_composer.recipients_partly_refused_title', 'Not sent to everyone'),
    message: t(
      'email_composer.recipients_partly_refused',
      'The server refused {recipients}. The other recipients get the message.',
      { recipients: formatRefusedRecipients(recipients) },
    ),
  };
}
