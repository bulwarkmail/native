// JMAP access for the widgets. Every call goes through a JMAPClient instance
// of its own, never the app's `jmapClient` singleton: the widget task can run
// inside the live React Native instance, where re-binding the singleton would
// send the UI's requests with another account's credentials. The api/*
// helpers are all bound to the singleton, so the few calls the widgets need
// are written out here.

import { AuthenticationError, JMAPClient, NetworkError } from '../api/jmap-client';
import { CAPABILITIES, type Attachment, type Email, type Mailbox } from '../api/types';
import { realAttachments } from '../lib/list-attachments';
import { findArchiveMailbox, findJunkMailbox, findTrashMailbox } from '../lib/mailbox-tree';
import { generateEmailAvatarColor, getEmailInitials } from '../lib/avatar-utils';
import { normalizeHex } from './theme';
import type { AttachmentGroup, FolderCount, MailItem, Person, QuotaState, VacationState } from './snapshot';

type Call = [string, Record<string, unknown>, string];

const LIST_PROPERTIES = [
  'id', 'threadId', 'mailboxIds', 'keywords', 'receivedAt', 'from', 'subject', 'preview', 'hasAttachment',
];
const MAILBOX_PROPERTIES = ['id', 'name', 'role', 'parentId', 'unreadEmails', 'totalEmails', 'sortOrder'];
const NEWEST_FIRST = [{ property: 'receivedAt', isAscending: false }];

/** A client for one signed-in account, or null when it has no stored credentials. */
export async function openClient(registryAccountId: string): Promise<JMAPClient | null> {
  const client = new JMAPClient();
  try {
    return (await client.loadAccount(registryAccountId)) ? client : null;
  } catch (err) {
    // A revoked password must not log the user out from a widget: the app
    // handles that when it next opens. Offline is expected; skip quietly.
    if (err instanceof AuthenticationError || err instanceof NetworkError) return null;
    throw err;
  }
}

function responseOf(res: { methodResponses: Array<[string, any, string]> }, callId: string): any {
  const hit = res.methodResponses.find((r) => r[2] === callId && r[0] !== 'error');
  return hit ? hit[1] : null;
}

export function toMailItem(
  email: Email,
  registryAccountId: string,
  opts?: { jmapAccountId?: string; threadSize?: number },
): MailItem {
  const from = email.from?.[0];
  const name = from?.name?.trim() || from?.email || '';
  return {
    id: email.id,
    threadId: email.threadId,
    accountId: registryAccountId,
    ...(opts?.jmapAccountId ? { jmapAccountId: opts.jmapAccountId } : {}),
    fromName: name,
    fromEmail: from?.email ?? '',
    initials: getEmailInitials(from?.name ?? '', from?.email) || '?',
    color: normalizeHex(generateEmailAvatarColor(from?.name ?? '', from?.email)),
    subject: email.subject ?? '',
    preview: (email.preview ?? '').replace(/\s+/g, ' ').trim(),
    receivedAt: Date.parse(email.receivedAt) || 0,
    unread: !email.keywords?.$seen,
    starred: !!email.keywords?.$flagged,
    hasAttachment: !!email.hasAttachment,
    threadSize: Math.max(1, opts?.threadSize ?? 1),
  };
}

const ROLE_ORDER: FolderCount['role'][] = ['inbox', 'drafts', 'scheduled', 'sent', 'archive', 'junk', 'trash'];

export function folderCounts(mailboxes: Mailbox[]): FolderCount[] {
  const out: FolderCount[] = [];
  for (const role of ROLE_ORDER) {
    const box = role === 'junk'
      ? findJunkMailbox(mailboxes)
      : role === 'trash'
        ? findTrashMailbox(mailboxes)
        : role === 'archive'
          ? findArchiveMailbox(mailboxes)
          : mailboxes.find((m) => m.role === role);
    if (box) out.push({ role, name: box.name, unread: box.unreadEmails ?? 0, total: box.totalEmails ?? 0 });
  }
  return out;
}

/** The people who wrote most among recent inbox mail, with their unread count. */
export function rankPeople(emails: Email[], selfEmails: string[], limit = 4): Person[] {
  const self = new Set(selfEmails.map((e) => e.toLowerCase()));
  const byEmail = new Map<string, Person & { count: number }>();
  for (const email of emails) {
    const from = email.from?.[0];
    const address = from?.email?.toLowerCase();
    if (!address || self.has(address) || /(^|[.+-])(no-?reply|notifications?|mailer-daemon)@/.test(address)) continue;
    const entry = byEmail.get(address) ?? {
      name: from?.name?.trim() || address,
      email: address,
      initials: getEmailInitials(from?.name ?? '', address) || '?',
      color: normalizeHex(generateEmailAvatarColor(from?.name ?? '', address)),
      unread: 0,
      lastAt: 0,
      count: 0,
    };
    entry.count++;
    if (!email.keywords?.$seen) entry.unread++;
    entry.lastAt = Math.max(entry.lastAt, Date.parse(email.receivedAt) || 0);
    byEmail.set(address, entry);
  }
  return [...byEmail.values()]
    .sort((a, b) => b.count - a.count || b.lastAt - a.lastAt)
    .slice(0, limit)
    .map(({ count: _count, ...person }) => person);
}

export interface MailSection {
  mailboxes: Mailbox[];
  folders: FolderCount[];
  inbox: MailItem[];
  starred: MailItem[];
  starredCount: number;
  drafts: MailItem[];
  draftCount: number;
  favourites: Person[];
  attachments: AttachmentGroup[];
  tagCounts: Map<string, { unread: number; total: number; latest?: MailItem }>;
  quota: QuotaState | null;
  vacation: VacationState | null;
  selfEmails: string[];
}

/**
 * Everything mail-related the widgets show for one account, in three
 * requests: mailboxes, then the lists (inbox, starred, drafts, attachments,
 * sender ranking, tag counts), then quota and vacation where supported.
 */
export async function fetchMailSection(
  client: JMAPClient,
  registryAccountId: string,
  tagKeywords: string[],
): Promise<MailSection> {
  const accountId = client.accountId;

  const boxesRes = await client.request([
    ['Mailbox/get', { accountId, properties: MAILBOX_PROPERTIES }, 'm'],
    ['Identity/get', { accountId, properties: ['email'] }, 'i'],
  ], [CAPABILITIES.CORE, CAPABILITIES.MAIL, CAPABILITIES.SUBMISSION]);
  const mailboxes = (responseOf(boxesRes, 'm')?.list ?? []) as Mailbox[];
  const selfEmails = [
    client.username ?? '',
    ...((responseOf(boxesRes, 'i')?.list ?? []) as Array<{ email?: string }>).map((i) => i.email ?? ''),
  ].filter(Boolean);

  const inbox = mailboxes.find((m) => m.role === 'inbox');
  const drafts = mailboxes.find((m) => m.role === 'drafts');
  const excluded = [findTrashMailbox(mailboxes), findJunkMailbox(mailboxes)]
    .filter((m): m is Mailbox => !!m)
    .map((m) => m.id);

  const calls: Call[] = [];
  const getList = (queryId: string, getId: string, properties = LIST_PROPERTIES) => {
    calls.push(['Email/get', {
      accountId,
      '#ids': { resultOf: queryId, name: 'Email/query', path: '/ids' },
      properties,
    }, getId]);
  };
  if (inbox) {
    calls.push(['Email/query', {
      accountId, filter: { inMailbox: inbox.id }, sort: NEWEST_FIRST, collapseThreads: true, limit: 12,
    }, 'qi']);
    getList('qi', 'gi');
    calls.push(['Thread/get', {
      accountId, '#ids': { resultOf: 'gi', name: 'Email/get', path: '/list/*/threadId' },
    }, 'ti']);
    calls.push(['Email/query', {
      accountId, filter: { inMailbox: inbox.id }, sort: NEWEST_FIRST, limit: 60,
    }, 'qp']);
    getList('qp', 'gp', ['id', 'from', 'keywords', 'receivedAt']);
    calls.push(['Email/query', {
      accountId,
      filter: { operator: 'AND', conditions: [{ inMailbox: inbox.id }, { hasAttachment: true }] },
      // Read receipts and invitations also count as attachments to the
      // server; ask for a few more and keep the ones with real files.
      sort: NEWEST_FIRST, collapseThreads: true, limit: 10,
    }, 'qa']);
    calls.push(['Email/get', {
      accountId,
      '#ids': { resultOf: 'qa', name: 'Email/query', path: '/ids' },
      properties: ['id', 'from', 'receivedAt', 'attachments'],
      bodyProperties: ['name', 'type', 'disposition', 'cid', 'size'],
    }, 'ga']);
  }
  calls.push(['Email/query', {
    accountId,
    filter: excluded.length
      ? { operator: 'AND', conditions: [{ hasKeyword: '$flagged' }, { inMailboxOtherThan: excluded }] }
      : { hasKeyword: '$flagged' },
    sort: NEWEST_FIRST, collapseThreads: true, limit: 6, calculateTotal: true,
  }, 'qs']);
  getList('qs', 'gs');
  if (drafts) {
    calls.push(['Email/query', {
      accountId, filter: { inMailbox: drafts.id }, sort: NEWEST_FIRST, limit: 1, calculateTotal: true,
    }, 'qd']);
    getList('qd', 'gd');
  }
  const listRes = await client.request(calls);

  const threadSizes = new Map<string, number>(
    ((responseOf(listRes, 'ti')?.list ?? []) as Array<{ id: string; emailIds: string[] }>)
      .map((t) => [t.id, t.emailIds?.length ?? 1]),
  );
  const inboxEmails = (responseOf(listRes, 'gi')?.list ?? []) as Email[];
  const inboxItems = inboxEmails
    .map((e) => toMailItem(e, registryAccountId, { threadSize: threadSizes.get(e.threadId) }))
    .sort((a, b) => b.receivedAt - a.receivedAt);
  const starred = ((responseOf(listRes, 'gs')?.list ?? []) as Email[])
    .map((e) => toMailItem(e, registryAccountId))
    .sort((a, b) => b.receivedAt - a.receivedAt);
  const draftItems = ((responseOf(listRes, 'gd')?.list ?? []) as Email[]).map((e) => toMailItem(e, registryAccountId));
  const attachments: AttachmentGroup[] = ((responseOf(listRes, 'ga')?.list ?? []) as Array<Email & {
    attachments?: Array<{ name?: string; type?: string; disposition?: string; cid?: string }>;
  }>)
    .map((e) => ({
      emailId: e.id,
      accountId: registryAccountId,
      fromName: e.from?.[0]?.name || e.from?.[0]?.email || '',
      receivedAt: Date.parse(e.receivedAt) || 0,
      files: realAttachments(e.attachments as Attachment[] | undefined)
        .map((a) => ({ name: a.name ?? '', type: a.type || 'application/octet-stream' })),
    }))
    .filter((g) => g.files.length > 0)
    .sort((a, b) => b.receivedAt - a.receivedAt)
    .slice(0, 3);

  const tagCounts = await fetchTagCounts(client, tagKeywords, excluded, registryAccountId);
  const { quota, vacation } = await fetchAccountStatus(client);

  return {
    mailboxes,
    folders: folderCounts(mailboxes),
    inbox: inboxItems,
    starred,
    starredCount: responseOf(listRes, 'qs')?.total ?? starred.length,
    drafts: draftItems,
    draftCount: responseOf(listRes, 'qd')?.total ?? draftItems.length,
    favourites: rankPeople((responseOf(listRes, 'gp')?.list ?? []) as Email[], selfEmails),
    attachments,
    tagCounts,
    quota,
    vacation,
    selfEmails,
  };
}

async function fetchTagCounts(
  client: JMAPClient,
  keywords: string[],
  excluded: string[],
  registryAccountId: string,
): Promise<MailSection['tagCounts']> {
  const out: MailSection['tagCounts'] = new Map();
  const wanted = keywords.slice(0, 8);
  if (wanted.length === 0) return out;
  const accountId = client.accountId;
  const base = (keyword: string) =>
    excluded.length ? [{ hasKeyword: keyword }, { inMailboxOtherThan: excluded }] : [{ hasKeyword: keyword }];
  const calls: Call[] = [];
  wanted.forEach((keyword, i) => {
    calls.push(['Email/query', {
      accountId,
      filter: { operator: 'AND', conditions: base(keyword) },
      sort: NEWEST_FIRST, limit: 1, calculateTotal: true,
    }, `t${i}`]);
    calls.push(['Email/get', {
      accountId,
      '#ids': { resultOf: `t${i}`, name: 'Email/query', path: '/ids' },
      properties: LIST_PROPERTIES,
    }, `l${i}`]);
    calls.push(['Email/query', {
      accountId,
      filter: { operator: 'AND', conditions: [...base(keyword), { notKeyword: '$seen' }] },
      limit: 0, calculateTotal: true,
    }, `u${i}`]);
  });
  const max = Math.max(3, client.getMaxCallsInRequest() - (client.getMaxCallsInRequest() % 3));
  for (let start = 0; start < calls.length; start += max) {
    const res = await client.request(calls.slice(start, start + max));
    wanted.forEach((keyword, i) => {
      const total = responseOf(res, `t${i}`)?.total;
      if (total === undefined) return;
      const latest = (responseOf(res, `l${i}`)?.list ?? [])[0] as Email | undefined;
      out.set(keyword, {
        total,
        unread: responseOf(res, `u${i}`)?.total ?? 0,
        latest: latest ? toMailItem(latest, registryAccountId) : undefined,
      });
    });
  }
  return out;
}

async function fetchAccountStatus(client: JMAPClient): Promise<{ quota: QuotaState | null; vacation: VacationState | null }> {
  const accountId = client.accountId;
  const calls: Call[] = [];
  const using: string[] = [CAPABILITIES.CORE];
  if (client.hasAccountCapability(CAPABILITIES.QUOTA)) {
    calls.push(['Quota/get', { accountId }, 'q']);
    using.push(CAPABILITIES.QUOTA);
  }
  if (client.hasAccountCapability(CAPABILITIES.VACATION)) {
    calls.push(['VacationResponse/get', { accountId, ids: ['singleton'] }, 'v']);
    using.push(CAPABILITIES.MAIL, CAPABILITIES.VACATION);
  }
  if (calls.length === 0) return { quota: null, vacation: null };
  try {
    const res = await client.request(calls, using);
    const quotas = (responseOf(res, 'q')?.list ?? []) as Array<{
      resourceType?: string; scope?: string; used?: number; hardLimit?: number; limit?: number; types?: string[];
    }>;
    const coversMail = (q: (typeof quotas)[number]) => !q.types?.length || q.types.some((t) => t === 'Email' || t === 'Mail');
    const mailQuota = quotas.find((q) => q.resourceType === 'octets' && coversMail(q))
      ?? quotas.find((q) => q.resourceType === 'mail' || q.scope === 'mail');
    const limit = mailQuota ? mailQuota.hardLimit ?? mailQuota.limit ?? 0 : 0;
    const v = (responseOf(res, 'v')?.list ?? [])[0] as
      | { isEnabled?: boolean; fromDate?: string | null; toDate?: string | null; subject?: string | null }
      | undefined;
    return {
      quota: mailQuota && limit > 0 ? { used: mailQuota.used ?? 0, limit } : null,
      vacation: v
        ? {
            enabled: !!v.isEnabled,
            ...(v.fromDate ? { from: Date.parse(v.fromDate) } : {}),
            ...(v.toDate ? { to: Date.parse(v.toDate) } : {}),
            ...(v.subject ? { subject: v.subject } : {}),
          }
        : null,
    };
  } catch {
    return { quota: null, vacation: null };
  }
}

/** Newest inbox messages of one account, for the all-accounts widget. */
export async function fetchInboxPreview(client: JMAPClient, registryAccountId: string, limit = 5): Promise<{
  items: MailItem[];
  unread: number;
}> {
  const accountId = client.accountId;
  const boxes = await client.request([
    ['Mailbox/query', { accountId, filter: { role: 'inbox' } }, 'mq'],
    ['Mailbox/get', {
      accountId,
      '#ids': { resultOf: 'mq', name: 'Mailbox/query', path: '/ids' },
      properties: MAILBOX_PROPERTIES,
    }, 'mg'],
  ]);
  const inbox = (responseOf(boxes, 'mg')?.list ?? [])[0] as Mailbox | undefined;
  if (!inbox) return { items: [], unread: 0 };
  const res = await client.request([
    ['Email/query', { accountId, filter: { inMailbox: inbox.id }, sort: NEWEST_FIRST, collapseThreads: true, limit }, 'q'],
    ['Email/get', { accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: LIST_PROPERTIES }, 'g'],
  ]);
  return {
    items: ((responseOf(res, 'g')?.list ?? []) as Email[]).map((e) => toMailItem(e, registryAccountId)),
    unread: inbox.unreadEmails ?? 0,
  };
}

// ── Actions ──────────────────────────────────────────────────────────────

function emailAccount(client: JMAPClient, jmapAccountId?: string): string {
  return jmapAccountId ?? client.accountId;
}

async function setEmail(client: JMAPClient, accountId: string, update: Record<string, Record<string, unknown>>): Promise<boolean> {
  const res = await client.request([['Email/set', { accountId, update }, 's']]);
  const body = responseOf(res, 's');
  return !!body && !body.notUpdated;
}

export async function markRead(client: JMAPClient, emailId: string, jmapAccountId?: string): Promise<boolean> {
  return setEmail(client, emailAccount(client, jmapAccountId), { [emailId]: { 'keywords/$seen': true } });
}

/**
 * Move a message out of its mailboxes into the archive (or trash). Reads the
 * message's current mailboxes first so the patch only drops those.
 */
export async function moveTo(
  client: JMAPClient,
  emailId: string,
  target: 'archive' | 'trash',
  jmapAccountId?: string,
): Promise<boolean> {
  const accountId = emailAccount(client, jmapAccountId);
  const res = await client.request([
    ['Mailbox/get', { accountId, properties: MAILBOX_PROPERTIES }, 'm'],
    ['Email/get', { accountId, ids: [emailId], properties: ['id', 'mailboxIds'] }, 'e'],
  ]);
  const mailboxes = (responseOf(res, 'm')?.list ?? []) as Mailbox[];
  const email = (responseOf(res, 'e')?.list ?? [])[0] as Pick<Email, 'id' | 'mailboxIds'> | undefined;
  const destination = target === 'archive' ? findArchiveMailbox(mailboxes) : findTrashMailbox(mailboxes);
  if (!email || !destination) return false;
  const patch: Record<string, unknown> = { [`mailboxIds/${destination.id}`]: true };
  for (const id of Object.keys(email.mailboxIds ?? {})) {
    if (id !== destination.id) patch[`mailboxIds/${id}`] = null;
  }
  if (target === 'trash') patch['keywords/$seen'] = true;
  return setEmail(client, accountId, { [emailId]: patch });
}

export async function rsvp(
  client: JMAPClient,
  eventId: string,
  participantId: string,
  status: 'accepted' | 'tentative' | 'declined',
  jmapAccountId?: string,
): Promise<boolean> {
  const accountId = jmapAccountId ?? client.getPrimaryAccountId(CAPABILITIES.CALENDARS);
  const res = await client.request([
    ['CalendarEvent/set', {
      accountId,
      update: { [eventId]: { [`participants/${participantId}/participationStatus`]: status } },
      sendSchedulingMessages: true,
    }, 's'],
  ], [CAPABILITIES.CORE, CAPABILITIES.CALENDARS]);
  const body = responseOf(res, 's');
  return !!body && !body.notUpdated;
}

/** Same flip as calendar-store's toggleTaskComplete; progressUpdated is left to the server. */
export async function setTaskDone(
  client: JMAPClient,
  taskId: string,
  done: boolean,
  jmapAccountId?: string,
): Promise<boolean> {
  const accountId = jmapAccountId ?? client.getPrimaryAccountId(CAPABILITIES.CALENDARS);
  const res = await client.request([
    ['CalendarEvent/set', {
      accountId,
      update: {
        [taskId]: done
          ? { progress: 'completed', percentComplete: 100 }
          : { progress: 'needs-action', percentComplete: 0 },
      },
    }, 's'],
  ], [CAPABILITIES.CORE, CAPABILITIES.CALENDARS]);
  const body = responseOf(res, 's');
  return !!body && !body.notUpdated;
}
