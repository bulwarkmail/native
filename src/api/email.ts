import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { Email, EmailAddress, JMAPMethodCall, Mailbox, Thread } from './types';
import { toWildcardQuery } from '../lib/search-utils';

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

// Archive one or more emails into the archive mailbox, optionally auto-sorting
// into year or year/month subfolders. Mirrors the webmail implementation in
// lib/jmap/client.ts so behavior stays in sync between platforms.
export async function archiveEmails(
  emails: Array<{ id: string; receivedAt: string }>,
  archiveMailboxId: string,
  mode: 'single' | 'year' | 'month',
  existingMailboxes: Mailbox[],
): Promise<void> {
  if (emails.length === 0) return;
  const accountId = jmapClient.accountId;

  if (mode === 'single') {
    const updates = Object.fromEntries(
      emails.map((e) => [e.id, { mailboxIds: { [archiveMailboxId]: true } }]),
    );
    await jmapClient.request([
      ['Email/set', { accountId, update: updates }, '0'],
    ]);
    return;
  }

  type Dest = { year: string; month?: string };
  const destFor = new Map<string, Dest>();
  for (const e of emails) {
    const d = new Date(e.receivedAt);
    const year = d.getFullYear().toString();
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    destFor.set(e.id, mode === 'year' ? { year } : { year, month });
  }

  // Resolve each destination folder to either an existing id or a creation-id reference ("#<cid>").
  const yearIdFor = new Map<string, string>();
  const monthIdFor = new Map<string, string>();
  const createEntries: Record<string, Record<string, unknown>> = {};

  const findExisting = (name: string, parentId: string) =>
    existingMailboxes.find(
      (m) => m.name === name && m.parentId === parentId,
    );

  for (const dest of destFor.values()) {
    if (!yearIdFor.has(dest.year)) {
      const existing = findExisting(dest.year, archiveMailboxId);
      if (existing) {
        yearIdFor.set(dest.year, existing.id);
      } else {
        const cid = `year-${dest.year}`;
        createEntries[cid] = { name: dest.year, parentId: archiveMailboxId };
        yearIdFor.set(dest.year, `#${cid}`);
      }
    }

    if (mode === 'month' && dest.month) {
      const monthKey = `${dest.year}/${dest.month}`;
      if (!monthIdFor.has(monthKey)) {
        const yearRef = yearIdFor.get(dest.year)!;
        const existingMonth = yearRef.startsWith('#')
          ? undefined
          : findExisting(dest.month, yearRef);
        if (existingMonth) {
          monthIdFor.set(monthKey, existingMonth.id);
        } else {
          const cid = `month-${dest.year}-${dest.month}`;
          createEntries[cid] = { name: dest.month, parentId: yearRef };
          monthIdFor.set(monthKey, `#${cid}`);
        }
      }
    }
  }

  const updates: Record<string, { mailboxIds: Record<string, true> }> = {};
  for (const [emailId, dest] of destFor.entries()) {
    const destId = mode === 'month' && dest.month
      ? monthIdFor.get(`${dest.year}/${dest.month}`)!
      : yearIdFor.get(dest.year)!;
    updates[emailId] = { mailboxIds: { [destId]: true } };
  }

  const methodCalls: JMAPMethodCall[] = [];
  const hasCreates = Object.keys(createEntries).length > 0;
  if (hasCreates) {
    methodCalls.push(['Mailbox/set', { accountId, create: createEntries }, '0']);
  }
  methodCalls.push(['Email/set', { accountId, update: updates }, String(methodCalls.length)]);

  const response = await jmapClient.request(methodCalls);

  if (hasCreates) {
    const mailboxResult = response.methodResponses?.[0]?.[1];
    const notCreated = mailboxResult?.notCreated as
      | Record<string, { type?: string; properties?: string[]; description?: string }>
      | undefined;
    const failures = notCreated ? Object.entries(notCreated) : [];
    if (failures.length > 0) {
      const [cid, err] = failures[0];
      const parts = [err.type || 'unknown'];
      if (err.properties?.length) parts.push(`properties=[${err.properties.join(', ')}]`);
      if (err.description) parts.push(err.description);
      throw new Error(`Failed to create archive folder '${cid}': ${parts.join(' – ')}`);
    }
  }

  const emailIdx = hasCreates ? 1 : 0;
  const emailResult = response.methodResponses?.[emailIdx]?.[1];
  const notUpdated = emailResult?.notUpdated as
    | Record<string, { type?: string; description?: string }>
    | undefined;
  const emailFailures = notUpdated ? Object.entries(notUpdated) : [];
  if (emailFailures.length > 0) {
    const [id, err] = emailFailures[0];
    throw new Error(
      `Failed to archive ${emailFailures.length} email(s), first: ${id} – ${err.type || 'unknown'}${err.description ? ` (${err.description})` : ''}`,
    );
  }
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
  const filter: Record<string, unknown> = { text: toWildcardQuery(query) };
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

// Cross-mailbox query with an arbitrary JMAP filter (used by contact activity
// to search "from OR to <addresses>" without picking a specific mailbox).
export async function queryEmailsByFilter(
  filter: Record<string, unknown>,
  limit = 5,
): Promise<string[]> {
  const accountId = jmapClient.accountId;
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

export interface OutgoingAttachment {
  blobId: string;
  type: string;
  name: string;
  size?: number;
  disposition?: 'attachment' | 'inline';
  cid?: string;
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
    attachments?: OutgoingAttachment[];
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

  const bodyValues: Record<string, { value: string }> = {};
  if (email.htmlBody) {
    emailCreate.htmlBody = [{ partId: 'html', type: 'text/html' }];
    bodyValues.html = { value: email.htmlBody };
  }
  if (email.textBody || !email.htmlBody) {
    emailCreate.textBody = [{ partId: 'text', type: 'text/plain' }];
    bodyValues.text = { value: email.textBody ?? '' };
  }
  emailCreate.bodyValues = bodyValues;

  if (email.attachments?.length) {
    emailCreate.attachments = email.attachments.map((a) => {
      const part: Record<string, unknown> = {
        blobId: a.blobId,
        type: a.type,
        name: a.name,
        disposition: a.disposition ?? 'attachment',
      };
      if (a.size != null) part.size = a.size;
      if (a.cid) part.cid = a.cid;
      return part;
    });
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
