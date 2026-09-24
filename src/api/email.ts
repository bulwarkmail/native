import { jmapClient } from './jmap-client';
import { assertSetResult, batched, parseHoldLimit, requireMethodResult, ScheduleTooLateError } from './jmap-result';
import { keywordPointer, mailboxPointer } from './patch-pointer';
import { CAPABILITIES } from './types';
import type { Email, EmailAddress, JMAPMethodCall, Mailbox, Thread } from './types';
import { toWildcardQuery } from '../lib/search-utils';
import { sanitizeDisplayName } from '../lib/rfc5322-mailbox';
import { generateMessageId, stripMessageIdBrackets } from '../lib/email-threading';
import { buildMdnMessage, type MdnOptions } from '../lib/mdn';
import { hasTruncatedDisplayedBody } from '../lib/email-body';

export const EMAIL_LIST_PROPERTIES = [
  'id', 'threadId', 'mailboxIds', 'keywords', 'size',
  'receivedAt', 'from', 'to', 'cc', 'subject', 'preview', 'hasAttachment',
];

// The viewer derives reply threading (In-Reply-To/References), Reply-To
// handling, SPF/DKIM/DMARC chips, List-Unsubscribe and read-receipt requests
// from these; without `messageId`/`headers` none of that can work.
export const EMAIL_FULL_PROPERTIES = [
  ...EMAIL_LIST_PROPERTIES,
  'bodyStructure', 'textBody', 'htmlBody', 'bodyValues',
  'attachments', 'blobId', 'bcc', 'replyTo', 'sentAt',
  'messageId', 'inReplyTo', 'references', 'headers',
];

const SUBMISSION_USING = [CAPABILITIES.CORE, CAPABILITIES.MAIL, CAPABILITIES.SUBMISSION];

// Prefix a shared account's folder ids so they can't collide with the user's
// own. Matches the webmail's `${accountId}:${mailboxId}` scheme.
function sharedMailboxId(accountId: string, rawId: string): string {
  return `${accountId}:${rawId}`;
}

/** Inverse of {@link sharedMailboxId}; a no-op for the user's own folders. */
export function unprefixMailboxId(id: string, accountId?: string): string {
  if (!accountId) return id;
  const prefix = `${accountId}:`;
  return id.startsWith(prefix) ? id.slice(prefix.length) : id;
}

// Stamp ownership onto a raw Mailbox/get result. Own folders keep their raw
// ids; a shared account's are prefixed and remember their `originalId` so
// server calls can still address them.
function tagMailbox(
  mailbox: Mailbox,
  accountId: string,
  accountName: string | undefined,
  isShared: boolean,
): Mailbox {
  if (!isShared) {
    return { ...mailbox, accountId, accountName, isShared: false };
  }
  return {
    ...mailbox,
    id: sharedMailboxId(accountId, mailbox.id),
    originalId: mailbox.id,
    parentId: mailbox.parentId ? sharedMailboxId(accountId, mailbox.parentId) : mailbox.parentId,
    accountId,
    accountName,
    isShared: true,
  };
}

function maxInGet(): number {
  return typeof jmapClient.getMaxObjectsInGet === 'function' ? jmapClient.getMaxObjectsInGet() : 500;
}

function maxInSet(): number {
  return typeof jmapClient.getMaxObjectsInSet === 'function' ? jmapClient.getMaxObjectsInSet() : 500;
}

/**
 * Run one `Email/set` per `maxObjectsInSet`-sized slice of `update` /
 * `destroy`, checking every slice for `notUpdated` / `notDestroyed`. Over-limit
 * requests fail whole (RFC 8620 §3.6.1), so a long multi-select or a big
 * offline replay must be split before it is sent.
 */
async function emailSetBatched(
  accountId: string,
  args: { update?: Record<string, Record<string, unknown>>; destroy?: string[] },
  what = 'email',
): Promise<{ updated: string[]; destroyed: string[] }> {
  const out = { updated: [] as string[], destroyed: [] as string[] };
  const size = maxInSet();
  const updateEntries = Object.entries(args.update ?? {});
  for (const slice of batched(updateEntries, size)) {
    const res = await jmapClient.request([
      ['Email/set', { accountId, update: Object.fromEntries(slice) }, '0'],
    ]);
    const body = requireMethodResult(res, '0', 'Email/set');
    assertSetResult(body, slice.map(([id]) => id), what);
    out.updated.push(...Object.keys(body.updated ?? {}));
  }
  for (const slice of batched(args.destroy ?? [], size)) {
    const res = await jmapClient.request([['Email/set', { accountId, destroy: slice }, '0']]);
    const body = requireMethodResult(res, '0', 'Email/set');
    assertSetResult(body, slice, what);
    out.destroyed.push(...((body.destroyed as string[] | undefined) ?? []));
  }
  return out;
}

export async function getMailboxes(accountId?: string): Promise<Mailbox[]> {
  return (await getMailboxesWithState(accountId)).list;
}

// Variant that also returns the JMAP `state` token so callers can later issue
// Mailbox/changes(sinceState=…) to fetch only what changed.
export async function getMailboxesWithState(
  accountIdOverride?: string,
): Promise<{ list: Mailbox[]; state: string }> {
  const accountId = accountIdOverride ?? jmapClient.accountId;
  const isShared = accountId !== jmapClient.accountId;
  const res = await jmapClient.request(
    [['Mailbox/get', { accountId }, '0']],
  );
  const body = requireMethodResult(res, '0', 'Mailbox/get');
  const list = ((body.list as Mailbox[]) ?? []).map((m) =>
    tagMailbox(m, accountId, jmapClient.getAccountName(accountId), isShared),
  );
  return { list, state: body.state as string };
}

/**
 * Every folder of every shared/group account in this session, ready to merge
 * into the sidebar next to the user's own. One request carrying a Mailbox/get
 * per account, chunked to the server's maxCallsInRequest. An account that
 * errors (revoked access, server hiccup) is skipped rather than sinking the
 * whole list.
 */
export async function getSharedMailboxes(): Promise<Mailbox[]> {
  const accounts = jmapClient.getSharedMailAccounts();
  if (accounts.length === 0) return [];

  const perRequest = Math.max(1, jmapClient.getMaxCallsInRequest());
  const out: Mailbox[] = [];
  for (let i = 0; i < accounts.length; i += perRequest) {
    const chunk = accounts.slice(i, i + perRequest);
    const res = await jmapClient.request(
      chunk.map((acc, idx): JMAPMethodCall => [
        'Mailbox/get',
        { accountId: acc.id },
        String(idx),
      ]),
    );
    for (const [name, body, callId] of res.methodResponses) {
      if (name !== 'Mailbox/get') continue;
      const acc = chunk[Number(callId)];
      if (!acc) continue;
      for (const m of (body.list as Mailbox[]) ?? []) {
        out.push(tagMailbox(m, acc.id, acc.name, true));
      }
    }
  }
  return out;
}

export async function getMailboxesByIds(
  ids: string[],
  accountIdOverride?: string,
): Promise<{ list: Mailbox[]; state: string }> {
  if (ids.length === 0) return { list: [], state: '' };
  const accountId = accountIdOverride ?? jmapClient.accountId;
  const isShared = accountId !== jmapClient.accountId;
  const list: Mailbox[] = [];
  let state = '';
  for (const slice of batched(ids, maxInGet())) {
    const res = await jmapClient.request(
      [['Mailbox/get', { accountId, ids: slice }, '0']],
    );
    const body = requireMethodResult(res, '0', 'Mailbox/get');
    for (const m of (body.list as Mailbox[]) ?? []) {
      list.push(tagMailbox(m, accountId, jmapClient.getAccountName(accountId), isShared));
    }
    state = body.state as string;
  }
  return { list, state };
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
export async function getMailboxChanges(
  sinceState: string,
  accountIdOverride?: string,
): Promise<MailboxChangesResult | null> {
  const accountId = accountIdOverride ?? jmapClient.accountId;
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
  data: { name: string; parentId?: string | null; role?: string | null },
  accountIdOverride?: string,
): Promise<string> {
  const accountId = accountIdOverride ?? jmapClient.accountId;
  const cid = 'new-mailbox';
  const create: Record<string, unknown> = {
    name: data.name,
    parentId: data.parentId ?? null,
  };
  if (data.role !== undefined) create.role = data.role;
  const res = await jmapClient.request([
    ['Mailbox/set', { accountId, create: { [cid]: create } }, '0'],
  ]);
  const result = requireMethodResult(res, '0', 'Mailbox/set');
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
  changes: { name?: string; parentId?: string | null; role?: string | null; sortOrder?: number },
  accountIdOverride?: string,
): Promise<void> {
  const accountId = accountIdOverride ?? jmapClient.accountId;
  const res = await jmapClient.request([
    ['Mailbox/set', { accountId, update: { [id]: changes } }, '0'],
  ]);
  const body = requireMethodResult(res, '0', 'Mailbox/set');
  const failure = body.notUpdated?.[id] as
    | { type?: string; description?: string }
    | undefined;
  if (failure) {
    throw new Error(
      `${failure.type ?? 'update failed'}${failure.description ? `: ${failure.description}` : ''}`,
    );
  }
}

export async function deleteMailbox(
  id: string,
  accountIdOverride?: string,
  opts?: { onDestroyRemoveEmails?: boolean },
): Promise<void> {
  const accountId = accountIdOverride ?? jmapClient.accountId;
  const args: Record<string, unknown> = { accountId, destroy: [id] };
  if (opts?.onDestroyRemoveEmails) args.onDestroyRemoveEmails = true;
  const res = await jmapClient.request([['Mailbox/set', args, '0']]);
  const body = requireMethodResult(res, '0', 'Mailbox/set');
  const failure = body.notDestroyed?.[id] as
    | { type?: string; description?: string }
    | undefined;
  if (failure) {
    throw new Error(
      `${failure.type ?? 'delete failed'}${failure.description ? `: ${failure.description}` : ''}`,
    );
  }
}

/**
 * Destroy every message in a folder (Empty Trash / Empty Junk), in batches of
 * at most `maxObjectsInSet`. Never gates on `Email/query.total`: it is only
 * guaranteed with `calculateTotal`, and Stalwart omits it otherwise, which
 * used to stop after the first batch (#711). Returns the number destroyed.
 */
export async function emptyMailbox(mailboxId: string, accountIdOverride?: string): Promise<number> {
  const accountId = accountIdOverride ?? jmapClient.accountId;
  const batchSize = Math.min(500, maxInSet());
  let totalDestroyed = 0;
  for (;;) {
    const res = await jmapClient.request([
      ['Email/query', { accountId, filter: { inMailbox: mailboxId }, limit: batchSize }, '0'],
      ['Email/set', { accountId, '#destroy': { resultOf: '0', name: 'Email/query', path: '/ids' } }, '1'],
    ]);
    const query = requireMethodResult(res, '0', 'Email/query');
    const set = requireMethodResult(res, '1', 'Email/set');
    const found: string[] = (query.ids as string[]) ?? [];
    const destroyed = ((set.destroyed as string[] | undefined) ?? []).length;
    totalDestroyed += destroyed;
    // Nothing left, or the server refused everything in this batch (missing
    // permission, immutable mail) - stop instead of looping on the same ids.
    if (found.length === 0 || destroyed === 0) break;
    if (found.length < batchSize) break;
  }
  return totalDestroyed;
}

/** Set `$seen` on every unread message in a folder. Returns the count. */
export async function markMailboxAsRead(mailboxId: string, accountIdOverride?: string): Promise<number> {
  const accountId = accountIdOverride ?? jmapClient.accountId;
  const pageSize = Math.min(500, maxInSet());
  let total = 0;
  for (;;) {
    const res = await jmapClient.request([
      ['Email/query', {
        accountId,
        filter: { operator: 'AND', conditions: [{ inMailbox: mailboxId }, { notKeyword: '$seen' }] },
        limit: pageSize,
      }, '0'],
    ]);
    const ids = (requireMethodResult(res, '0', 'Email/query').ids as string[]) ?? [];
    if (ids.length === 0) break;
    const update = Object.fromEntries(ids.map((id) => [id, { [keywordPointer('$seen')]: true }]));
    const setRes = await jmapClient.request([['Email/set', { accountId, update }, '0']]);
    const body = requireMethodResult(setRes, '0', 'Email/set');
    const marked = Object.keys(body.updated ?? {}).length;
    total += marked;
    if (marked === 0 || ids.length < pageSize) break;
  }
  return total;
}

function buildMailboxQueryFilter(
  mailboxId: string | undefined,
  userFilter: Record<string, unknown> | undefined,
): Record<string, unknown> {
  // An undefined mailbox means "search every folder" (#788).
  const inMailbox = mailboxId ? { inMailbox: mailboxId } : {};
  // JMAP filters are either a FilterCondition or a FilterOperator (operator +
  // conditions) — never both. Spreading a FilterOperator next to `inMailbox`
  // produces a hybrid object that servers reduce to the FilterCondition,
  // silently dropping the operator's conditions (e.g. the "unread" toggle).
  if (!userFilter || Object.keys(userFilter).length === 0) return inMailbox;
  if ('operator' in userFilter) {
    return mailboxId ? { operator: 'AND', conditions: [inMailbox, userFilter] } : userFilter;
  }
  return { ...inMailbox, ...userFilter };
}

export async function queryEmails(
  mailboxId: string | undefined,
  options?: {
    position?: number;
    limit?: number;
    sort?: Array<{ property: string; isAscending: boolean; keyword?: string }>;
    filter?: Record<string, unknown>;
    /** Owning JMAP account when the mailbox belongs to a shared account. */
    accountId?: string;
    collapseThreads?: boolean;
  },
): Promise<{ ids: string[]; total: number; queryState?: string }> {
  const accountId = options?.accountId ?? jmapClient.accountId;
  const filter = buildMailboxQueryFilter(mailboxId, options?.filter);
  const args: Record<string, unknown> = {
    accountId,
    filter,
    sort: options?.sort ?? [{ property: 'receivedAt', isAscending: false }],
    position: options?.position ?? 0,
    limit: options?.limit ?? 50,
    calculateTotal: true,
  };
  if (options?.collapseThreads) args.collapseThreads = true;
  const res = await jmapClient.request([['Email/query', args, '0']]);
  const body = requireMethodResult(res, '0', 'Email/query');
  return {
    ids: (body.ids as string[]) ?? [],
    total: (body.total as number) ?? 0,
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
  mailboxId: string | undefined,
  sinceQueryState: string,
  options?: {
    sort?: Array<{ property: string; isAscending: boolean; keyword?: string }>;
    filter?: Record<string, unknown>;
    upToId?: string;
    maxChanges?: number;
    /** Owning JMAP account when the mailbox belongs to a shared account. */
    accountId?: string;
  },
): Promise<EmailQueryChangesResult | null> {
  const accountId = options?.accountId ?? jmapClient.accountId;
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

export async function getEmails(ids: string[], accountIdOverride?: string): Promise<Email[]> {
  return (await getEmailsWithState(ids, accountIdOverride)).list;
}

// Returns the Email/get response with the JMAP `state` token. Used by the
// store so we can later issue Email/changes(sinceState=…) for incremental
// updates instead of re-fetching the full list. Splits the id list to the
// server's maxObjectsInGet.
export async function getEmailsWithState(
  ids: string[],
  accountIdOverride?: string,
): Promise<{ list: Email[]; state: string }> {
  const accountId = accountIdOverride ?? jmapClient.accountId;
  if (ids.length === 0) {
    // Email/get with an empty id list still returns a state token; useful for
    // priming the store after an empty mailbox query.
    const res = await jmapClient.request([
      ['Email/get', { accountId, ids: [], properties: EMAIL_LIST_PROPERTIES }, '0'],
    ]);
    const body = requireMethodResult(res, '0', 'Email/get');
    return { list: [], state: body.state as string };
  }
  const list: Email[] = [];
  let state = '';
  for (const slice of batched(ids, maxInGet())) {
    const res = await jmapClient.request([
      ['Email/get', { accountId, ids: slice, properties: EMAIL_LIST_PROPERTIES }, '0'],
    ]);
    const body = requireMethodResult(res, '0', 'Email/get');
    list.push(...((body.list as Email[]) ?? []));
    state = body.state as string;
  }
  return { list, state };
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
  accountIdOverride?: string,
): Promise<EmailChangesResult | null> {
  const accountId = accountIdOverride ?? jmapClient.accountId;
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

const FULL_BODY_ARGS = {
  properties: EMAIL_FULL_PROPERTIES,
  fetchHTMLBodyValues: true,
  fetchTextBodyValues: true,
  fetchAllBodyValues: true,
  maxBodyValueBytes: 512000,
};

// A displayed part over that cap comes back cut off, often mid-tag, so a
// large HTML report rendered as a heading and a stub (#884). Those parts are
// fetched once more with this far larger, still bounded cap.
const TRUNCATED_BODY_REFETCH_MAX_BYTES = 8_000_000;

/**
 * Refetch, in place and batched across the list, the HTML and text body
 * values of messages whose displayed part came back truncated. Other parts'
 * values are kept. A failure leaves the truncated values in place (the viewer
 * says the message isn't shown in full) instead of failing the open.
 */
async function refetchTruncatedBodyValues(emails: Email[], accountId: string): Promise<void> {
  const truncated = emails.filter(hasTruncatedDisplayedBody);
  if (truncated.length === 0) return;
  try {
    const refetched = new Map<string, Email['bodyValues']>();
    for (const slice of batched(truncated.map((e) => e.id), maxInGet())) {
      const res = await jmapClient.request([
        ['Email/get', {
          accountId,
          ids: slice,
          properties: ['id', 'bodyValues'],
          fetchHTMLBodyValues: true,
          fetchTextBodyValues: true,
          maxBodyValueBytes: TRUNCATED_BODY_REFETCH_MAX_BYTES,
        }, '0'],
      ]);
      for (const e of (requireMethodResult(res, '0', 'Email/get').list as Email[] | undefined) ?? []) {
        refetched.set(e.id, e.bodyValues);
      }
    }
    for (const email of truncated) {
      const values = refetched.get(email.id);
      if (values) email.bodyValues = { ...email.bodyValues, ...values };
    }
  } catch (err) {
    console.warn('[email] refetching truncated bodies failed', err);
  }
}

export async function getFullEmail(id: string, accountIdOverride?: string): Promise<Email> {
  // `accountIdOverride` lets the unified inbox open a message that lives under
  // a group/shared account in the same session instead of the user's own.
  const accountId = accountIdOverride ?? jmapClient.accountId;
  const res = await jmapClient.request([
    ['Email/get', { accountId, ids: [id], ...FULL_BODY_ARGS }, '0'],
  ]);
  const body = requireMethodResult(res, '0', 'Email/get');
  const email = (body.list as Email[] | undefined)?.[0];
  if (!email) throw new Error(`Email ${id} not found`);
  await refetchTruncatedBodyValues([email], accountId);
  return email;
}

// Batch variant for offline sync and the thread view. Splits to the server's
// maxObjectsInGet ceiling itself.
export async function getFullEmails(ids: string[], accountIdOverride?: string): Promise<Email[]> {
  if (ids.length === 0) return [];
  const accountId = accountIdOverride ?? jmapClient.accountId;
  const out: Email[] = [];
  for (const slice of batched(ids, maxInGet())) {
    const res = await jmapClient.request([
      ['Email/get', { accountId, ids: slice, ...FULL_BODY_ARGS }, '0'],
    ]);
    out.push(...((requireMethodResult(res, '0', 'Email/get').list as Email[]) ?? []));
  }
  await refetchTruncatedBodyValues(out, accountId);
  return out;
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
  accountIdOverride?: string,
): Promise<string> {
  const accountId = accountIdOverride ?? jmapClient.accountId;
  const res = await jmapClient.request([
    ['Email/import', {
      accountId,
      emails: {
        'import-0': { blobId, mailboxIds: { [mailboxId]: true }, keywords },
      },
    }, '0'],
  ]);
  const result = requireMethodResult(res, '0', 'Email/import');
  const notCreated = result?.notCreated?.['import-0'];
  if (notCreated) {
    throw new Error(notCreated.description || notCreated.type || 'Failed to import email');
  }
  const id = result?.created?.['import-0']?.id;
  if (!id) throw new Error('Email import succeeded but no id was returned');
  return id;
}

export async function getThread(threadId: string, accountIdOverride?: string): Promise<Thread> {
  const accountId = accountIdOverride ?? jmapClient.accountId;
  const res = await jmapClient.request(
    [['Thread/get', { accountId, ids: [threadId] }, '0']],
  );
  const thread = (requireMethodResult(res, '0', 'Thread/get').list as Thread[] | undefined)?.[0];
  if (!thread) throw new Error(`Thread ${threadId} not found`);
  return thread;
}

/** Thread/get for many ids at once (chunked). Missing threads are skipped. */
export async function getThreads(threadIds: string[], accountIdOverride?: string): Promise<Thread[]> {
  if (threadIds.length === 0) return [];
  const accountId = accountIdOverride ?? jmapClient.accountId;
  const out: Thread[] = [];
  for (const slice of batched(Array.from(new Set(threadIds)), maxInGet())) {
    const res = await jmapClient.request([['Thread/get', { accountId, ids: slice }, '0']]);
    out.push(...((requireMethodResult(res, '0', 'Thread/get').list as Thread[]) ?? []));
  }
  return out;
}

/**
 * Every message of a thread with full bodies, oldest first, via a
 * back-referenced Thread/get → Email/get. Powers the conversation view.
 */
export async function getThreadEmails(threadId: string, accountIdOverride?: string): Promise<Email[]> {
  const accountId = accountIdOverride ?? jmapClient.accountId;
  const res = await jmapClient.request([
    ['Thread/get', { accountId, ids: [threadId] }, '0'],
    ['Email/get', {
      accountId,
      '#ids': { resultOf: '0', name: 'Thread/get', path: '/list/*/emailIds' },
      ...FULL_BODY_ARGS,
    }, '1'],
  ]);
  const thread = (requireMethodResult(res, '0', 'Thread/get').list as Thread[] | undefined)?.[0];
  const emails = (requireMethodResult(res, '1', 'Email/get').list as Email[]) ?? [];
  await refetchTruncatedBodyValues(emails, accountId);
  if (!thread) return emails;
  const order = new Map(thread.emailIds.map((id, i) => [id, i]));
  return emails.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

// One `keywords/<name>` pointer per changed keyword. Never send the whole
// `keywords` map on update: the server replaces it, erasing every keyword the
// local copy didn't have (a star or tag set elsewhere, or all of them on a
// message that was never loaded).
function keywordPointers(patch: Record<string, boolean | null>): Record<string, unknown> {
  const pointers: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(patch)) {
    pointers[keywordPointer(keyword)] = value === false ? null : value;
  }
  return pointers;
}

/** Patch individual keywords (`{ $seen: true, $junk: null }`) on many messages. */
export async function patchKeywordsForEmails(
  ids: string[],
  patch: Record<string, boolean | null>,
  accountIdOverride?: string,
): Promise<void> {
  if (ids.length === 0) return;
  const accountId = accountIdOverride ?? jmapClient.accountId;
  const pointerPatch = keywordPointers(patch);
  const update: Record<string, Record<string, unknown>> = {};
  for (const id of ids) update[id] = { ...pointerPatch };
  await emailSetBatched(accountId, { update });
}

export async function moveEmail(
  emailId: string,
  fromMailboxId: string,
  toMailboxId: string,
  accountIdOverride?: string,
): Promise<void> {
  await moveEmails([emailId], fromMailboxId, toMailboxId, accountIdOverride);
}

// Move several emails from one mailbox to another. Pointer keys are JSON
// Pointer escaped so a mailbox id containing `/` or `~` cannot break the patch.
export async function moveEmails(
  ids: string[],
  fromMailboxId: string,
  toMailboxId: string,
  accountIdOverride?: string,
): Promise<void> {
  if (ids.length === 0) return;
  const accountId = accountIdOverride ?? jmapClient.accountId;
  const update: Record<string, Record<string, unknown>> = {};
  for (const id of ids) {
    update[id] = {
      [mailboxPointer(fromMailboxId)]: null,
      [mailboxPointer(toMailboxId)]: true,
    };
  }
  await emailSetBatched(accountId, { update });
}

/**
 * File messages into Junk and flip `$junk`/`$notjunk` so the server's
 * classifier and other clients learn (#850). Optionally also marks them read
 * (the "trash-and-read" delete action).
 */
export async function markAsSpam(
  ids: string[],
  junkMailboxId: string,
  accountIdOverride?: string,
  opts?: { markRead?: boolean },
): Promise<void> {
  if (ids.length === 0) return;
  const accountId = accountIdOverride ?? jmapClient.accountId;
  const update: Record<string, Record<string, unknown>> = {};
  for (const id of ids) {
    update[id] = {
      mailboxIds: { [junkMailboxId]: true },
      [keywordPointer('$junk')]: true,
      [keywordPointer('$notjunk')]: null,
      ...(opts?.markRead ? { [keywordPointer('$seen')]: true } : {}),
    };
  }
  await emailSetBatched(accountId, { update });
}

/** Inverse of {@link markAsSpam}: restore into `targetMailboxId` with `$notjunk`. */
export async function undoSpam(
  ids: string[],
  targetMailboxId: string,
  accountIdOverride?: string,
): Promise<void> {
  if (ids.length === 0) return;
  const accountId = accountIdOverride ?? jmapClient.accountId;
  const update: Record<string, Record<string, unknown>> = {};
  for (const id of ids) {
    update[id] = {
      mailboxIds: { [targetMailboxId]: true },
      [keywordPointer('$junk')]: null,
      [keywordPointer('$notjunk')]: true,
    };
  }
  await emailSetBatched(accountId, { update });
}

// Batch delete: destroy outright when already in trash, otherwise move to trash.
export async function deleteEmails(
  ids: string[],
  trashMailboxId: string,
  currentMailboxId: string,
  accountIdOverride?: string,
): Promise<void> {
  if (ids.length === 0) return;
  if (currentMailboxId === trashMailboxId) {
    await destroyEmails(ids, accountIdOverride);
  } else {
    await moveEmails(ids, currentMailboxId, trashMailboxId, accountIdOverride);
  }
}

// Apply a different keyword patch to each of several emails in one
// round-trip (chunked). Undo uses it to put back each message's own keywords.
export async function patchKeywordsPerEmail(
  updates: Array<{ id: string; patch: Record<string, boolean | null> }>,
  accountIdOverride?: string,
): Promise<void> {
  if (updates.length === 0) return;
  const accountId = accountIdOverride ?? jmapClient.accountId;
  const update: Record<string, Record<string, unknown>> = {};
  for (const u of updates) update[u.id] = keywordPointers(u.patch);
  await emailSetBatched(accountId, { update });
}

// Restore each email's mailboxIds to the snapshot supplied. Used by undo to
// reverse a move/archive/spam in one round-trip. JMAP "mailboxIds" replaces
// the entire map, so we don't need to compute a diff against the current state.
export async function restoreEmailMailboxes(
  items: Array<{ id: string; mailboxIds: Record<string, boolean> }>,
  accountIdOverride?: string,
): Promise<void> {
  if (items.length === 0) return;
  const accountId = accountIdOverride ?? jmapClient.accountId;
  const update: Record<string, { mailboxIds: Record<string, true> }> = {};
  for (const item of items) {
    const onlyTrue: Record<string, true> = {};
    for (const [id, present] of Object.entries(item.mailboxIds)) {
      if (present) onlyTrue[id] = true;
    }
    update[item.id] = { mailboxIds: onlyTrue };
  }
  await emailSetBatched(accountId, { update });
}

// Replace one email's full mailboxIds map. JMAP "mailboxIds" assigns the whole
// set, so this is idempotent — replaying it produces the same result no matter
// the current server state. The offline outbox relies on that to coalesce and
// safely retry move/archive/trash operations.
export async function setEmailMailboxes(
  emailId: string,
  mailboxIds: Record<string, boolean>,
  accountIdOverride?: string,
): Promise<void> {
  await restoreEmailMailboxes([{ id: emailId, mailboxIds }], accountIdOverride);
}

// Permanently destroy emails (no move-to-trash). Idempotent: destroying an
// already-gone id is a no-op on replay (a `notFound` is tolerated).
export async function destroyEmails(ids: string[], accountIdOverride?: string): Promise<void> {
  if (ids.length === 0) return;
  const accountId = accountIdOverride ?? jmapClient.accountId;
  for (const slice of batched(ids, maxInSet())) {
    const res = await jmapClient.request([['Email/set', { accountId, destroy: slice }, '0']]);
    const body = requireMethodResult(res, '0', 'Email/set');
    const notDestroyed = (body.notDestroyed ?? {}) as Record<string, { type?: string; description?: string }>;
    const real = Object.entries(notDestroyed).filter(([, err]) => err?.type !== 'notFound');
    if (real.length > 0) {
      const [id, err] = real[0];
      throw new Error(
        `Failed to delete ${real.length} email(s), first: ${id} – ${err.type || 'unknown'}${err.description ? ` (${err.description})` : ''}`,
      );
    }
  }
}

// Archive one or more emails into the archive mailbox, optionally auto-sorting
// into year or year/month subfolders. Mirrors the webmail implementation in
// lib/jmap/client.ts so behavior stays in sync between platforms.
export async function archiveEmails(
  emails: Array<{ id: string; receivedAt: string }>,
  archiveMailboxId: string,
  mode: 'single' | 'year' | 'month',
  existingMailboxes: Mailbox[],
  accountIdOverride?: string,
): Promise<void> {
  if (emails.length === 0) return;
  const accountId = accountIdOverride ?? jmapClient.accountId;

  if (mode === 'single') {
    const updates = Object.fromEntries(
      emails.map((e) => [e.id, { mailboxIds: { [archiveMailboxId]: true } }]),
    );
    await emailSetBatched(accountId, { update: updates });
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

  // Creation ids are scoped to the request that introduced them (RFC 8620
  // §3.3), so "#<cid>" only resolves in the request carrying the Mailbox/set:
  // the folders are created alongside the first batch of messages, and the
  // ids they were assigned are substituted into every later batch.
  const updateBatches = batched(Object.entries(updates), maxInSet());
  const hasCreates = Object.keys(createEntries).length > 0;
  let createdIdFor: Record<string, string> = {};

  for (let i = 0; i < updateBatches.length; i++) {
    const batch: Array<[string, { mailboxIds: Record<string, true> }]> = i === 0
      ? updateBatches[i]
      : updateBatches[i].map(([emailId, patch]) => {
        const [destId] = Object.keys(patch.mailboxIds);
        const resolved = createdIdFor[destId];
        return [emailId, resolved ? { mailboxIds: { [resolved]: true } as Record<string, true> } : patch];
      });

    const methodCalls: JMAPMethodCall[] = [];
    const withCreates = hasCreates && i === 0;
    if (withCreates) {
      methodCalls.push(['Mailbox/set', { accountId, create: createEntries }, '0']);
    }
    methodCalls.push(['Email/set', { accountId, update: Object.fromEntries(batch) }, String(methodCalls.length)]);

    const response = await jmapClient.request(methodCalls);

    if (withCreates) {
      const mailboxResult = requireMethodResult(response, '0', 'Mailbox/set');
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
      const created = (mailboxResult?.created || {}) as Record<string, { id?: string }>;
      createdIdFor = Object.fromEntries(
        Object.entries(created)
          .filter(([, mailbox]) => !!mailbox?.id)
          .map(([cid, mailbox]) => [`#${cid}`, mailbox.id!]),
      );
    }

    const emailResult = requireMethodResult(response, String(withCreates ? 1 : 0), 'Email/set');
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
}

export async function deleteEmail(
  emailId: string,
  trashMailboxId: string,
  currentMailboxId: string,
  accountIdOverride?: string,
): Promise<void> {
  await deleteEmails([emailId], trashMailboxId, currentMailboxId, accountIdOverride);
}

export async function searchEmails(
  query: string,
  mailboxId?: string,
  limit = 30,
  accountIdOverride?: string,
): Promise<string[]> {
  const accountId = accountIdOverride ?? jmapClient.accountId;
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
  return (requireMethodResult(res, '0', 'Email/query').ids as string[]) ?? [];
}

// Cross-mailbox query with an arbitrary JMAP filter (used by contact activity
// to search "from OR to <addresses>" without picking a specific mailbox).
export async function queryEmailsByFilter(
  filter: Record<string, unknown>,
  limit = 5,
  accountIdOverride?: string,
): Promise<string[]> {
  const accountId = accountIdOverride ?? jmapClient.accountId;
  const res = await jmapClient.request([
    ['Email/query', {
      accountId,
      filter,
      sort: [{ property: 'receivedAt', isAscending: false }],
      limit,
    }, '0'],
  ]);
  return (requireMethodResult(res, '0', 'Email/query').ids as string[]) ?? [];
}

export interface OutgoingAttachment {
  blobId: string;
  type: string;
  name: string;
  size?: number;
  disposition?: 'attachment' | 'inline';
  cid?: string;
}

export interface OutgoingEmail {
  from: EmailAddress[];
  to: EmailAddress[];
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  replyTo?: EmailAddress[];
  subject: string;
  htmlBody?: string;
  textBody?: string;
  attachments?: OutgoingAttachment[];
  // RFC 5322 threading: bare msg-ids (angle brackets are stripped). A legacy
  // whitespace-separated string is accepted and split.
  inReplyTo?: string[] | string;
  references?: string[] | string;
  // Pre-assigned Message-ID (e.g. when re-sending a draft); generated when absent.
  messageId?: string;
  requestReadReceipt?: boolean;
  /**
   * SMTP MAIL FROM when it must differ from the header From - a catch-all
   * alias on an owned domain is sent through the identity's envelope while
   * the visible From keeps the alias (webmail #246).
   */
  envelopeMailFrom?: string;
}

export interface SendEmailResult {
  /** True when the message was deferred (HOLDFOR / FUTURERELEASE). */
  scheduled: boolean;
  /** ISO timestamp the server resolved for a deferred send, when known. */
  sendAt?: string;
  emailId?: string;
  emailSubmissionId?: string;
  /** Post-send filing/cleanup problem (message did go out). */
  filingWarning?: string;
}

function toMessageIdList(value: string[] | string | undefined): string[] | undefined {
  if (!value) return undefined;
  const raw = Array.isArray(value) ? value : value.split(/[\s,]+/);
  const ids = raw.map(stripMessageIdBrackets).filter(Boolean);
  return ids.length ? ids : undefined;
}

function cleanAddresses(list: EmailAddress[] | undefined): EmailAddress[] | undefined {
  if (!list) return undefined;
  const out = list
    .map((a) => {
      const email = a.email?.trim();
      if (!email) return null;
      const name = sanitizeDisplayName(a.name);
      return name ? { name, email } : { email };
    })
    .filter((a): a is EmailAddress => a !== null);
  // RFC 5322 §3.6.3: an empty address-list header is malformed; omit instead.
  return out.length ? out : undefined;
}

function dedupeAddresses(list: EmailAddress[] | undefined): EmailAddress[] | undefined {
  if (!list) return undefined;
  const seen = new Set<string>();
  const out: EmailAddress[] = [];
  for (const a of list) {
    const key = a.email.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out.length ? out : undefined;
}

/** The JMAP `Email/set` create object for an outgoing message or draft. */
function buildEmailCreate(email: OutgoingEmail): Record<string, unknown> {
  const from = cleanAddresses(email.from) ?? email.from;
  const emailCreate: Record<string, unknown> = {
    from,
    to: cleanAddresses(email.to) ?? [],
    cc: cleanAddresses(email.cc),
    bcc: dedupeAddresses(cleanAddresses(email.bcc)),
    replyTo: cleanAddresses(email.replyTo),
    subject: email.subject,
    messageId: [email.messageId ? stripMessageIdBrackets(email.messageId) : generateMessageId(from[0]?.email ?? 'localhost')],
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

  // Per RFC 8621 §4.1.2.3 inReplyTo/references are arrays of bare msg-ids.
  const inReplyTo = toMessageIdList(email.inReplyTo);
  const references = toMessageIdList(email.references);
  if (inReplyTo) emailCreate.inReplyTo = inReplyTo;
  if (references) emailCreate.references = references;
  else if (inReplyTo) emailCreate.references = inReplyTo;

  if (email.requestReadReceipt && from[0]?.email) {
    // RFC 8098: ask the recipient's client to return a Message Disposition
    // Notification to our address.
    emailCreate['header:Disposition-Notification-To:asText'] = from[0].email;
  }

  return emailCreate;
}

/**
 * The error for a submission the server refused. A hold beyond the MTA's
 * limit becomes `ScheduleTooLateError`, and the limit it names is remembered
 * so the pickers stop offering such times (webmail parity).
 */
function submissionError(err: { description?: string; type?: string }, fallback: string): Error {
  const limit = parseHoldLimit(err.description);
  if (limit === null) return new Error(err.description ?? err.type ?? fallback);
  jmapClient.learnHoldLimit(limit);
  return new ScheduleTooLateError(limit);
}

export interface SendEmailOptions {
  /**
   * Drafts folder id. When given, the message is created there with `$draft`
   * and moved to Sent by `onSuccessUpdateEmail` on the submission, so the
   * SMTP send happens before it lands in Sent (#188) and a failed submission
   * leaves it in Drafts instead of faking a sent copy.
   */
  draftsMailboxId?: string;
  /** Previous draft version to destroy once the submission succeeded (#849). */
  draftId?: string;
  /** Submitting account (shared/group account); defaults to the primary. */
  accountId?: string;
}

export async function sendEmail(
  email: OutgoingEmail,
  identityId: string,
  sentMailboxId: string,
  // When > 0 the message is held for this many seconds before delivery via the
  // SMTP HOLDFOR parameter (FUTURERELEASE). Used for both explicit "send later"
  // scheduling and the global send-delay (undo-send) window.
  holdForSeconds?: number,
  opts?: SendEmailOptions,
): Promise<SendEmailResult> {
  const accountId = opts?.accountId ?? jmapClient.accountId;
  const emailCreate = buildEmailCreate(email);
  const viaDrafts = !!opts?.draftsMailboxId;
  if (viaDrafts) {
    emailCreate.mailboxIds = { [opts!.draftsMailboxId!]: true };
    emailCreate.keywords = { $seen: true, $draft: true };
  } else {
    emailCreate.mailboxIds = { [sentMailboxId]: true };
    emailCreate.keywords = { $seen: true };
  }

  const submissionCreate: Record<string, unknown> = { emailId: '#draft', identityId };
  // For a deferred send the envelope must be set explicitly so the HOLDFOR
  // mail-from parameter rides along (JMAP §7.3: an omitted envelope makes the
  // server derive mailFrom from the Identity, dropping our parameter). An
  // explicit envelope sender (catch-all From override) needs it as well.
  const holdFor = holdForSeconds && holdForSeconds > 0 ? Math.ceil(holdForSeconds) : 0;
  if (holdFor > 0 || email.envelopeMailFrom) {
    const rcptTo = [...email.to, ...(email.cc ?? []), ...(email.bcc ?? [])]
      .map((r) => r.email.trim())
      .filter(Boolean)
      .map((address) => ({ email: address }));
    const mailFrom: Record<string, unknown> = {
      email: email.envelopeMailFrom || email.from[0]?.email,
    };
    if (holdFor > 0) mailFrom.parameters = { HOLDFOR: String(holdFor) };
    submissionCreate.envelope = { mailFrom, rcptTo };
  }

  const submissionArgs: Record<string, unknown> = {
    accountId,
    create: { 'sub-1': submissionCreate },
  };
  if (viaDrafts) {
    submissionArgs.onSuccessUpdateEmail = {
      '#sub-1': {
        mailboxIds: { [sentMailboxId]: true },
        [keywordPointer('$draft')]: null,
      },
    };
  }

  const res = await jmapClient.request(
    [
      ['Email/set', { accountId, create: { draft: emailCreate } }, '0'],
      ['EmailSubmission/set', submissionArgs, '1'],
    ],
    SUBMISSION_USING,
  );

  let emailId: string | undefined;
  let emailSubmissionId: string | undefined;
  let sendAt: string | undefined;
  let filingWarning: string | undefined;
  for (const [methodName, result] of res.methodResponses) {
    if (methodName === 'error' || methodName.endsWith('/error')) {
      // Once the submission exists the message has left (or is held), so a
      // later error is the implicit `onSuccessUpdateEmail` Email/set that
      // Stalwart appends failing to file it. Failing the send here made the
      // user retry and send the message twice.
      if (emailSubmissionId) {
        const err = result as { description?: string; type?: string };
        filingWarning = filingWarning ?? (err.description || err.type || 'post-send filing failed');
        continue;
      }
      throw new Error((result as { description?: string }).description ?? 'Send failed');
    }
    if (methodName === 'Email/set') {
      const notCreated = (result as { notCreated?: Record<string, { description?: string; type?: string; properties?: string[] }> }).notCreated?.draft;
      if (notCreated) {
        const props = notCreated.properties?.length ? ` (properties: ${notCreated.properties.join(', ')})` : '';
        throw new Error(`${notCreated.description ?? notCreated.type ?? 'Failed to create message'}${props}`);
      }
      // Stalwart answers a submission carrying `onSuccessUpdateEmail` with a
      // SECOND `Email/set` response (reusing the submission's call id) that
      // reports the filing update and carries no `created`. Only take an id
      // when one is actually there - assigning unconditionally overwrote the
      // real id with undefined, which silently disabled the undo-send window.
      const createdId = (result as { created?: Record<string, { id?: string }> }).created?.draft?.id;
      if (createdId) emailId = createdId;
      // Filing problems from onSuccessUpdateEmail come back on the implicit
      // Email/set; the message already left, so warn rather than fail.
      const notUpdated = (result as { notUpdated?: Record<string, { description?: string; type?: string }> }).notUpdated;
      if (notUpdated && Object.keys(notUpdated).length) {
        const first = Object.values(notUpdated)[0];
        filingWarning = filingWarning ?? (first?.description || first?.type || 'post-send filing failed');
      }
    }
    if (methodName === 'EmailSubmission/set') {
      const notCreated = (result as { notCreated?: Record<string, { description?: string; type?: string }> }).notCreated?.['sub-1'];
      if (notCreated) throw submissionError(notCreated, 'Failed to submit message');
      const created = (result as { created?: Record<string, { id?: string; sendAt?: string }> }).created?.['sub-1'];
      emailSubmissionId = created?.id;
      sendAt = created?.sendAt;
    }
  }

  // The message is out (or scheduled) - now it is safe to drop the old draft.
  // A failure here leaves an orphan in Drafts, which is a filing warning
  // rather than a failed send (#849).
  if (opts?.draftId && emailSubmissionId) {
    try {
      await destroyEmails([opts.draftId], accountId);
    } catch (err) {
      filingWarning = filingWarning ?? `old draft cleanup failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  return {
    scheduled: !!(holdForSeconds && holdForSeconds > 0),
    sendAt,
    emailId,
    emailSubmissionId,
    filingWarning,
  };
}

/**
 * Save a draft into the Drafts folder (`$draft` + `$seen`). When `previousDraftId`
 * is given it is destroyed only AFTER the replacement was created (#849): a
 * combined create+destroy would delete the last good copy when the create
 * fails (e.g. blobNotFound on a re-opened draft's attachments). Returns the
 * new draft id.
 */
export async function createDraft(
  email: OutgoingEmail,
  draftsMailboxId: string,
  previousDraftId?: string,
  accountIdOverride?: string,
): Promise<string> {
  const accountId = accountIdOverride ?? jmapClient.accountId;
  const emailCreate = buildEmailCreate(email);
  emailCreate.mailboxIds = { [draftsMailboxId]: true };
  emailCreate.keywords = { $seen: true, $draft: true };
  const res = await jmapClient.request([
    ['Email/set', { accountId, create: { draft: emailCreate } }, '0'],
  ]);
  const body = requireMethodResult(res, '0', 'Email/set');
  const notCreated = body.notCreated?.draft as { description?: string; type?: string } | undefined;
  if (notCreated) throw new Error(notCreated.description || notCreated.type || 'Failed to save draft');
  const id = body.created?.draft?.id as string | undefined;
  if (!id) throw new Error('Draft save returned no id');
  if (previousDraftId && previousDraftId !== id) {
    try {
      await destroyEmails([previousDraftId], accountId);
    } catch (err) {
      console.warn('[email] failed to destroy previous draft version:', err);
    }
  }
  return id;
}

export interface ScheduledEmail {
  /** Account holding the submission: a shared account for a send from its identity. */
  accountId: string;
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
// can show subject/recipients. Covers every account that can hold mail: a
// send from a shared identity is held in the shared account, where a
// primary-only lookup never found it, so it could not be cancelled (webmail
// #874). Empty when no account supports FUTURERELEASE.
export async function listScheduledEmails(): Promise<ScheduledEmail[]> {
  const accountIds = jmapClient.getSubmissionAccountIds().filter((id) => jmapClient.hasDelayedSend(id));
  const out: ScheduledEmail[] = [];
  for (const accountId of accountIds) {
    try {
      out.push(...(await listScheduledEmailsIn(accountId)));
    } catch (err) {
      // A shared account that can't answer (revoked access, server error)
      // must not hide the user's own scheduled mail.
      if (accountId === jmapClient.accountId) throw err;
      console.warn(`[email] scheduled sends of account ${accountId} unavailable:`, err);
    }
  }
  return out.sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime());
}

async function listScheduledEmailsIn(accountId: string): Promise<ScheduledEmail[]> {
  const now = Date.now();

  const queryRes = await jmapClient.request(
    [['EmailSubmission/query', { accountId, limit: 200 }, '0']],
    [CAPABILITIES.CORE, CAPABILITIES.SUBMISSION],
  );
  const [queryName, queryBody] = queryRes.methodResponses[0];
  if (queryName === 'error' || queryName.endsWith('/error')) return [];
  const ids = (queryBody.ids as string[]) ?? [];
  if (ids.length === 0) return [];

  const submissions: Array<{
    id: string;
    emailId: string;
    identityId: string;
    threadId?: string;
    sendAt?: string;
    undoStatus?: string;
  }> = [];
  for (const slice of batched(ids, maxInGet())) {
    const subRes = await jmapClient.request(
      [['EmailSubmission/get', {
        accountId,
        ids: slice,
        properties: ['id', 'emailId', 'identityId', 'threadId', 'sendAt', 'undoStatus'],
      }, '0']],
      [CAPABILITIES.CORE, CAPABILITIES.SUBMISSION],
    );
    submissions.push(...((requireMethodResult(subRes, '0', 'EmailSubmission/get').list as typeof submissions) ?? []));
  }
  const pending = submissions.filter((s) => {
    if (s.undoStatus !== 'pending' || !s.sendAt) return false;
    const t = new Date(s.sendAt).getTime();
    return Number.isFinite(t) && t > now;
  });
  if (pending.length === 0) return [];

  const emailIds = Array.from(new Set(pending.map((s) => s.emailId)));
  const emailById = new Map<string, Email>();
  for (const slice of batched(emailIds, maxInGet())) {
    const emailRes = await jmapClient.request([
      ['Email/get', {
        accountId,
        ids: slice,
        properties: ['id', 'subject', 'to', 'from', 'preview', 'threadId'],
      }, '0'],
    ]);
    for (const e of (requireMethodResult(emailRes, '0', 'Email/get').list as Email[]) ?? []) {
      emailById.set(e.id, e);
    }
  }

  return pending
    .map((s): ScheduledEmail | null => {
      const e = emailById.get(s.emailId);
      if (!s.sendAt) return null;
      return {
        accountId,
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
    .filter((s): s is ScheduledEmail => s !== null);
}

// Cancel a pending scheduled send. The held message copy stays in Sent; only
// delivery is stopped (matches the webmail behaviour). `accountIdOverride` is
// the account holding the submission (see `ScheduledEmail.accountId`).
export async function cancelScheduledSend(emailSubmissionId: string, accountIdOverride?: string): Promise<void> {
  const accountId = accountIdOverride ?? jmapClient.accountId;
  const res = await jmapClient.request(
    [['EmailSubmission/set', {
      accountId,
      update: { [emailSubmissionId]: { undoStatus: 'canceled' } },
    }, '0']],
    [CAPABILITIES.CORE, CAPABILITIES.SUBMISSION],
  );
  const body = requireMethodResult(res, '0', 'EmailSubmission/set');
  const failure = body.notUpdated?.[emailSubmissionId] as
    | { type?: string; description?: string }
    | undefined;
  if (failure) {
    throw new Error(failure.description ?? failure.type ?? 'Failed to cancel scheduled send');
  }
}

/**
 * Change when a scheduled message goes out (or send it now with `holdForSeconds`
 * = 0): cancel the pending submission and create a replacement for the same
 * Email with the held envelope and a fresh HOLDFOR, in one request. Returns the new
 * submission id and resolved send time.
 */
export async function rescheduleScheduledSend(
  scheduled: {
    emailSubmissionId: string;
    emailId: string;
    identityId: string;
    from?: EmailAddress[];
    to?: EmailAddress[];
    /** Account holding the submission; the replacement is created there too. */
    accountId?: string;
  },
  holdForSeconds: number,
  recipients?: EmailAddress[],
): Promise<{ emailSubmissionId?: string; sendAt?: string }> {
  const accountId = scheduled.accountId ?? jmapClient.accountId;
  const create: Record<string, unknown> = { emailId: scheduled.emailId, identityId: scheduled.identityId };
  if (holdForSeconds > 0) {
    // Reuse the held submission's envelope: it names every recipient,
    // Cc and Bcc included, and the envelope sender a catch-all From went
    // out through. Rebuilding it from the Email's To dropped Cc and Bcc.
    // The Email's To/Cc/Bcc are the fallback when the server has none.
    const lookup = await jmapClient.request(
      [
        ['EmailSubmission/get', { accountId, ids: [scheduled.emailSubmissionId], properties: ['envelope'] }, '0'],
        ['Email/get', { accountId, ids: [scheduled.emailId], properties: ['to', 'cc', 'bcc'] }, '1'],
      ],
      [CAPABILITIES.CORE, CAPABILITIES.MAIL, CAPABILITIES.SUBMISSION],
    );
    const envelope = (requireMethodResult(lookup, '0', 'EmailSubmission/get').list as Array<{
      envelope?: { mailFrom?: { email?: string }; rcptTo?: Array<{ email?: string }> } | null;
    }> | undefined)?.[0]?.envelope;
    const held = requireMethodResult(lookup, '1', 'Email/get').list as Email[] | undefined;
    const headerRecipients = [...(held?.[0]?.to ?? []), ...(held?.[0]?.cc ?? []), ...(held?.[0]?.bcc ?? [])];
    const source = recipients ?? (envelope?.rcptTo?.length ? envelope.rcptTo : headerRecipients);
    const rcpt = source.map((r) => ({ email: (r.email ?? '').trim() })).filter((r) => r.email);
    create.envelope = {
      mailFrom: {
        email: envelope?.mailFrom?.email || scheduled.from?.[0]?.email,
        parameters: { HOLDFOR: String(Math.ceil(holdForSeconds)) },
      },
      rcptTo: rcpt,
    };
  }
  const res = await jmapClient.request(
    [['EmailSubmission/set', {
      accountId,
      update: { [scheduled.emailSubmissionId]: { undoStatus: 'canceled' } },
      create: { replacement: create },
    }, '0']],
    [CAPABILITIES.CORE, CAPABILITIES.SUBMISSION],
  );
  const body = requireMethodResult(res, '0', 'EmailSubmission/set');
  const notUpdated = body.notUpdated?.[scheduled.emailSubmissionId] as { description?: string; type?: string } | undefined;
  if (notUpdated) throw new Error(notUpdated.description ?? notUpdated.type ?? 'Failed to cancel the previous schedule');
  const notCreated = body.notCreated?.replacement as { description?: string; type?: string } | undefined;
  if (notCreated) throw submissionError(notCreated, 'Failed to reschedule');
  const created = body.created?.replacement as { id?: string; sendAt?: string } | undefined;
  return { emailSubmissionId: created?.id, sendAt: created?.sendAt };
}

/**
 * Move a message back into Drafts (out of Sent) and re-flag it `$draft` so
 * it can be edited and re-sent - used after cancelling a scheduled send for
 * editing (webmail `restoreEmailToDraft`).
 */
export async function restoreEmailToDraft(
  emailId: string,
  draftsMailboxId: string,
  sentMailboxId?: string,
  accountIdOverride?: string,
): Promise<void> {
  const accountId = accountIdOverride ?? jmapClient.accountId;
  const patch: Record<string, unknown> = {
    [mailboxPointer(draftsMailboxId)]: true,
    [keywordPointer('$draft')]: true,
    [keywordPointer('$seen')]: true,
  };
  if (sentMailboxId && sentMailboxId !== draftsMailboxId) patch[mailboxPointer(sentMailboxId)] = null;
  await emailSetBatched(accountId, { update: { [emailId]: patch } }, 'draft');
}

export interface SendReadReceiptOptions extends MdnOptions {
  /** Identity the receipt is submitted through (its address is the MDN From). */
  identityId: string;
  /** Where the sent receipt is filed. */
  sentMailboxId: string;
  /** Submitting account (shared/group account); defaults to the primary. */
  accountId?: string;
}

/**
 * Send an RFC 8098 read receipt (MDN). JMAP has no MDN primitive, so the
 * multipart/report is built client-side (`lib/mdn.ts`), uploaded as a blob,
 * imported into Sent and submitted with an explicit envelope - mirrors the
 * webmail's `client.sendReadReceipt`. When the submission fails the imported
 * copy is destroyed again, so a refused receipt does not sit in Sent as if
 * it had gone out. The caller flags the original `$mdnsent` afterwards.
 */
export async function sendReadReceipt(opts: SendReadReceiptOptions): Promise<string> {
  const accountId = opts.accountId ?? jmapClient.accountId;
  const raw = buildMdnMessage(opts);
  const bytes = new TextEncoder().encode(raw);
  // Lazy: blob.ts pulls in expo-file-system, which this module otherwise
  // never needs (and which the node test environment cannot load).
  const { uploadBytes } = await import('./blob');
  const upload = await uploadBytes(bytes, 'message/rfc822', accountId);
  const emailId = await importEmailBlob(upload.blobId, opts.sentMailboxId, { $seen: true }, accountId);
  try {
    const res = await jmapClient.request(
      [
        ['EmailSubmission/set', {
          accountId,
          create: {
            mdn: {
              emailId,
              identityId: opts.identityId,
              envelope: {
                mailFrom: { email: opts.fromEmail },
                rcptTo: [{ email: opts.to }],
              },
            },
          },
        }, '0'],
      ],
      SUBMISSION_USING,
    );
    const body = requireMethodResult(res, '0', 'EmailSubmission/set');
    assertSetResult(body, ['mdn'], 'read receipt');
  } catch (err) {
    await destroyEmails([emailId], accountId).catch((cleanupErr) => {
      console.warn('[mdn] failed to remove the unsent receipt from Sent:', cleanupErr);
    });
    throw err;
  }
  return emailId;
}
