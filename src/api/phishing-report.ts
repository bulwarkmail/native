/**
 * Sends one phishing report (src/lib/phishing-report.ts), without the
 * composer and with no copy in Sent: the report is made in Drafts and the
 * submission destroys it once the server took it (onSuccessDestroyEmail),
 * as the webmail's sendEmail({ noSentCopy }) and submitRawEmail do.
 */

import { jmapClient } from './jmap-client';
import { requireMethodResult } from './jmap-result';
import { CAPABILITIES } from './types';
import type { Email, Identity, Mailbox } from './types';
import { copyBlobs, getMailboxes } from './email';
import { getIdentities } from './identity';
import { uploadBytes } from './blob';
import { fetchBlobBytes } from '../lib/email-export';
import {
  arfReportBytes, buildArfParts, rawEncoding, reportedMessageName, reporterIdentity, reportSubject, reportText,
  type PhishingReportSetup,
} from '../lib/phishing-report';

const SUBMISSION_USING = [CAPABILITIES.CORE, CAPABILITIES.MAIL, CAPABILITIES.SUBMISSION];

export interface PhishingReportContext {
  setup: PhishingReportSetup;
  /** The account the message lives in (a shared one, for a group mailbox); the own account when absent. */
  sourceAccountId?: string;
  /** For the ARF User-Agent. */
  appVersion?: string;
  /** Test hooks. */
  identities?: Identity[];
  mailboxes?: Mailbox[];
}

/** Submits the report made by `create` (Email/set or Email/import) and checks the server took it. */
async function submit(createCall: [string, Record<string, unknown>, string], identity: Identity, to: string): Promise<void> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request([
    createCall,
    ['EmailSubmission/set', {
      accountId,
      create: {
        sub: {
          emailId: '#report',
          identityId: identity.id,
          envelope: { mailFrom: { email: identity.email }, rcptTo: [{ email: to }] },
        },
      },
      onSuccessDestroyEmail: ['#sub'],
    }, '1'],
  ], SUBMISSION_USING);
  const created = requireMethodResult(res, '0');
  const notCreated = (created.notCreated as Record<string, { type?: string; description?: string }> | undefined)?.report;
  if (notCreated) throw new Error(notCreated.description || notCreated.type || 'The report could not be made');
  const submission = res.methodResponses.find(([name, , callId]) => callId === '1' && name === 'EmailSubmission/set');
  const subBody = submission?.[1] as { created?: Record<string, unknown>; notCreated?: Record<string, { type?: string; description?: string }> } | undefined;
  if (!subBody?.created?.sub) {
    const err = subBody?.notCreated?.sub;
    // The made copy stays in Drafts otherwise.
    const reportId = (created.created as Record<string, { id?: string }> | undefined)?.report?.id;
    if (reportId) {
      await jmapClient.request([['Email/set', { accountId, destroy: [reportId] }, '0']]).catch(() => undefined);
    }
    throw new Error(err?.description || err?.type || 'The report was not sent');
  }
}

/**
 * Sends one report for `email` to the organisation's address. Throws when
 * nothing went out; resolves once the server took the submission.
 */
export async function sendPhishingReport(email: Email, ctx: PhishingReportContext): Promise<void> {
  if (!email.blobId) throw new Error('The message has no content to report');
  const identity = reporterIdentity(ctx.identities ?? await getIdentities(), jmapClient.username ?? '');
  if (!identity) throw new Error('No sender address to report from');
  const accountId = jmapClient.accountId;
  const sourceAccountId = ctx.sourceAccountId ?? accountId;
  const drafts = (ctx.mailboxes ?? await getMailboxes()).find((m) => m.role === 'drafts');
  if (!drafts) throw new Error('Could not find a Drafts folder on the server');
  const inDrafts = { [drafts.originalId ?? drafts.id]: true };
  const keywords = { $draft: true, $seen: true };
  const to = ctx.setup.address;

  if (ctx.setup.format === 'arf') {
    // The report is uploaded: one bigger than the server takes fails anyway,
    // so it isn't downloaded either.
    const maxUpload = jmapClient.getMaxSizeUpload();
    if (maxUpload > 0 && (email.size ?? 0) + 8192 > maxUpload) {
      throw new Error('The message is too big for an ARF report on this server');
    }
    const original = await fetchBlobBytes(email.blobId, 'message.eml', 'message/rfc822', sourceAccountId);
    const recipient = email.to?.find((a) => a.email?.toLowerCase() === identity.email.toLowerCase())?.email;
    const bytes = arfReportBytes(buildArfParts({
      email, reporter: identity, to, encoding: rawEncoding(original), recipient, appVersion: ctx.appVersion,
    }), original);
    if (maxUpload > 0 && bytes.byteLength > maxUpload) throw new Error('The message is too big for an ARF report on this server');
    const { blobId } = await uploadBytes(bytes, 'message/rfc822', accountId);
    await submit(['Email/import', { accountId, emails: { report: { blobId, mailboxIds: inDrafts, keywords } } }, '0'], identity, to);
    return;
  }

  // The original's own blob, attached by id; copied over when the message
  // lives in another account than the one the report goes out from.
  let blobId = email.blobId;
  if (sourceAccountId !== accountId) {
    const copy = (await copyBlobs(sourceAccountId, [blobId], accountId))[blobId];
    if (!copy) throw new Error('The message could not be copied to the account that sends the report');
    blobId = copy;
  }
  await submit(['Email/set', {
    accountId,
    create: {
      report: {
        mailboxIds: inDrafts,
        keywords,
        from: [{ ...(identity.name ? { name: identity.name } : {}), email: identity.email }],
        to: [{ email: to }],
        subject: reportSubject(email.subject),
        bodyValues: { text: { value: reportText(identity) } },
        textBody: [{ partId: 'text', type: 'text/plain' }],
        attachments: [{
          blobId,
          type: 'message/rfc822',
          name: reportedMessageName(email.subject),
          disposition: 'attachment',
        }],
      },
    },
  }, '0'], identity, to);
}
