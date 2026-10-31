// "Search everything": the search providers (webmail
// lib/global-search/providers/*.ts and accounts.ts).
//
// The JMAP client is one live session, so the signed-in login goes through
// it, and every other login is asked "detached": with its stored
// credentials, posting to its own API URL (as the unified inbox does), so the
// live session is never disturbed. Shared and group accounts inside a login
// are searched too.

import { jmapClient, rewriteSessionUrl, extractOrigin, type StoredCredentials } from './jmap-client';
import { CAPABILITIES, type CalendarEvent, type ContactCard, type Email, type FileNode, type JMAPMethodCall, type JMAPSession } from './types';
import { fetchWithDeadline } from './unified-inbox';
import { getAllFileNodesAcrossAccounts, fileNodeKind } from './files';
import { namespaceId } from './contacts';
import { freshStoredCredentials } from '../lib/stored-token-refresh';
import { generateAccountId } from '../lib/account-utils';
import { accountSupports } from '../lib/account-capability';
import { contactFromWire } from '../lib/contact-wire';
import { getContactDisplayName, getContactPrimaryEmail } from '../lib/contact-utils';
import { textFilter } from '../lib/search-utils';
import { snippetFilterFor, snippetHighlight, type SearchSnippetResult } from '../lib/search-snippet';
import { matchesTerms, type ParsedQuery } from '../lib/global-search/query-parser';
import {
  calendarFilterFor, contactFields, emailFields, emailMatchesFilters, eventFields, isRecurringEvent,
  mailFilterFor, pathOfNode, type MailboxRef,
} from '../lib/global-search/filters';
import type {
  CalendarHit, ContactHit, FileHit, GlobalSearchHit, MailHit, SearchAccount, SearchProvider,
} from '../lib/global-search/types';
import { useAccountStore } from '../stores/account-store';
import { useAuthStore } from '../stores/auth-store';
import { useEmailStore } from '../stores/email-store';
import { useContactsStore } from '../stores/contacts-store';
import { useCalendarStore } from '../stores/calendar-store';

type MethodResponses = Array<[string, Record<string, any>, string]>;

const SESSION_TTL_MS = 10 * 60_000;
const MAILBOX_TTL_MS = 60_000;
/** Files have no usable server search: the listing is filtered, cached a minute. */
export const FILE_LISTING_TTL_MS = 60_000;

const MAIL_PROPERTIES = [
  'id', 'threadId', 'mailboxIds', 'keywords', 'receivedAt', 'from', 'to', 'cc',
  'subject', 'preview', 'hasAttachment', 'size',
];
const EVENT_PROPERTIES = [
  'id', 'uid', 'calendarIds', 'title', 'description', 'start', 'duration', 'timeZone',
  'showWithoutTime', 'locations', 'participants', 'recurrenceRule', 'recurrenceId',
];
const DETACHED_FILE_PROPERTIES = ['id', 'parentId', 'name', 'type', 'blobId', 'size', 'created', 'modified', 'nodeType'];

// ── Logins ───────────────────────────────────────────────────────────────

/** Every login the search fans out to (webmail getSearchAccounts). */
export function getSearchAccounts(): SearchAccount[] {
  const { accounts } = useAccountStore.getState();
  const activeId = useAuthStore.getState().activeAccountId;
  return accounts
    .filter((a) => !a.needsSignIn)
    .map((a) => ({
      localAccountId: a.id,
      label: a.displayName || a.email || a.username,
      email: a.email || a.username,
      serverUrl: a.serverUrl,
      active: a.id === activeId,
    }));
}

interface LoginSession {
  session: JMAPSession;
  post: (calls: JMAPMethodCall[], using: string[]) => Promise<MethodResponses>;
  live: boolean;
}

const sessions = new Map<string, { at: number; value: Promise<LoginSession> }>();

/** Forget the detached sessions (sign-out, tests). */
export function resetGlobalSearchCache(): void {
  sessions.clear();
  mailboxCache.clear();
  fileListings.clear();
}

function isLiveLogin(localAccountId: string): boolean {
  if (!jmapClient.isConnected || !jmapClient.currentSession) return false;
  const { username, serverUrl } = jmapClient;
  return !!username && !!serverUrl && generateAccountId(username, serverUrl) === localAccountId;
}

function authHeader(creds: StoredCredentials): string {
  if (creds.accessToken) return `Bearer ${creds.accessToken}`;
  return `Basic ${btoa(`${creds.username}:${creds.password}`)}`;
}

async function openDetached(localAccountId: string): Promise<LoginSession> {
  let creds = await jmapClient.getStoredCredentials(localAccountId);
  if (!creds) throw new Error('No stored credentials');
  creds = await freshStoredCredentials(localAccountId, creds);
  const base = creds.serverUrl.replace(/\/+$/, '');
  const auth = authHeader(creds);
  const sessionRes = await fetchWithDeadline(`${base}/.well-known/jmap`, {
    headers: { Authorization: auth, Accept: 'application/json' },
  });
  const session = (await sessionRes.json()) as JMAPSession;
  const apiUrl = rewriteSessionUrl(session.apiUrl, extractOrigin(base)) ?? session.apiUrl;
  return {
    session,
    live: false,
    post: async (calls, using) => {
      try {
        const res = await fetchWithDeadline(apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: auth },
          body: JSON.stringify({ using, methodCalls: calls }),
        });
        const body = await res.json();
        return (body.methodResponses ?? []) as MethodResponses;
      } catch (err) {
        // A dead session must not be reused for the next search.
        if (err instanceof Error && err.message === 'Session expired') sessions.delete(localAccountId);
        throw err;
      }
    },
  };
}

async function loginSession(account: SearchAccount): Promise<LoginSession> {
  if (isLiveLogin(account.localAccountId)) {
    return {
      session: jmapClient.currentSession!,
      live: true,
      post: async (calls, using) => (await jmapClient.request(calls, using)).methodResponses as MethodResponses,
    };
  }
  const cached = sessions.get(account.localAccountId);
  if (cached && Date.now() - cached.at < SESSION_TTL_MS) return cached.value;
  const value = openDetached(account.localAccountId);
  sessions.set(account.localAccountId, { at: Date.now(), value });
  value.catch(() => sessions.delete(account.localAccountId));
  return value;
}

/**
 * The JMAP accounts of a login that hold a kind: its primary one first, then
 * the shared and group accounts the user may use it with.
 */
export function accountsFor(session: JMAPSession, capability: string): { id: string; name: string; primary: boolean }[] {
  const primaryId = session.primaryAccounts?.[capability] ?? session.primaryAccounts?.[CAPABILITIES.MAIL];
  const out: { id: string; name: string; primary: boolean }[] = [];
  if (primaryId && session.accounts?.[primaryId]) out.push({ id: primaryId, name: session.accounts[primaryId].name || primaryId, primary: true });
  for (const [id, info] of Object.entries(session.accounts ?? {})) {
    if (id === primaryId) continue;
    if (!accountSupports(info, session.capabilities, capability)) continue;
    out.push({ id, name: info.name || id, primary: false });
  }
  return out;
}

function responseOf(responses: MethodResponses, callId: string, method: string): Record<string, any> {
  const match = responses.find((r) => r[2] === callId);
  if (!match) throw new Error(`Missing response to ${method}`);
  if (match[0] === 'error') throw new Error((match[1] as { description?: string; type?: string }).description || (match[1] as { type?: string }).type || `${method} failed`);
  return match[1];
}

function abortIfNeeded(signal: AbortSignal): void {
  if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
}

// ── Mail ─────────────────────────────────────────────────────────────────

const mailboxCache = new Map<string, { at: number; list: MailboxRef[] }>();

async function mailboxesOf(login: LoginSession, localAccountId: string, accountId: string): Promise<MailboxRef[]> {
  const key = `${localAccountId}|${accountId}`;
  const cached = mailboxCache.get(key);
  if (cached && Date.now() - cached.at < MAILBOX_TTL_MS) return cached.list;
  const res = await login.post([['Mailbox/get', { accountId, properties: ['id', 'name', 'role'] }, '0']], [CAPABILITIES.CORE, CAPABILITIES.MAIL]);
  const list = (responseOf(res, '0', 'Mailbox/get').list ?? []) as MailboxRef[];
  mailboxCache.set(key, { at: Date.now(), list });
  return list;
}

function folderName(email: Pick<Email, 'mailboxIds'>, mailboxes: MailboxRef[]): string {
  for (const id of Object.keys(email.mailboxIds ?? {})) {
    const mailbox = mailboxes.find((m) => m.id === id);
    if (mailbox) return mailbox.name;
  }
  return '';
}

function mailHit(
  email: Email, account: SearchAccount, jmapAccountId: string, shared: boolean, folder: string, source: 'local' | 'remote',
): MailHit {
  return {
    kind: 'mail', serverUrl: account.serverUrl, localAccountId: account.localAccountId, jmapAccountId, shared,
    id: email.id, accountLabel: account.label, title: email.subject ?? '', subtitle: folder,
    date: email.receivedAt ?? null, source, email, snippet: email.searchSnippet ?? null,
  };
}

/**
 * One account's mail search: Email/query with the parsed filter (all
 * folders but Trash and Junk), its messages, and the search snippets in the
 * same request; a server without snippets still lists the messages.
 */
async function searchMailAccount(
  login: LoginSession, parsed: ParsedQuery, accountId: string, mailboxes: MailboxRef[], limit: number,
): Promise<{ emails: Email[]; hasMore: boolean }> {
  const filter = mailFilterFor(parsed, mailboxes);
  const calls: JMAPMethodCall[] = [
    ['Email/query', { accountId, filter, sort: [{ property: 'receivedAt', isAscending: false }], limit: limit + 1, collapseThreads: false }, 'q'],
    ['Email/get', { accountId, '#ids': { resultOf: 'q', name: 'Email/query', path: '/ids' }, properties: MAIL_PROPERTIES }, 'g'],
    ['SearchSnippet/get', { accountId, filter: snippetFilterFor(filter), '#emailIds': { resultOf: 'q', name: 'Email/query', path: '/ids' } }, 's'],
  ];
  const res = await login.post(calls, [CAPABILITIES.CORE, CAPABILITIES.MAIL]);
  const ids = (responseOf(res, 'q', 'Email/query').ids ?? []) as string[];
  const list = (responseOf(res, 'g', 'Email/get').list ?? []) as Email[];
  let snippets: SearchSnippetResult[] = [];
  try {
    snippets = (responseOf(res, 's', 'SearchSnippet/get').list ?? []) as SearchSnippetResult[];
  } catch {
    // Snippets only decorate the rows.
  }
  const byId = new Map(list.map((e) => [e.id, e]));
  const emails = ids.slice(0, limit).map((id) => byId.get(id)).filter((e): e is Email => !!e).map((email) => {
    const snippet = snippets.find((s) => s.emailId === email.id);
    const highlight = snippet ? snippetHighlight(snippet) : null;
    return highlight ? { ...email, searchSnippet: highlight } : email;
  });
  return { emails, hasMore: ids.length > limit };
}

export const mailProvider: SearchProvider = {
  kind: 'mail',
  local: (parsed, accounts, limit) => {
    const account = accounts.find((a) => a.active);
    if (!account) return [];
    const { emails, mailboxes } = useEmailStore.getState();
    let primary = '';
    try { primary = jmapClient.accountId; } catch { /* no session */ }
    const hits: MailHit[] = [];
    for (const email of emails) {
      if (!matchesTerms(parsed.terms, emailFields(email))) continue;
      if (!emailMatchesFilters(email, parsed)) continue;
      const mailbox = mailboxes.find((mb) => email.mailboxIds?.[mb.originalId ?? mb.id] || email.mailboxIds?.[mb.id]);
      const jmapAccountId = email.jmapAccountId ?? (mailbox?.isShared && mailbox.accountId ? mailbox.accountId : primary);
      hits.push(mailHit(email, account, jmapAccountId, jmapAccountId !== primary, mailbox?.name ?? '', 'local'));
      if (hits.length >= limit) break;
    }
    return hits;
  },
  remote: async (parsed, account, { limit, signal }) => {
    const login = await loginSession(account);
    const hits: MailHit[] = [];
    let hasMore = false;
    // One account after the other: the run already asks the logins in parallel.
    for (const target of accountsFor(login.session, CAPABILITIES.MAIL)) {
      abortIfNeeded(signal);
      const mailboxes = await mailboxesOf(login, account.localAccountId, target.id);
      const result = await searchMailAccount(login, parsed, target.id, mailboxes, limit);
      if (result.hasMore) hasMore = true;
      for (const email of result.emails) {
        const label = target.primary ? folderName(email, mailboxes) : [target.name, folderName(email, mailboxes)].filter(Boolean).join(' · ');
        hits.push(mailHit(email, account, target.id, !target.primary, label, 'remote'));
      }
    }
    return { hits, hasMore };
  },
};

// ── Contacts ─────────────────────────────────────────────────────────────

function contactHit(
  contact: ContactCard, account: SearchAccount, jmapAccountId: string, shared: boolean, storeId: string,
  bookName: string, source: 'local' | 'remote',
): ContactHit {
  const name = getContactDisplayName(contact);
  const email = getContactPrimaryEmail(contact);
  const title = name || email || contact.originalId || contact.id;
  return {
    kind: 'contacts', serverUrl: account.serverUrl, localAccountId: account.localAccountId, jmapAccountId, shared,
    id: contact.originalId ?? contact.id, accountLabel: account.label, title,
    subtitle: [bookName, email && email !== title ? email : ''].filter(Boolean).join(' · '),
    date: contact.updated ?? null, source, contact, storeId,
  };
}

export const contactsProvider: SearchProvider = {
  kind: 'contacts',
  local: (parsed, accounts, limit) => {
    const account = accounts.find((a) => a.active);
    if (!account) return [];
    const { contacts, addressBooks } = useContactsStore.getState();
    const primary = jmapClient.currentSession?.primaryAccounts?.[CAPABILITIES.CONTACTS] ?? '';
    const hits: ContactHit[] = [];
    for (const contact of contacts) {
      if (!matchesTerms(parsed.terms, contactFields(contact, getContactDisplayName(contact)))) continue;
      const bookId = Object.keys(contact.addressBookIds ?? {})[0];
      const book = addressBooks.find((b) => b.id === bookId || b.originalId === bookId);
      const jmapAccountId = contact.accountId ?? primary;
      hits.push(contactHit(contact, account, jmapAccountId, !!contact.isShared, contact.id, book?.name ?? '', 'local'));
      if (hits.length >= limit) break;
    }
    return hits;
  },
  remote: async (parsed, account, { limit, signal }) => {
    const login = await loginSession(account);
    const hits: ContactHit[] = [];
    let hasMore = false;
    for (const target of accountsFor(login.session, CAPABILITIES.CONTACTS)) {
      abortIfNeeded(signal);
      if (!accountSupports(login.session.accounts?.[target.id], login.session.capabilities, CAPABILITIES.CONTACTS)) continue;
      const res = await login.post([
        ['ContactCard/query', { accountId: target.id, filter: textFilter(parsed.text), limit: limit + 1 }, 'q'],
        ['ContactCard/get', { accountId: target.id, '#ids': { resultOf: 'q', name: 'ContactCard/query', path: '/ids' } }, 'g'],
        ['AddressBook/get', { accountId: target.id, properties: ['id', 'name'] }, 'b'],
      ], [CAPABILITIES.CORE, CAPABILITIES.CONTACTS]);
      const ids = (responseOf(res, 'q', 'ContactCard/query').ids ?? []) as string[];
      const list = ((responseOf(res, 'g', 'ContactCard/get').list ?? []) as ContactCard[]).map((c) => contactFromWire(c));
      let books: { id: string; name: string }[] = [];
      try { books = responseOf(res, 'b', 'AddressBook/get').list ?? []; } catch { /* names only */ }
      if (ids.length > limit) hasMore = true;
      for (const contact of list.slice(0, limit)) {
        const bookId = Object.keys(contact.addressBookIds ?? {})[0];
        const bookName = books.find((b) => b.id === bookId)?.name ?? '';
        const storeId = target.primary ? contact.id : namespaceId(target.id, contact.id);
        const shown: ContactCard = target.primary ? contact : { ...contact, id: storeId, originalId: contact.id, accountId: target.id, isShared: true };
        hits.push(contactHit(shown, account, target.id, !target.primary, storeId,
          target.primary ? bookName : [target.name, bookName].filter(Boolean).join(' · '), 'remote'));
      }
    }
    return { hits, hasMore };
  },
};

// ── Calendar ─────────────────────────────────────────────────────────────

function eventHit(
  event: CalendarEvent, account: SearchAccount, jmapAccountId: string, shared: boolean, calendarName: string, source: 'local' | 'remote',
): CalendarHit {
  const location = Object.values(event.locations ?? {}).find((l) => l?.name)?.name ?? '';
  return {
    kind: 'calendar', serverUrl: account.serverUrl, localAccountId: account.localAccountId, jmapAccountId, shared,
    id: event.originalId ?? event.id, accountLabel: account.label, title: event.title || '',
    subtitle: [calendarName, location].filter(Boolean).join(' · '),
    date: event.start ?? null, source, event, isRecurring: isRecurringEvent(event),
  };
}

/** Stalwart names it recurrenceRule (singular); the app's type has the plural. */
function eventFromWire(raw: Record<string, any>): CalendarEvent {
  const rules = raw.recurrenceRules ?? (raw.recurrenceRule ? [raw.recurrenceRule] : null);
  return { ...raw, recurrenceRules: rules } as CalendarEvent;
}

export const calendarProvider: SearchProvider = {
  kind: 'calendar',
  local: (parsed, accounts, limit) => {
    const account = accounts.find((a) => a.active);
    if (!account) return [];
    const { events, calendars } = useCalendarStore.getState();
    const primary = jmapClient.currentSession?.primaryAccounts?.[CAPABILITIES.CALENDARS] ?? '';
    const hits: CalendarHit[] = [];
    // The store holds occurrences; a matching series shows once.
    const seen = new Set<string>();
    for (const event of events) {
      if (!matchesTerms(parsed.terms, eventFields(event))) continue;
      const day = event.start?.slice(0, 10);
      if (parsed.after && day && day < parsed.after) continue;
      if (parsed.before && day && day > parsed.before) continue;
      if (event.uid) {
        if (seen.has(event.uid)) continue;
        seen.add(event.uid);
      }
      const calendarId = Object.keys(event.calendarIds ?? {})[0];
      const calendar = calendars.find((c) => c.id === calendarId);
      const jmapAccountId = event.accountId ?? primary;
      hits.push(eventHit(event, account, jmapAccountId, !!event.isShared, calendar?.name ?? '', 'local'));
      if (hits.length >= limit) break;
    }
    return hits;
  },
  remote: async (parsed, account, { limit, signal }) => {
    const login = await loginSession(account);
    const hits: CalendarHit[] = [];
    let hasMore = false;
    for (const target of accountsFor(login.session, CAPABILITIES.CALENDARS)) {
      abortIfNeeded(signal);
      if (!accountSupports(login.session.accounts?.[target.id], login.session.capabilities, CAPABILITIES.CALENDARS)) continue;
      const res = await login.post([
        ['CalendarEvent/query', { accountId: target.id, filter: calendarFilterFor(parsed), sort: [{ property: 'start', isAscending: false }], limit }, 'q'],
        ['CalendarEvent/get', { accountId: target.id, '#ids': { resultOf: 'q', name: 'CalendarEvent/query', path: '/ids' }, properties: EVENT_PROPERTIES }, 'g'],
        ['Calendar/get', { accountId: target.id, properties: ['id', 'name'] }, 'c'],
      ], [CAPABILITIES.CORE, CAPABILITIES.CALENDARS]);
      const ids = (responseOf(res, 'q', 'CalendarEvent/query').ids ?? []) as string[];
      const list = ((responseOf(res, 'g', 'CalendarEvent/get').list ?? []) as Record<string, any>[]).map(eventFromWire);
      let calendars: { id: string; name: string }[] = [];
      try { calendars = responseOf(res, 'c', 'Calendar/get').list ?? []; } catch { /* names only */ }
      if (ids.length >= limit) hasMore = true;
      for (const event of list) {
        const calendarId = Object.keys(event.calendarIds ?? {})[0];
        const name = calendars.find((c) => c.id === calendarId)?.name ?? '';
        hits.push(eventHit(event, account, target.id, !target.primary,
          target.primary ? name : [target.name, name].filter(Boolean).join(' · '), 'remote'));
      }
    }
    return { hits, hasMore };
  },
};

// ── Files ────────────────────────────────────────────────────────────────

interface FileListing {
  at: number;
  nodes: FileNode[] | null;
  promise: Promise<FileNode[]>;
}

const fileListings = new Map<string, FileListing>();

/** Raw server id of a node (shared ones are listed as `<owner>:<id>`). */
export function rawFileNodeId(node: FileNode): string {
  if (node.isShared && node.accountId && node.id.startsWith(`${node.accountId}:`)) return node.id.slice(node.accountId.length + 1);
  return node.id;
}

async function listDetachedFiles(login: LoginSession): Promise<FileNode[]> {
  const all: FileNode[] = [];
  for (const target of accountsFor(login.session, CAPABILITIES.FILES)) {
    if (!accountSupports(login.session.accounts?.[target.id], login.session.capabilities, CAPABILITIES.FILES)) continue;
    try {
      const res = await login.post([['FileNode/get', { accountId: target.id, ids: null, properties: DETACHED_FILE_PROPERTIES }, '0']], [CAPABILITIES.CORE, CAPABILITIES.FILES]);
      for (const node of (responseOf(res, '0', 'FileNode/get').list ?? []) as FileNode[]) {
        all.push(target.primary ? node : {
          ...node,
          id: `${target.id}:${node.id}`,
          parentId: node.parentId == null ? null : `${target.id}:${node.parentId}`,
          accountId: target.id, accountName: target.name, isShared: true,
        });
      }
    } catch (err) {
      if (target.primary) throw err;
    }
  }
  return all;
}

function fileListing(account: SearchAccount, login: LoginSession): FileListing {
  const cached = fileListings.get(account.localAccountId);
  if (cached && Date.now() - cached.at < FILE_LISTING_TTL_MS) return cached;
  const entry: FileListing = {
    at: Date.now(),
    nodes: null,
    promise: (login.live ? getAllFileNodesAcrossAccounts() : listDetachedFiles(login)).then((nodes) => {
      entry.nodes = nodes;
      return nodes;
    }, (err) => {
      // A failed listing must not be served as "no files" for a minute.
      if (fileListings.get(account.localAccountId) === entry) fileListings.delete(account.localAccountId);
      throw err;
    }),
  };
  fileListings.set(account.localAccountId, entry);
  return entry;
}

function filterNodes(parsed: ParsedQuery, nodes: FileNode[], account: SearchAccount, limit: number, source: 'local' | 'remote', primary: string): FileHit[] {
  const hits: FileHit[] = [];
  for (const node of nodes) {
    if (node.discoverableOnly) continue;
    const kind = fileNodeKind(node);
    if (kind === 'symlink') continue;
    if (!matchesTerms(parsed.terms, [node.name, kind === 'directory' ? 'folder' : node.type])) continue;
    const folderPath = pathOfNode(nodes, node);
    hits.push({
      kind: 'files', serverUrl: account.serverUrl, localAccountId: account.localAccountId,
      jmapAccountId: node.accountId ?? primary, shared: !!node.isShared,
      id: rawFileNodeId(node), accountLabel: account.label, title: node.name,
      subtitle: [node.isShared && node.accountName ? node.accountName : '', folderPath].filter(Boolean).join(' · '),
      date: node.modified || node.created || null, source, node, folderPath, isFolder: kind === 'directory',
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

export const filesProvider: SearchProvider = {
  kind: 'files',
  local: (parsed, accounts, limit) => {
    const hits: FileHit[] = [];
    for (const account of accounts) {
      const nodes = fileListings.get(account.localAccountId)?.nodes;
      if (!nodes) continue;
      hits.push(...filterNodes(parsed, nodes, account, limit - hits.length, 'local', ''));
      if (hits.length >= limit) break;
    }
    return hits;
  },
  remote: async (parsed, account, { limit, signal }) => {
    const login = await loginSession(account);
    if (accountsFor(login.session, CAPABILITIES.FILES).length === 0 || !login.session.capabilities?.[CAPABILITIES.FILES]) {
      return { hits: [], hasMore: false };
    }
    const nodes = await fileListing(account, login).promise;
    abortIfNeeded(signal);
    const primary = login.session.primaryAccounts?.[CAPABILITIES.FILES] ?? '';
    const hits = filterNodes(parsed, nodes, account, limit + 1, 'remote', primary);
    return { hits: hits.slice(0, limit), hasMore: hits.length > limit };
  },
};

export const GLOBAL_SEARCH_PROVIDERS: readonly SearchProvider[] = [mailProvider, contactsProvider, calendarProvider, filesProvider];

export type { GlobalSearchHit };
