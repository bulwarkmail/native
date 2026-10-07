import { CAPABILITIES } from './types';
import type { Email, JMAPSession, JMAPMethodCall, Mailbox } from './types';
import {
  jmapClient, rewriteSessionUrl, extractOrigin, parseRetryAfter, REQUEST_TIMEOUT_MS,
  type StoredCredentials,
} from './jmap-client';
import { keywordPointer, mailboxPointer } from './patch-pointer';
import { secureFetch } from '../lib/client-cert';
import { refreshOAuthAccessToken, type OAuthTokens } from '../lib/oauth';
import { isStaleLoad } from '../lib/network-error';
import type { OpScope } from './op-scope';

// Aggregated views across accounts ("All inboxes", "All Sent", All mail /
// Unread / Starred). Because the JMAP client is a single-account singleton
// (one live session at a time), the *active* registry account goes through
// the live client while every other account is fetched "detached" — reading
// its stored credentials directly and posting to its own API URL — so the
// active session is never disturbed. Session discovery and the per-account
// mailbox lists are cached for the session so a refresh is one Email/query +
// Email/get per account instead of four round-trips.

const EMAIL_LIST_PROPERTIES = [
  'id', 'threadId', 'mailboxIds', 'keywords', 'size',
  'receivedAt', 'from', 'to', 'cc', 'subject', 'preview', 'hasAttachment',
];

const TOKEN_REFRESH_LEEWAY_MS = 60_000;
const SESSION_CACHE_TTL_MS = 10 * 60 * 1000;
const MAILBOX_CACHE_TTL_MS = 60 * 1000;

export type UnifiedRole = 'inbox' | 'sent' | 'drafts' | 'junk' | 'archive' | 'trash';
export type CrossView = 'all' | 'unread' | 'starred';

/** Roles left out of the cross-account All mail / Unread / Starred views. */
export const CROSS_EXCLUDED_ROLES: ReadonlySet<string> = new Set([
  'junk', 'spam', 'sent', 'archive', 'trash', 'drafts',
]);

export interface UnifiedEmail extends Email {
  /** Registry account id this message belongs to (not the JMAP account id). */
  sourceAccountId: string;
  /**
   * JMAP account id the message lives under. Equals the registry account's
   * primary JMAP account for own mail, or a group/shared owner account when
   * the message came from a group inbox. Carried so opening/acting can target
   * the right account via an Email/get or Email/set override.
   */
  jmapAccountId: string;
  /** True when this message belongs to a group/shared inbox, not the user's own. */
  isShared: boolean;
  /** Human label for the owning account when shared (e.g. "Support"). */
  sharedLabel?: string;
  /** Name of the folder the message was found in (cross views). */
  sourceFolder?: string;
}

export interface UnifiedInboxResult {
  emails: UnifiedEmail[];
  /** accountId → error message for accounts that could not be fetched. */
  errors: Record<string, string>;
  /** Per-target paging cursors to pass back as `positions` for the next page. */
  positions: Record<string, number>;
  hasMore: boolean;
}

export interface UnifiedFetchOptions {
  /** Per-role view (default inbox) — ignored when `view` is set. */
  role?: UnifiedRole;
  /** Cross-folder view over inbox + custom folders. */
  view?: CrossView;
  /** Also scan group/shared accounts reachable through each login. */
  includeGroup?: boolean;
  /** Free-text search ANDed into every account's query. */
  query?: string;
  /** Cursors from the previous page (`UnifiedInboxResult.positions`). */
  positions?: Record<string, number>;
}

// ── Detached transport ──────────────────────────────────────────────────

function authHeaderFor(creds: StoredCredentials): string {
  if (creds.accessToken) return `Bearer ${creds.accessToken}`;
  return `Basic ${btoa(`${creds.username}:${creds.password}`)}`;
}

/** Thrown when a detached account's server rate-limited us (429). */
export class UnifiedRateLimitError extends Error {
  retryAfterMs: number;
  constructor(retryAfterMs: number) {
    super('Rate limited');
    this.name = 'UnifiedRateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * `fetch` with the same deadline the live client applies
 * (`jmapClient.authenticatedFetch`): an AbortController-backed timeout, 401
 * → "Session expired", 429 → rate-limit error carrying Retry-After.
 */
export async function fetchWithDeadline(
  url: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => controller?.abort(), timeoutMs);
  try {
    const response = await secureFetch(url, { ...init, signal: controller?.signal });
    if (response.status === 401) throw new Error('Session expired');
    if (response.status === 429) {
      const retryAfter = response.headers?.get?.('Retry-After') ?? null;
      throw new UnifiedRateLimitError(parseRetryAfter(retryAfter));
    }
    if (!response.ok) throw new Error(`JMAP request failed: ${response.status}`);
    return response;
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') throw new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

type MethodResponses = Array<[string, Record<string, any>, string]>;

interface Transport {
  post: (methodCalls: JMAPMethodCall[]) => Promise<MethodResponses>;
}

async function jmapPost(
  apiUrl: string,
  authHeader: string,
  methodCalls: JMAPMethodCall[],
): Promise<MethodResponses> {
  const response = await fetchWithDeadline(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: JSON.stringify({ using: [CAPABILITIES.CORE, CAPABILITIES.MAIL], methodCalls }),
  });
  const body = await response.json();
  return (body.methodResponses ?? []) as MethodResponses;
}

function resolveJmapAccountId(session: JMAPSession): string | null {
  return (
    session.primaryAccounts?.[CAPABILITIES.MAIL] ||
    session.primaryAccounts?.[CAPABILITIES.CORE] ||
    Object.keys(session.accounts ?? {})[0] ||
    null
  );
}

// Same rule as JMAPClient.getSharedMailAccounts(): Stalwart doesn't always
// populate `accountCapabilities` on shared accounts, so an account counts as
// mail-capable when it advertises the mail capability OR is non-personal.
function sharedMailAccountsOf(session: JMAPSession, primaryId: string): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  for (const [id, info] of Object.entries(session.accounts ?? {})) {
    if (id === primaryId) continue;
    const advertisesMail = info.accountCapabilities
      ? CAPABILITIES.MAIL in info.accountCapabilities
      : false;
    if (!advertisesMail && info.isPersonal) continue;
    out.push({ id, name: info.name || id });
  }
  return out;
}

// Refresh an about-to-expire OAuth token and persist it so the next fetch (and
// a later account switch) reuse the fresh one. Returns possibly-updated creds.
async function ensureFreshCredentials(
  accountId: string,
  creds: StoredCredentials,
): Promise<StoredCredentials> {
  if (
    !creds.accessToken ||
    !creds.refreshToken ||
    !creds.tokenEndpoint ||
    !creds.clientId ||
    creds.expiresAt == null
  ) {
    return creds;
  }
  if (creds.expiresAt - Date.now() > TOKEN_REFRESH_LEEWAY_MS) return creds;
  try {
    const tokens: OAuthTokens = {
      accessToken: creds.accessToken,
      refreshToken: creds.refreshToken,
      expiresAt: creds.expiresAt,
      tokenEndpoint: creds.tokenEndpoint,
      clientId: creds.clientId,
    };
    const next = await refreshOAuthAccessToken(tokens);
    const updated: StoredCredentials = {
      ...creds,
      accessToken: next.accessToken,
      refreshToken: next.refreshToken ?? creds.refreshToken,
      expiresAt: next.expiresAt,
      tokenEndpoint: next.tokenEndpoint,
      clientId: next.clientId,
    };
    const current = await jmapClient.getStoredCredentials(accountId);
    if (!current || current.accessToken !== updated.accessToken) {
      await jmapClient.setStoredCredentials(accountId, updated);
    }
    return updated;
  } catch {
    // Fall back to the existing (possibly expired) token; the request will
    // surface a 401 which we report as an error for this account.
    return creds;
  }
}

// ── Per-account session + mailbox cache ────────────────────────────────

interface AccountEntry {
  accountId: string;
  transport: Transport;
  primaryJmapId: string;
  shared: { id: string; name: string }[];
  /** Registry account served by the live jmapClient right now. */
  live: boolean;
  discoveredAt: number;
  mailboxes: Map<string, { list: Mailbox[]; at: number }>;
}

const entries = new Map<string, AccountEntry>();

// Folder lists a search of the shown account read on its live scope, for an
// account with no cached entry (see searchEntryFor).
const scopedMailboxes = new Map<string, AccountEntry['mailboxes']>();

/** Forget every cached session/mailbox list (logout, credential change, tests). */
export function resetUnifiedCache(accountId?: string): void {
  if (accountId) {
    entries.delete(accountId);
    scopedMailboxes.delete(accountId);
  } else {
    entries.clear();
    scopedMailboxes.clear();
  }
}

function isLiveAccount(accountId: string): boolean {
  if (!jmapClient.isConnected) return false;
  const username = jmapClient.username;
  const serverUrl = jmapClient.serverUrl;
  if (!username || !serverUrl) return false;
  // Same rule as generateAccountId(username, serverUrl) in lib/account-utils.
  let host = serverUrl;
  try { host = new URL(serverUrl).hostname; } catch { host = serverUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, ''); }
  return `${username}@${host}` === accountId;
}

async function entryFor(accountId: string): Promise<AccountEntry> {
  const live = isLiveAccount(accountId);
  const cached = entries.get(accountId);
  if (cached && cached.live === live && Date.now() - cached.discoveredAt < SESSION_CACHE_TTL_MS) {
    return cached;
  }

  if (live && jmapClient.currentSession) {
    const entry: AccountEntry = {
      accountId,
      live: true,
      transport: { post: async (calls) => (await jmapClient.request(calls)).methodResponses as MethodResponses },
      primaryJmapId: jmapClient.accountId,
      shared: jmapClient.getSharedMailAccounts(),
      discoveredAt: Date.now(),
      mailboxes: cached?.mailboxes ?? new Map(),
    };
    entries.set(accountId, entry);
    return entry;
  }

  let creds = await jmapClient.getStoredCredentials(accountId);
  if (!creds) throw new Error('No stored credentials');
  creds = await ensureFreshCredentials(accountId, creds);
  const baseUrl = creds.serverUrl.replace(/\/+$/, '');
  const authHeader = authHeaderFor(creds);

  // Session discovery.
  const sessionRes = await fetchWithDeadline(`${baseUrl}/.well-known/jmap`, {
    headers: { Authorization: authHeader, Accept: 'application/json' },
  });
  const session = (await sessionRes.json()) as JMAPSession;
  // Point the advertised apiUrl at the origin we actually connected to
  // (servers often self-report unreachable container-internal hosts) and
  // resolve relative URLs — same as the live client does.
  const apiUrl = rewriteSessionUrl(session.apiUrl, extractOrigin(baseUrl)) ?? session.apiUrl;
  const primaryJmapId = resolveJmapAccountId(session);
  if (!primaryJmapId) throw new Error('No mail account in session');

  const entry: AccountEntry = {
    accountId,
    live: false,
    transport: {
      post: async (calls) => {
        try {
          return await jmapPost(apiUrl, authHeader, calls);
        } catch (err) {
          // A dead session must not be reused for the next refresh.
          if (err instanceof Error && err.message === 'Session expired') entries.delete(accountId);
          throw err;
        }
      },
    },
    primaryJmapId,
    shared: sharedMailAccountsOf(session, primaryJmapId),
    discoveredAt: Date.now(),
    mailboxes: cached?.mailboxes ?? new Map(),
  };
  entries.set(accountId, entry);
  return entry;
}

async function mailboxesFor(entry: AccountEntry, jmapAccountId: string, force = false): Promise<Mailbox[]> {
  const cached = entry.mailboxes.get(jmapAccountId);
  if (cached && !force && Date.now() - cached.at < MAILBOX_CACHE_TTL_MS) return cached.list;
  const res = await entry.transport.post([
    ['Mailbox/get', {
      accountId: jmapAccountId,
      properties: ['id', 'role', 'name', 'parentId', 'unreadEmails', 'totalEmails', 'myRights'],
    }, '0'],
  ]);
  const [name, body] = res[0] ?? [];
  if (name !== 'Mailbox/get') throw new Error(body?.description || 'Mailbox/get failed');
  const list = ((body.list as Mailbox[]) ?? []).map((m) => ({ ...m, accountId: jmapAccountId }));
  entry.mailboxes.set(jmapAccountId, { list, at: Date.now() });
  return list;
}

/** Cached mailbox lists per JMAP account of one registry account (for counts). */
export function cachedUnifiedMailboxes(accountId: string): Array<{ jmapAccountId: string; mailboxes: Mailbox[] }> {
  const entry = entries.get(accountId);
  if (!entry) return [];
  return [...entry.mailboxes.entries()].map(([jmapAccountId, v]) => ({ jmapAccountId, mailboxes: v.list }));
}

// ── Queries ─────────────────────────────────────────────────────────────

function findByRole(mailboxes: Mailbox[], role: UnifiedRole): Mailbox | undefined {
  if (role === 'junk') return mailboxes.find((m) => m.role === 'junk' || m.role === 'spam');
  return mailboxes.find((m) => m.role === role);
}

/** Folders of one JMAP account that feed the cross views: inbox + custom folders. */
export function crossIncludedMailboxes(mailboxes: Mailbox[]): Mailbox[] {
  return mailboxes.filter((m) => !CROSS_EXCLUDED_ROLES.has(m.role ?? ''));
}

export function buildFilter(
  mailboxes: Mailbox[],
  opts: UnifiedFetchOptions,
): Record<string, unknown> | null {
  const conditions: Record<string, unknown>[] = [];
  if (opts.view) {
    const included = crossIncludedMailboxes(mailboxes);
    if (included.length === 0) return null;
    conditions.push(
      included.length === 1
        ? { inMailbox: included[0].id }
        : { operator: 'OR', conditions: included.map((m) => ({ inMailbox: m.id })) },
    );
    if (opts.view === 'unread') conditions.push({ notKeyword: '$seen' });
    if (opts.view === 'starred') conditions.push({ hasKeyword: '$flagged' });
  } else {
    const target = findByRole(mailboxes, opts.role ?? 'inbox');
    if (!target) return null;
    conditions.push({ inMailbox: target.id });
  }
  const q = opts.query?.trim();
  if (q) conditions.push({ text: q });
  return conditions.length === 1 ? conditions[0] : { operator: 'AND', conditions };
}

function targetKey(accountId: string, jmapAccountId: string): string {
  return `${accountId}|${jmapAccountId}`;
}

type TargetFilter = (mailboxes: Mailbox[], jmapAccountId: string) => Record<string, unknown> | null;

async function queryTarget(
  entry: AccountEntry,
  target: { jmapId: string; isShared: boolean; label?: string },
  filterFor: TargetFilter,
  position: number,
  limit: number,
  withFolder: boolean,
): Promise<{ emails: UnifiedEmail[]; hasMore: boolean }> {
  const mailboxes = await mailboxesFor(entry, target.jmapId);
  const filter = filterFor(mailboxes, target.jmapId);
  if (!filter) return { emails: [], hasMore: false };

  const res = await entry.transport.post([
    ['Email/query', {
      accountId: target.jmapId,
      filter,
      sort: [{ property: 'receivedAt', isAscending: false }],
      position,
      limit,
      calculateTotal: true,
    }, '0'],
    ['Email/get', {
      accountId: target.jmapId,
      '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' },
      properties: EMAIL_LIST_PROPERTIES,
    }, '1'],
  ]);
  const [qName, qBody] = res[0] ?? [];
  if (qName !== 'Email/query') throw new Error(qBody?.description || 'Email/query failed');
  const ids = (qBody.ids as string[]) ?? [];
  const total = typeof qBody.total === 'number' ? qBody.total : undefined;
  const list = ((res[1]?.[1]?.list as Email[]) ?? []);
  const byId = new Map(list.map((e) => [e.id, e]));
  const nameOf = (e: Email): string | undefined =>
    mailboxes.find((m) => e.mailboxIds?.[m.id])?.name;
  const emails = ids.flatMap((id) => {
    const e = byId.get(id);
    if (!e) return [];
    return [{
      ...e,
      sourceAccountId: entry.accountId,
      jmapAccountId: target.jmapId,
      isShared: target.isShared,
      sharedLabel: target.isShared ? target.label : undefined,
      sourceFolder: withFolder ? nameOf(e) : undefined,
    } as UnifiedEmail];
  });
  const hasMore = total !== undefined ? position + ids.length < total : ids.length === limit;
  return { emails, hasMore };
}

function fetchTarget(
  entry: AccountEntry,
  target: { jmapId: string; isShared: boolean; label?: string },
  opts: UnifiedFetchOptions,
  position: number,
  limit: number,
): Promise<{ emails: UnifiedEmail[]; hasMore: boolean }> {
  return queryTarget(entry, target, (mailboxes) => buildFilter(mailboxes, opts), position, limit, !!opts.view);
}

/** A transport on the live client that sends only on connection `gen` (see `OpScope`). */
function liveTransport(gen: number): Transport {
  return {
    post: async (calls) => (await jmapClient.request(calls, undefined, { gen })).methodResponses as MethodResponses,
  };
}

/**
 * The entry a search of registry account `accountId` reads through. With
 * `at` (the shown account, served by the live client) every request goes out
 * on that scope's connection. Without it the account is read detached; if
 * the live client happens to serve it (a switch away from it in progress),
 * its requests are bound to the connection found at the start, so a later
 * one never lands on the account switched to.
 */
async function searchEntryFor(accountId: string, at?: OpScope): Promise<AccountEntry> {
  if (at) {
    let mailboxes = entries.get(accountId)?.mailboxes ?? scopedMailboxes.get(accountId);
    if (!mailboxes) {
      mailboxes = new Map();
      scopedMailboxes.set(accountId, mailboxes);
    }
    return {
      accountId,
      live: true,
      transport: liveTransport(at.gen),
      primaryJmapId: at.accountId,
      shared: jmapClient.getSharedMailAccounts(),
      discoveredAt: Date.now(),
      // The folders of one registry account, whichever transport read them.
      mailboxes,
    };
  }
  const gen = jmapClient.connectionGen;
  const entry = await entryFor(accountId);
  return entry.live ? { ...entry, transport: liveTransport(gen) } : entry;
}

export interface AccountEmailSearch {
  /**
   * The Email/query filter for one JMAP account of the login, from its
   * folders (stamped with that `accountId`); null skips the account.
   */
  filter: TargetFilter;
  limit: number;
  /** Paging cursor, the same for every JMAP account of the login. */
  position?: number;
  /** Also search the group/shared accounts the login reaches. */
  includeGroup?: boolean;
  /** The shown account's scope: read through the live client on it. Omit for a detached read. */
  at?: OpScope;
}

/**
 * One page of matches from a registry account's own mail and, with
 * `includeGroup`, each group/shared account it reaches; every message is
 * stamped with the registry account, its JMAP account and its folder name.
 * A failing shared account is skipped, a failing own account (or a replaced
 * connection) throws.
 */
export async function searchAccountEmails(
  accountId: string,
  search: AccountEmailSearch,
): Promise<{ emails: UnifiedEmail[]; hasMore: boolean }> {
  const entry = await searchEntryFor(accountId, search.at);
  const targets: { jmapId: string; isShared: boolean; label?: string }[] = [
    { jmapId: entry.primaryJmapId, isShared: false },
  ];
  if (search.includeGroup) {
    for (const acc of entry.shared) targets.push({ jmapId: acc.id, isShared: true, label: acc.name });
  }
  let hasMore = false;
  const pages = await Promise.all(targets.map(async (target) => {
    try {
      const page = await queryTarget(entry, target, search.filter, search.position ?? 0, search.limit, true);
      if (page.hasMore) hasMore = true;
      return page.emails;
    } catch (err) {
      if (!target.isShared || isStaleLoad(err)) throw err;
      return [] as UnifiedEmail[];
    }
  }));
  const emails = pages
    .flat()
    .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
  return { emails, hasMore };
}

/**
 * One page of the unified view over `accountIds`. Every target (a registry
 * account's own mailbox plus, with `includeGroup`, each group/shared account
 * reachable through it) is queried at its own `positions` cursor and the
 * results are merged newest-first. Per-account failures are collected in
 * `errors` while the others still show.
 */
export async function fetchUnifiedInbox(
  accountIds: string[],
  perAccountLimit = 25,
  opts: UnifiedFetchOptions = {},
): Promise<UnifiedInboxResult> {
  const { includeGroup = false } = opts;
  const errors: Record<string, string> = {};
  const positions: Record<string, number> = { ...(opts.positions ?? {}) };
  let hasMore = false;

  const settled = await Promise.all(
    accountIds.map(async (accountId) => {
      try {
        const entry = await entryFor(accountId);
        const targets: { jmapId: string; isShared: boolean; label?: string }[] = [
          { jmapId: entry.primaryJmapId, isShared: false },
        ];
        if (includeGroup) {
          for (const acc of entry.shared) targets.push({ jmapId: acc.id, isShared: true, label: acc.name });
        }
        const perTarget = await Promise.all(targets.map(async (target) => {
          const key = targetKey(accountId, target.jmapId);
          const position = positions[key] ?? 0;
          try {
            const page = await fetchTarget(entry, target, opts, position, perAccountLimit);
            positions[key] = position + page.emails.length;
            if (page.hasMore) hasMore = true;
            return page.emails;
          } catch (err) {
            // A single inaccessible shared account shouldn't sink the whole
            // account's view; skip it and keep the others. Own-mail failures
            // are the account's failure.
            if (!target.isShared) throw err;
            return [] as UnifiedEmail[];
          }
        }));
        return perTarget.flat();
      } catch (err) {
        errors[accountId] = err instanceof Error ? err.message : 'Failed to load';
        return [] as UnifiedEmail[];
      }
    }),
  );
  const emails = settled
    .flat()
    .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
  return { emails, errors, positions, hasMore };
}

// ── Actions routed to the owning account ────────────────────────────────

async function emailSet(
  accountId: string,
  jmapAccountId: string,
  update: Record<string, Record<string, unknown>>,
  destroy?: string[],
): Promise<void> {
  const entry = await entryFor(accountId);
  const args: Record<string, unknown> = { accountId: jmapAccountId };
  if (Object.keys(update).length > 0) args.update = update;
  if (destroy && destroy.length > 0) args.destroy = destroy;
  const res = await entry.transport.post([['Email/set', args, '0']]);
  const [name, body] = res[0] ?? [];
  if (name !== 'Email/set') throw new Error(body?.description || 'Email/set failed');
  const failures = { ...(body.notUpdated ?? {}), ...(body.notDestroyed ?? {}) } as Record<string, { type?: string; description?: string }>;
  const first = Object.entries(failures)[0];
  if (first) throw new Error(`${first[1]?.type ?? 'error'}${first[1]?.description ? `: ${first[1].description}` : ''}`);
}

function groupByOwner(emails: UnifiedEmail[]): Map<string, { accountId: string; jmapAccountId: string; emails: UnifiedEmail[] }> {
  const groups = new Map<string, { accountId: string; jmapAccountId: string; emails: UnifiedEmail[] }>();
  for (const e of emails) {
    const key = targetKey(e.sourceAccountId, e.jmapAccountId);
    const g = groups.get(key);
    if (g) g.emails.push(e);
    else groups.set(key, { accountId: e.sourceAccountId, jmapAccountId: e.jmapAccountId, emails: [e] });
  }
  return groups;
}

/** Patch keywords (`{ $seen: true, $flagged: null }`) on messages of any account. */
export async function patchUnifiedKeywords(
  emails: UnifiedEmail[],
  patch: Record<string, boolean | null>,
): Promise<void> {
  const pointer: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) pointer[keywordPointer(k)] = v === false ? null : v;
  for (const g of groupByOwner(emails).values()) {
    const update: Record<string, Record<string, unknown>> = {};
    for (const e of g.emails) update[e.id] = { ...pointer };
    await emailSet(g.accountId, g.jmapAccountId, update);
  }
}

export type UnifiedMoveTarget = 'archive' | 'trash' | 'junk' | 'inbox';

/**
 * Move messages into the role folder of their *own* account (archive into
 * the owner's Archive, …). Spam/not-spam also flip `$junk`/`$notjunk` (#850).
 * Throws when an owning account lacks the target folder.
 */
export async function moveUnifiedEmails(
  emails: UnifiedEmail[],
  target: UnifiedMoveTarget,
  opts: { markRead?: boolean } = {},
): Promise<void> {
  for (const g of groupByOwner(emails).values()) {
    const entry = await entryFor(g.accountId);
    const mailboxes = await mailboxesFor(entry, g.jmapAccountId);
    const dest = findByRole(mailboxes, target);
    if (!dest) throw new Error(`No ${target} folder in this account`);
    const update: Record<string, Record<string, unknown>> = {};
    for (const e of g.emails) {
      const patch: Record<string, unknown> = {};
      for (const id of Object.keys(e.mailboxIds ?? {})) {
        if (id !== dest.id) patch[mailboxPointer(id)] = null;
      }
      patch[mailboxPointer(dest.id)] = true;
      if (target === 'junk') {
        patch[keywordPointer('$junk')] = true;
        patch[keywordPointer('$notjunk')] = null;
      } else if (target === 'inbox') {
        patch[keywordPointer('$junk')] = null;
        patch[keywordPointer('$notjunk')] = true;
      }
      if (opts.markRead) patch[keywordPointer('$seen')] = true;
      update[e.id] = patch;
    }
    await emailSet(g.accountId, g.jmapAccountId, update);
  }
}

/**
 * Delete like the folder list does: move to the owner's Trash, or destroy
 * outright when the message already sits in Trash or `permanent` is set.
 */
export async function deleteUnifiedEmails(
  emails: UnifiedEmail[],
  opts: { permanent?: boolean; markRead?: boolean } = {},
): Promise<{ destroyed: number; trashed: number }> {
  let destroyed = 0;
  let trashed = 0;
  for (const g of groupByOwner(emails).values()) {
    const entry = await entryFor(g.accountId);
    const mailboxes = await mailboxesFor(entry, g.jmapAccountId);
    const trash = findByRole(mailboxes, 'trash');
    const toDestroy = g.emails.filter((e) => opts.permanent || !trash || !!(trash && e.mailboxIds?.[trash.id]));
    const toTrash = g.emails.filter((e) => !toDestroy.includes(e));
    if (toDestroy.length > 0 && !trash && !opts.permanent) {
      throw new Error('No Trash folder in this account');
    }
    if (toDestroy.length > 0) {
      await emailSet(g.accountId, g.jmapAccountId, {}, toDestroy.map((e) => e.id));
      destroyed += toDestroy.length;
    }
    if (toTrash.length > 0 && trash) {
      await moveUnifiedEmails(toTrash, 'trash', { markRead: opts.markRead });
      trashed += toTrash.length;
    }
  }
  return { destroyed, trashed };
}

/** Whether a message sits in its account's Trash (drives the permanent-delete confirm). */
export function isInUnifiedTrash(email: UnifiedEmail): boolean {
  const entry = entries.get(email.sourceAccountId);
  const list = entry?.mailboxes.get(email.jmapAccountId)?.list ?? [];
  const trash = findByRole(list, 'trash');
  return !!trash && !!email.mailboxIds?.[trash.id];
}
