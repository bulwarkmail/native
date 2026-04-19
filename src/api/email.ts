import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { Email, EmailAddress, Mailbox, Thread } from './types';

const EMAIL_LIST_PROPERTIES = [
  'id', 'threadId', 'mailboxIds', 'keywords', 'size',
  'receivedAt', 'from', 'to', 'cc', 'subject', 'preview', 'hasAttachment',
];

const EMAIL_FULL_PROPERTIES = [
  ...EMAIL_LIST_PROPERTIES,
  'bodyStructure', 'textBody', 'htmlBody', 'bodyValues',
  'attachments', 'blobId', 'bcc', 'replyTo', 'sentAt',
];

export async function getMailboxes(): Promise<Mailbox[]> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['Mailbox/get', { accountId }, '0']],
  );
  return res.methodResponses[0][1].list;
}

export async function queryEmails(
  mailboxId: string,
  options?: {
    position?: number;
    limit?: number;
    sort?: Array<{ property: string; isAscending: boolean }>;
    filter?: Record<string, unknown>;
  },
): Promise<{ ids: string[]; total: number }> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request([
    ['Email/query', {
      accountId,
      filter: { inMailbox: mailboxId, ...options?.filter },
      sort: options?.sort ?? [{ property: 'receivedAt', isAscending: false }],
      position: options?.position ?? 0,
      limit: options?.limit ?? 50,
      calculateTotal: true,
    }, '0'],
  ]);
  return {
    ids: res.methodResponses[0][1].ids,
    total: res.methodResponses[0][1].total,
  };
}

export async function getEmails(ids: string[]): Promise<Email[]> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request([
    ['Email/get', { accountId, ids, properties: EMAIL_LIST_PROPERTIES }, '0'],
  ]);
  return res.methodResponses[0][1].list;
}

export async function getFullEmail(id: string): Promise<Email> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request([
    ['Email/get', {
      accountId,
      ids: [id],
      properties: EMAIL_FULL_PROPERTIES,
      fetchHTMLBodyValues: true,
      fetchTextBodyValues: true,
      fetchAllBodyValues: true,
      maxBodyValueBytes: 512000,
    }, '0'],
  ]);
  const email = res.methodResponses[0][1].list[0];
  if (!email) throw new Error(`Email ${id} not found`);
  return email;
}

export async function getThread(threadId: string): Promise<Thread> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['Thread/get', { accountId, ids: [threadId] }, '0']],
  );
  return res.methodResponses[0][1].list[0];
}

export async function setEmailKeywords(
  emailId: string,
  keywords: Record<string, boolean>,
): Promise<void> {
  const accountId = jmapClient.accountId;
  await jmapClient.request([
    ['Email/set', { accountId, update: { [emailId]: { keywords } } }, '0'],
  ]);
}

export async function moveEmail(
  emailId: string,
  fromMailboxId: string,
  toMailboxId: string,
): Promise<void> {
  const accountId = jmapClient.accountId;
  await jmapClient.request([
    ['Email/set', {
      accountId,
      update: {
        [emailId]: {
          [`mailboxIds/${fromMailboxId}`]: null,
          [`mailboxIds/${toMailboxId}`]: true,
        },
      },
    }, '0'],
  ]);
}

export async function deleteEmail(
  emailId: string,
  trashMailboxId: string,
  currentMailboxId: string,
): Promise<void> {
  if (currentMailboxId === trashMailboxId) {
    const accountId = jmapClient.accountId;
    await jmapClient.request([
      ['Email/set', { accountId, destroy: [emailId] }, '0'],
    ]);
  } else {
    await moveEmail(emailId, currentMailboxId, trashMailboxId);
  }
}

export async function searchEmails(
  query: string,
  mailboxId?: string,
  limit = 30,
): Promise<string[]> {
  const accountId = jmapClient.accountId;
  const filter: Record<string, unknown> = { text: query };
  if (mailboxId) filter.inMailbox = mailboxId;

  const res = await jmapClient.request([
    ['Email/query', {
      accountId,
      filter,
      sort: [{ property: 'receivedAt', isAscending: false }],
      limit,
    }, '0'],
  ]);
  return res.methodResponses[0][1].ids;
}

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
