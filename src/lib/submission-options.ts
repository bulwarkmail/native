// Per-message SMTP submission options (RFC 8621 §7.1 envelope parameters),
// ported from the webmail's lib/jmap/client.ts (submissionEnvelopeParameters,
// supportsSubmissionExtension).
//
// `requestDsn` asks the next hops for delivery status notifications (RFC 3461
// NOTIFY / RET); `requireTls` refuses relaying over an unencrypted hop (RFC
// 8689 REQUIRETLS). Both need the matching entry in the submission account's
// `submissionExtensions`, so the composer only offers what the server lists.

import { jmapClient } from '../api/jmap-client';
import { CAPABILITIES } from '../api/types';

export interface SubmissionSendOptions {
  requestDsn?: boolean;
  requireTls?: boolean;
}

/** The MAIL FROM / RCPT TO parameters the options and a hold translate to. */
export function submissionEnvelopeParameters(
  options: SubmissionSendOptions | undefined,
  holdForSeconds?: number,
): { mailFrom: Record<string, string | null>; rcptTo: Record<string, string | null> } {
  const mailFrom: Record<string, string | null> = {};
  const rcptTo: Record<string, string | null> = {};
  if (holdForSeconds && holdForSeconds > 0) mailFrom.HOLDFOR = String(Math.ceil(holdForSeconds));
  if (options?.requireTls) mailFrom.REQUIRETLS = null;
  if (options?.requestDsn) {
    // Return the headers only (not the full message) with the notification.
    mailFrom.RET = 'HDRS';
    rcptTo.NOTIFY = 'SUCCESS,FAILURE,DELAY';
  }
  return { mailFrom, rcptTo };
}

/**
 * Whether a `submissionExtensions` value lists `extension`. RFC 8621 makes it
 * a map of extension name to its arguments; an array of names is accepted
 * too, as the webmail does.
 */
export function hasSubmissionExtension(submissionExtensions: unknown, extension: string): boolean {
  const target = extension.toUpperCase();
  if (Array.isArray(submissionExtensions)) {
    return submissionExtensions.some((item) => typeof item === 'string' && item.toUpperCase() === target);
  }
  if (submissionExtensions && typeof submissionExtensions === 'object') {
    return Object.entries(submissionExtensions as Record<string, unknown>)
      .some(([key, value]) => key.toUpperCase() === target && value !== false && value != null);
  }
  return false;
}

/** Whether the account (default: the primary) can submit with `extension`, e.g. "DSN". */
export function supportsSubmissionExtension(extension: string, accountId?: string): boolean {
  const cap = jmapClient.getAccountCapability(CAPABILITIES.SUBMISSION, accountId) as
    | { submissionExtensions?: unknown }
    | undefined;
  return hasSubmissionExtension(cap?.submissionExtensions, extension);
}
