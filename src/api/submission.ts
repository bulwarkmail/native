import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { EmailAddress } from './types';

export async function sendEmail(
  email: {
    from: EmailAddress[];
    to: EmailAddress[];
    cc?: EmailAddress[];
    bcc?: EmailAddress[];
    subject: string;
    htmlBody?: string;
    textBody?: string;
    attachments?: Array<{ blobId: string; type: string; name: string }>;
    inReplyTo?: string;
    references?: string;
  },
  identityId: string,
  sentMailboxId: string,
): Promise<void> {
  const accountId = jmapClient.accountId;
  const emailCreate: Record<string, unknown> = {
    from: email.from,
    to: email.to,
    cc: email.cc,
    bcc: email.bcc,
    subject: email.subject,
    mailboxIds: { [sentMailboxId]: true },
    keywords: { $seen: true },
  };

  if (email.htmlBody) {
    emailCreate.htmlBody = [{ partId: 'html', type: 'text/html' }];
    emailCreate.bodyValues = { html: { value: email.htmlBody } };
  } else {
    emailCreate.textBody = [{ partId: 'text', type: 'text/plain' }];
    emailCreate.bodyValues = { text: { value: email.textBody ?? '' } };
  }

  if (email.attachments?.length) {
    emailCreate.attachments = email.attachments.map((a) => ({
      blobId: a.blobId,
      type: a.type,
      name: a.name,
      disposition: 'attachment',
    }));
  }

  if (email.inReplyTo) {
    emailCreate['header:In-Reply-To:asText'] = email.inReplyTo;
    emailCreate['header:References:asText'] = email.references ?? email.inReplyTo;
  }

  await jmapClient.request(
    [
      ['Email/set', { accountId, create: { draft: emailCreate } }, '0'],
      ['EmailSubmission/set', {
        accountId,
        create: { 'sub-1': { emailId: '#draft', identityId } },
      }, '1'],
    ],
    [CAPABILITIES.CORE, CAPABILITIES.MAIL, CAPABILITIES.SUBMISSION],
  );
}
