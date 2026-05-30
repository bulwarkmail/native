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

// Variant that also returns the JMAP `state` token so callers can later issue
// Mailbox/changes(sinceState=…) to fetch only what changed.
export async function getMailboxesWithState(): Promise<{ list: Mailbox[]; state: string }> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['Mailbox/get', { accountId }, '0']],
  );
  const body = res.methodResponses[0][1];
  return { list: body.list as Mailbox[], state: body.state as string };
}

export async function getMailboxesByIds(ids: string[]): Promise<{ list: Mailbox[]; state: string }> {
  if (ids.length === 0) return { list: [], state: '' };
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['Mailbox/get', { accountId, ids }, '0']],
  );
  const body = res.methodResponses[0][1];
  return { list: body.list as Mailbox[], state: body.state as string };
}

export interface MailboxChangesResult {
  oldState: string;
  newState: string;
  hasMoreChanges: boolean;
  created: string[];
  updated: string[];
  destroyed: string[];
}

// Returns null when the server can't compute the diff (typically
// `cannotCalculateChanges`); callers should fall back to a full Mailbox/get.
export async function getMailboxChanges(sinceState: string): Promise<MailboxChangesResult | null> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['Mailbox/changes', { accountId, sinceState }, '0']],
  );
  const [name, body] = res.methodResponses[0];
  if (name === 'error') return null;
  return {
    oldState: body.oldState as string,
    newState: body.newState as string,
    hasMoreChanges: Boolean(body.hasMoreChanges),
    created: (body.created as string[]) ?? [],
    updated: (body.updated as string[]) ?? [],
    destroyed: (body.destroyed as string[]) ?? [],
  };
}

export async function createMailbox(
  data: { name: string; parentId?: string | null },
): Promise<string> {
  const accountId = jmapClient.accountId;
  const cid = 'new-mailbox';
  const res = await jmapClient.request([
    ['Mailbox/set', {
      accountId,
      create: {
        [cid]: {
          name: data.name,
          parentId: data.parentId ?? null,
        },
      },
    }, '0'],
  ]);
  const result = res.methodResponses[0][1];
  if (result.created?.[cid]?.id) return result.created[cid].id as string;
  const failure = result.notCreated?.[cid] as
    | { type?: string; description?: string; properties?: string[] }
    | undefined;
  throw new Error(
    failure
      ? `${failure.type ?? 'create failed'}${failure.description ? `: ${failure.description}` : ''}`
      : 'Mailbox create returned no id',
  );
}

export async function updateMailbox(
  id: string,
  changes: { name?: string; parentId?: string | null },
): Promise<void> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request([
    ['Mailbox/set', { accountId, update: { [id]: changes } }, '0'],
  ]);
  const failure = res.methodResponses[0][1].notUpdated?.[id] as
    | { type?: string; description?: string }
    | undefined;
  if (failure) {
    throw new Error(
      `${failure.type ?? 'update failed'}${failure.description ? `: ${failure.description}` : ''}`,
    );
  }
}

export async function deleteMailbox(id: string): Promise<void> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request([
    ['Mailbox/set', { accountId, destroy: [id] }, '0'],
  ]);
  const failure = res.methodResponses[0][1].notDestroyed?.[id] as
    | { type?: string; description?: string }
    | undefined;
  if (failure) {
    throw new Error(
      `${failure.type ?? 'delete failed'}${failure.description ? `: ${failure.description}` : ''}`,
    );
  }
}

function buildMailboxQueryFilter(
  mailboxId: string,
  userFilter: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const inMailbox = { inMailbox: mailboxId };
  // JMAP filters are either a FilterCondition or a FilterOperator (operator +
  // conditions) — never both. Spreading a FilterOperator next to `inMailbox`
  // produces a hybrid object that servers reduce to the FilterCondition,
  // silently dropping the operator's conditions (e.g. the "unread" toggle).
  if (!userFilter || Object.keys(userFilter).length === 0) return inMailbox;
  if ('operator' in userFilter) {
    return { operator: 'AND', conditions: [inMailbox, userFilter] };
  }
  return { ...inMailbox, ...userFilter };
}

export async function queryEmails(
  mailboxId: string,
  options?: {
    position?: number;
    limit?: number;
    sort?: Array<{ property: string; isAscending: boolean }>;
    filter?: Record<string, unknown>;
  },
): Promise<{ ids: string[]; total: number; queryState?: string }> {
  const accountId = jmapClient.accountId;
  const filter = buildMailboxQueryFilter(mailboxId, options?.filter);
  const res = await jmapClient.request([
    ['Email/query', {
      accountId,
      filter,
      sort: options?.sort ?? [{ property: 'receivedAt', isAscending: false }],
      position: options?.position ?? 0,
      limit: options?.limit ?? 50,
      calculateTotal: true,
    }, '0'],
  ]);
  const body = res.methodResponses[0][1];
  return {
    ids: body.ids,
    total: body.total,
    queryState: body.queryState as string | undefined,
  };
}

export interface EmailQueryChangesResult {
  oldQueryState: string;
  newQueryState: string;
  total: number;
  removed: string[];
  added: Array<{ id: string; index: number }>;
}

// Run Email/queryChanges for the standard "by receivedAt desc, in this mailbox"
// query. Returns null when the server replies with `cannotCalculateChanges`
// (or any other error) — caller should fall back to a fresh Email/query.
export async function getEmailQueryChanges(
  mailboxId: string,
  sinceQueryState: string,
  options?: {
    sort?: Array<{ property: string; isAscending: boolean }>;
    filter?: Record<string, unknown>;
    upToId?: string;
    maxChanges?: number;
  },
): Promise<EmailQueryChangesResult | null> {
  const accountId = jmapClient.accountId;
  const filter = buildMailboxQueryFilter(mailboxId, options?.filter);
  const args: Record<string, unknown> = {
    accountId,
    filter,
    sort: options?.sort ?? [{ property: 'receivedAt', isAscending: false }],
    sinceQueryState,
    calculateTotal: true,
  };
  if (options?.upToId) args.upToId = options.upToId;
  if (options?.maxChanges) args.maxChanges = options.maxChanges;

  const res = await jmapClient.request([['Email/queryChanges', args, '0']]);
  const [name, body] = res.methodResponses[0];
  if (name === 'error') return null;
  return {
    oldQueryState: body.oldQueryState as string,
    newQueryState: body.newQueryState as string,
    total: (body.total as number) ?? 0,
    removed: (body.removed as string[]) ?? [],
    added: (body.added as Array<{ id: string; index: number }>) ?? [],
  };
}

export async function getEmails(ids: string[]): Promise<Email[]> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request([
    ['Email/get', { accountId, ids, properties: EMAIL_LIST_PROPERTIES }, '0'],
  ]);
  return res.methodResponses[0][1].list;
}

// Returns the Email/get response with the JMAP `state` token. Used by the
// store so we can later issue Email/changes(sinceState=…) for incremental
// updates instead of re-fetching the full list.
export async function getEmailsWithState(ids: string[]): Promise<{ list: Email[]; state: string }> {
  if (ids.length === 0) {
    // Email/get with an empty id list still returns a state token; useful for
    // priming the store after an empty mailbox query.
    const accountId = jmapClient.accountId;
    const res = await jmapClient.request([
      ['Email/get', { accountId, ids: [], properties: EMAIL_LIST_PROPERTIES }, '0'],
    ]);
    const body = res.methodResponses[0][1];
    return { list: [], state: body.state as string };
  }
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request([
    ['Email/get', { accountId, ids, properties: EMAIL_LIST_PROPERTIES }, '0'],
  ]);
  const body = res.methodResponses[0][1];
  return { list: body.list as Email[], state: body.state as string };
}

export interface EmailChangesResult {
  oldState: string;
  newState: string;
  hasMoreChanges: boolean;
  created: string[];
  updated: string[];
  destroyed: string[];
}

// Returns null when the server replies with `cannotCalculateChanges` or any
// other error response; caller should treat that as "rebuild from scratch".
export async function getEmailChanges(
  sinceState: string,
  maxChanges?: number,
): Promise<EmailChangesResult | null> {
  const accountId = jmapClient.accountId;
  const args: Record<string, unknown> = { accountId, sinceState };
  if (maxChanges) args.maxChanges = maxChanges;
  const res = await jmapClient.request([['Email/changes', args, '0']]);
  const [name, body] = res.methodResponses[0];
  if (name === 'error') return null;
  return {
    oldState: body.oldState as string,
    newState: body.newState as string,
    hasMoreChanges: Boolean(body.hasMoreChanges),
    created: (body.created as string[]) ?? [],
    updated: (body.updated as string[]) ?? [],
    destroyed: (body.destroyed as string[]) ?? [],
  };
}

export async function getFullEmail(id: string, accountIdOverride?: string): Promise<Email> {
  // `accountIdOverride` lets the unified inbox open a message that lives under
  // a group/shared account in the same session instead of the user's own.
  const accountId = accountIdOverride ?? jmapClient.accountId;
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

// Batch variant for offline sync. JMAP servers cap how many objects can be
// returned in a single Email/get; the caller should chunk to that ceiling
// (the client exposes maxObjectsInGet via getMaxObjectsInGet()).
export async function getFullEmails(ids: string[]): Promise<Email[]> {
  if (ids.length === 0) return [];
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request([
    ['Email/get', {
      accountId,
      ids,
      properties: EMAIL_FULL_PROPERTIES,
      fetchHTMLBodyValues: true,
      fetchTextBodyValues: true,
      fetchAllBodyValues: true,
      maxBodyValueBytes: 512000,
    }, '0'],
  ]);
  return res.methodResponses[0][1].list as Email[];
}

/**
 * Import an already-uploaded raw MIME message (a `.eml` blob) into a mailbox
 * via JMAP `Email/import`. Returns the new email id. Mirrors the webmail's
 * `importRawEmail` import step.
 */
export async function importEmailBlob(
  blobId: string,
  mailboxId: string,
  keywords: Record<string, boolean> = { $seen: true },
): Promise<string> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request([
    ['Email/import', {
      accountId,
      emails: {
        'import-0': { blobId, mailboxIds: { [mailboxId]: true }, keywords },
      },
    }, '0'],
  ]);
  const result = res.methodResponses[0][1];
  const notCreated = result?.notCreated?.['import-0'];
  if (notCreated) {
    throw new Error(notCreated.description || notCreated.type || 'Failed to import email');
  }
  const id = result?.created?.['import-0']?.id;
  if (!id) throw new Error('Email import succeeded but no id was returned');
  return id;
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
  accountIdOverride?: string,
): Promise<void> {
  const accountId = accountIdOverride ?? jmapClient.accountId;
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

// Move several emails from one mailbox to another in a single Email/set.
export async function moveEmails(
  ids: string[],
  fromMailboxId: string,
  toMailboxId: string,
): Promise<void> {
  if (ids.length === 0) return;
  const accountId = jmapClient.accountId;
  const update: Record<string, Record<string, unknown>> = {};
  for (const id of ids) {
    update[id] = {
      [`mailboxIds/${fromMailboxId}`]: null,
      [`mailboxIds/${toMailboxId}`]: true,
    };
  }
  await jmapClient.request([['Email/set', { accountId, update }, '0']]);
}

// Batch delete: destroy outright when already in trash, otherwise move to trash.
export async function deleteEmails(
  ids: string[],
  trashMailboxId: string,
  currentMailboxId: string,
): Promise<void> {
  if (ids.length === 0) return;
  if (currentMailboxId === trashMailboxId) {
    const accountId = jmapClient.accountId;
    await jmapClient.request([['Email/set', { accountId, destroy: ids }, '0']]);
  } else {
    await moveEmails(ids, currentMailboxId, trashMailboxId);
  }
}

// Apply keyword maps to several emails in one round-trip.
export async function setKeywordsForEmails(
  updates: Array<{ id: string; keywords: Record<string, boolean> }>,
): Promise<void> {
  if (updates.length === 0) return;
  const accountId = jmapClient.accountId;
  const update: Record<string, { keywords: Record<string, boolean> }> = {};
  for (const u of updates) update[u.id] = { keywords: u.keywords };
  await jmapClient.request([['Email/set', { accountId, update }, '0']]);
}

// Restore each email's mailboxIds to the snapshot supplied. Used by undo to
// reverse a move/archive/spam in one round-trip. JMAP "mailboxIds" replaces
// the entire map, so we don't need to compute a diff against the current state.
export async function restoreEmailMailboxes(
  items: Array<{ id: string; mailboxIds: Record<string, boolean> }>,
): Promise<void> {
  if (items.length === 0) return;
  const accountId = jmapClient.accountId;
  const update: Record<string, { mailboxIds: Record<string, true> }> = {};
  for (const item of items) {
    const onlyTrue: Record<string, true> = {};
    for (const [id, present] of Object.entries(item.mailboxIds)) {
      if (present) onlyTrue[id] = true;
    }
    update[item.id] = { mailboxIds: onlyTrue };
  }
  await jmapClient.request([
    ['Email/set', { accountId, update }, '0'],
  ]);
}

// Replace one email's full mailboxIds map. JMAP "mailboxIds" assigns the whole
// set, so this is idempotent — replaying it produces the same result no matter
// the current server state. The offline outbox relies on that to coalesce and
// safely retry move/archive/trash operations.
export async function setEmailMailboxes(
  emailId: string,
  mailboxIds: Record<string, boolean>,
): Promise<void> {
  await restoreEmailMailboxes([{ id: emailId, mailboxIds }]);
}

// Permanently destroy emails (no move-to-trash). Idempotent: destroying an
// already-gone id is a no-op on replay.
export async function destroyEmails(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const accountId = jmapClient.accountId;
  await jmapClient.request([['Email/set', { accountId, destroy: ids }, '0']]);
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

export interface SendEmailResult {
  /** True when the message was deferred (HOLDFOR / FUTURERELEASE). */
  scheduled: boolean;
  /** ISO timestamp the server resolved for a deferred send, when known. */
  sendAt?: string;
  emailId?: string;
  emailSubmissionId?: string;
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
  // When > 0 the message is held for this many seconds before delivery via the
  // SMTP HOLDFOR parameter (FUTURERELEASE). Used for both explicit "send later"
  // scheduling and the global send-delay (undo-send) window.
  holdForSeconds?: number,
): Promise<SendEmailResult> {
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

  const submissionCreate: Record<string, unknown> = { emailId: '#draft', identityId };
  // For a deferred send the envelope must be set explicitly so the HOLDFOR
  // mail-from parameter rides along (JMAP §7.3: an omitted envelope makes the
  // server derive mailFrom from the Identity, dropping our parameter).
  if (holdForSeconds && holdForSeconds > 0) {
    const rcptTo = [...email.to, ...(email.cc ?? []), ...(email.bcc ?? [])]
      .map((r) => r.email.trim())
      .filter(Boolean)
      .map((address) => ({ email: address }));
    submissionCreate.envelope = {
      mailFrom: {
        email: email.from[0]?.email,
        parameters: { HOLDFOR: String(Math.ceil(holdForSeconds)) },
      },
      rcptTo,
    };
  }

  const res = await jmapClient.request(
    [
      ['Email/set', { accountId, create: { draft: emailCreate } }, '0'],
      ['EmailSubmission/set', {
        accountId,
        create: { 'sub-1': submissionCreate },
      }, '1'],
    ],
    [CAPABILITIES.CORE, CAPABILITIES.MAIL, CAPABILITIES.SUBMISSION],
  );

  let emailId: string | undefined;
  let emailSubmissionId: string | undefined;
  let sendAt: string | undefined;
  for (const [methodName, result] of res.methodResponses) {
    if (methodName.endsWith('/error')) {
      throw new Error((result as { description?: string }).description ?? 'Send failed');
    }
    if (methodName === 'Email/set') {
      const notCreated = (result as { notCreated?: Record<string, { description?: string; type?: string }> }).notCreated?.draft;
      if (notCreated) throw new Error(notCreated.description ?? notCreated.type ?? 'Failed to create message');
      emailId = (result as { created?: Record<string, { id?: string }> }).created?.draft?.id;
    }
    if (methodName === 'EmailSubmission/set') {
      const notCreated = (result as { notCreated?: Record<string, { description?: string; type?: string }> }).notCreated?.['sub-1'];
      if (notCreated) throw new Error(notCreated.description ?? notCreated.type ?? 'Failed to submit message');
      const created = (result as { created?: Record<string, { id?: string; sendAt?: string }> }).created?.['sub-1'];
      emailSubmissionId = created?.id;
      sendAt = created?.sendAt;
    }
  }

  return {
    scheduled: !!(holdForSeconds && holdForSeconds > 0),
    sendAt,
    emailId,
    emailSubmissionId,
  };
}

export interface ScheduledEmail {
  emailSubmissionId: string;
  emailId: string;
  identityId: string;
  threadId?: string;
  sendAt: string;
  undoStatus?: string;
  subject?: string;
  to?: EmailAddress[];
  from?: EmailAddress[];
  preview?: string;
}

// List pending (not-yet-delivered, not cancelled) scheduled submissions whose
// send time is still in the future, joined with a light Email/get so the UI
// can show subject/recipients. Empty when the server lacks FUTURERELEASE.
export async function listScheduledEmails(): Promise<ScheduledEmail[]> {
  if (!jmapClient.hasDelayedSend()) return [];
  const accountId = jmapClient.accountId;
  const now = Date.now();

  const queryRes = await jmapClient.request(
    [['EmailSubmission/query', { accountId, limit: 200 }, '0']],
    [CAPABILITIES.CORE, CAPABILITIES.SUBMISSION],
  );
  const [queryName, queryBody] = queryRes.methodResponses[0];
  if (queryName.endsWith('/error')) return [];
  const ids = (queryBody.ids as string[]) ?? [];
  if (ids.length === 0) return [];

  const subRes = await jmapClient.request(
    [['EmailSubmission/get', {
      accountId,
      ids,
      properties: ['id', 'emailId', 'identityId', 'threadId', 'sendAt', 'undoStatus'],
    }, '0']],
    [CAPABILITIES.CORE, CAPABILITIES.SUBMISSION],
  );
  const submissions = ((subRes.methodResponses[0][1].list as Array<{
    id: string;
    emailId: string;
    identityId: string;
    threadId?: string;
    sendAt?: string;
    undoStatus?: string;
  }>) ?? []).filter((s) => {
    if (s.undoStatus !== 'pending' || !s.sendAt) return false;
    const t = new Date(s.sendAt).getTime();
    return Number.isFinite(t) && t > now;
  });
  if (submissions.length === 0) return [];

  const emailIds = Array.from(new Set(submissions.map((s) => s.emailId)));
  const emailRes = await jmapClient.request([
    ['Email/get', {
      accountId,
      ids: emailIds,
      properties: ['id', 'subject', 'to', 'from', 'preview', 'threadId'],
    }, '0'],
  ]);
  const emailById = new Map(
    ((emailRes.methodResponses[0][1].list as Email[]) ?? []).map((e) => [e.id, e]),
  );

  return submissions
    .map((s): ScheduledEmail | null => {
      const e = emailById.get(s.emailId);
      if (!s.sendAt) return null;
      return {
        emailSubmissionId: s.id,
        emailId: s.emailId,
        identityId: s.identityId,
        threadId: s.threadId ?? e?.threadId,
        sendAt: s.sendAt,
        undoStatus: s.undoStatus,
        subject: e?.subject,
        to: e?.to,
        from: e?.from,
        preview: e?.preview,
      };
    })
    .filter((s): s is ScheduledEmail => s !== null)
    .sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime());
}

// Cancel a pending scheduled send. The held message copy stays in Sent; only
// delivery is stopped (matches the webmail behaviour).
export async function cancelScheduledSend(emailSubmissionId: string): Promise<void> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['EmailSubmission/set', {
      accountId,
      update: { [emailSubmissionId]: { undoStatus: 'canceled' } },
    }, '0']],
    [CAPABILITIES.CORE, CAPABILITIES.SUBMISSION],
  );
  const failure = res.methodResponses[0][1].notUpdated?.[emailSubmissionId] as
    | { type?: string; description?: string }
    | undefined;
  if (failure) {
    throw new Error(failure.description ?? failure.type ?? 'Failed to cancel scheduled send');
  }
}
