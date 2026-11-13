// Sending a phishing report (#124): the JMAP side of the webmail's
// sendPhishingReport (lib/phishing-report.ts there). The pure parts are in
// lib/phishing-report and lib/phishing-report-arf.

import { jmapClient } from './jmap-client';
import { requireMethodResult } from './jmap-result';
import { copyBlobs, sendEmail, type SendEmailResult } from './email';
import { getIdentities } from './identity';
import { uploadBytes } from './blob';
import type { Email } from './types';
import {
  reportAttachmentName, reportSubject, reportText, reporterIdentity, type PhishingReportSetup,
} from '../lib/phishing-report';
import { assembleArfReport, buildArfParts, deliveryRecipient, rawEncoding } from '../lib/phishing-report-arf';
import { fetchBlobBytes } from '../lib/email-export';

// What a report needs of the original. List rows carry no blobId, and the
// ARF report reads the delivery headers.
const REPORT_PROPERTIES = ['id', 'blobId', 'size', 'subject', 'from', 'to', 'receivedAt', 'keywords', 'mailboxIds', 'headers'];

/** The messages as a report needs them, by id; a message gone from the server is left out. */
export async function getReportOriginals(ids: string[], accountId: string): Promise<Map<string, Email>> {
  const res = await jmapClient.request([
    ['Email/get', { accountId, ids, properties: REPORT_PROPERTIES }, '0'],
  ]);
  const body = requireMethodResult(res, '0', 'Email/get');
  return new Map(((body.list as Email[] | undefined) ?? []).map((email) => [email.id, email]));
}

export interface ReportContext {
  /** The JMAP account the message lives in (a shared one, for a group mailbox). */
  sourceAccountId: string;
  setup: PhishingReportSetup;
  /**
   * A folder of the login's own account the report is created in until it
   * is submitted (Drafts, else Sent); it is destroyed then.
   */
  stagingMailboxId: string;
  /** For the ARF report's User-Agent. */
  appVersion: string;
}

/**
 * Sends one report for `email` from the login's own account. Throws when
 * nothing went out; resolves once the server took the submission.
 */
export async function sendPhishingReport(email: Email, ctx: ReportContext): Promise<void> {
  const { setup } = ctx;
  if (!email.blobId) throw new Error('The message has no content to report');
  const accountId = jmapClient.accountId;
  const identity = reporterIdentity(await getIdentities(accountId), jmapClient.username ?? '');
  if (!identity) throw new Error('No sender address to report from');
  const from = [{ name: identity.name || undefined, email: identity.email }];
  const to = [{ email: setup.address }];
  const subject = reportSubject(email.subject);

  if (setup.format === 'arf') {
    // The report is uploaded: one bigger than the server takes fails anyway,
    // so it isn't downloaded either.
    const maxUpload = jmapClient.getMaxSizeUpload();
    if (maxUpload > 0 && email.size + 8192 > maxUpload) {
      throw new Error('The message is too big for an ARF report on this server');
    }
    const original = await fetchBlobBytes(email.blobId, 'message.eml', 'message/rfc822', ctx.sourceAccountId);
    const parts = buildArfParts({
      email,
      reporter: identity,
      to: setup.address,
      encoding: rawEncoding(original),
      appVersion: ctx.appVersion,
      recipient: deliveryRecipient(email, identity.email),
    });
    const report = assembleArfReport(parts, original);
    if (maxUpload > 0 && report.byteLength > maxUpload) {
      throw new Error('The message is too big for an ARF report on this server');
    }
    const upload = await uploadBytes(report, 'message/rfc822', accountId);
    warnLeftover(await sendEmail({ from, to, subject }, identity.id, ctx.stagingMailboxId, 0, {
      accountId,
      draftsMailboxId: ctx.stagingMailboxId,
      rawBlobId: upload.blobId,
      noSentCopy: true,
    }));
    return;
  }

  // The original's own blob, attached by id; copied over when the message
  // lives in another account than the one the report goes out from.
  const blobId = (await copyBlobs(ctx.sourceAccountId, [email.blobId], accountId))[email.blobId];
  warnLeftover(await sendEmail(
    {
      from,
      to,
      subject,
      textBody: reportText(identity),
      attachments: [{
        blobId,
        name: reportAttachmentName(email),
        type: 'message/rfc822',
        size: email.size,
        disposition: 'attachment',
      }],
    },
    identity.id,
    ctx.stagingMailboxId,
    0,
    { accountId, draftsMailboxId: ctx.stagingMailboxId, noSentCopy: true },
  ));
}

// The report went out; a copy the server didn't destroy stays in Drafts.
function warnLeftover(result: SendEmailResult): void {
  if (result.filingWarning) console.warn('[phishing-report] the report went out, but its copy was not removed:', result.filingWarning);
}
