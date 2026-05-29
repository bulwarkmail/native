import { CAPABILITIES } from './types';
import type { Email, JMAPSession, JMAPMethodCall, Mailbox } from './types';
import { jmapClient, type StoredCredentials } from './jmap-client';
import { secureFetch } from '../lib/client-cert';
import { refreshOAuthAccessToken, type OAuthTokens } from '../lib/oauth';

// Aggregated inbox across every logged-in account. Because the JMAP client is
// a single-account singleton (one live session at a time), we fetch each
// account's inbox "detached" here — reading its stored credentials directly and
// issuing requests against its own API URL — so the active account's live
// session is never disturbed.

const EMAIL_LIST_PROPERTIES = [
  'id', 'threadId', 'mailboxIds', 'keywords', 'size',
  'receivedAt', 'from', 'to', 'subject', 'preview', 'hasAttachment',
];

const TOKEN_REFRESH_LEEWAY_MS = 60_000;

export interface UnifiedEmail extends Email {
  /** Registry account id this message belongs to (not the JMAP account id). */
  sourceAccountId: string;
}

export interface UnifiedInboxResult {
  emails: UnifiedEmail[];
  /** accountId → error message for accounts that could not be fetched. */
  errors: Record<string, string>;
}

function authHeaderFor(creds: StoredCredentials): string {
  if (creds.accessToken) return `Bearer ${creds.accessToken}`;
  return `Basic ${btoa(`${creds.username}:${creds.password}`)}`;
}

function originOf(url: string): string | null {
  const m = url.match(/^(https?:\/\/[^/?#]+)/i);
  return m ? m[1] : null;
}

// Same intent as JMAPClient.rewriteSessionUrls: point the advertised apiUrl at
// the origin we actually connected to (servers often self-report unreachable
// container-internal hosts).
function rewriteApiUrl(session: JMAPSession, serverUrl: string): string {
  const serverOrigin = originOf(serverUrl);
  const apiOrigin = originOf(session.apiUrl);
  if (!apiOrigin || !serverOrigin || apiOrigin === serverOrigin) return session.apiUrl;
  return serverOrigin + session.apiUrl.slice(apiOrigin.length);
}

function resolveJmapAccountId(session: JMAPSession): string | null {
  return (
    session.primaryAccounts?.[CAPABILITIES.MAIL] ||
    session.primaryAccounts?.[CAPABILITIES.CORE] ||
    Object.keys(session.accounts ?? {})[0] ||
    null
  );
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
    await jmapClient.setStoredCredentials(accountId, updated);
    return updated;
  } catch {
    // Fall back to the existing (possibly expired) token; the request will
    // surface a 401 which we report as an error for this account.
    return creds;
  }
}

async function jmapPost(
  apiUrl: string,
  authHeader: string,
  methodCalls: JMAPMethodCall[],
  using: string[],
): Promise<Array<[string, Record<string, any>, string]>> {
  const response = await secureFetch(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader },
    body: JSON.stringify({ using, methodCalls }),
  });
  if (response.status === 401) throw new Error('Session expired');
  if (!response.ok) throw new Error(`JMAP request failed: ${response.status}`);
  const body = await response.json();
  return body.methodResponses ?? [];
}

async function fetchInboxForAccount(
  accountId: string,
  limit: number,
): Promise<UnifiedEmail[]> {
  let creds = await jmapClient.getStoredCredentials(accountId);
  if (!creds) throw new Error('No stored credentials');
  creds = await ensureFreshCredentials(accountId, creds);

  const baseUrl = creds.serverUrl.replace(/\/+$/, '');
  const authHeader = authHeaderFor(creds);

  // Session discovery.
  const sessionRes = await secureFetch(`${baseUrl}/.well-known/jmap`, {
    headers: { Authorization: authHeader, Accept: 'application/json' },
  });
  if (sessionRes.status === 401) throw new Error('Session expired');
  if (!sessionRes.ok) throw new Error(`Session discovery failed: ${sessionRes.status}`);
  const session = (await sessionRes.json()) as JMAPSession;
  const apiUrl = rewriteApiUrl(session, baseUrl);
  const jmapAccountId = resolveJmapAccountId(session);
  if (!jmapAccountId) throw new Error('No mail account in session');

  // Find the inbox mailbox.
  const mailboxResponses = await jmapPost(
    apiUrl,
    authHeader,
    [['Mailbox/get', { accountId: jmapAccountId, properties: ['id', 'role', 'name'] }, '0']],
    [CAPABILITIES.CORE, CAPABILITIES.MAIL],
  );
  const mailboxes = (mailboxResponses[0]?.[1]?.list as Mailbox[]) ?? [];
  const inbox = mailboxes.find((m) => m.role === 'inbox') ?? mailboxes[0];
  if (!inbox) return [];

  // Query + fetch the most recent messages.
  const queryResponses = await jmapPost(
    apiUrl,
    authHeader,
    [['Email/query', {
      accountId: jmapAccountId,
      filter: { inMailbox: inbox.id },
      sort: [{ property: 'receivedAt', isAscending: false }],
      limit,
    }, '0']],
    [CAPABILITIES.CORE, CAPABILITIES.MAIL],
  );
  const ids = (queryResponses[0]?.[1]?.ids as string[]) ?? [];
  if (ids.length === 0) return [];

  const getResponses = await jmapPost(
    apiUrl,
    authHeader,
    [['Email/get', { accountId: jmapAccountId, ids, properties: EMAIL_LIST_PROPERTIES }, '0']],
    [CAPABILITIES.CORE, CAPABILITIES.MAIL],
  );
  const list = (getResponses[0]?.[1]?.list as Email[]) ?? [];
  return list.map((e) => ({ ...e, sourceAccountId: accountId }));
}

export async function fetchUnifiedInbox(
  accountIds: string[],
  perAccountLimit = 25,
): Promise<UnifiedInboxResult> {
  const errors: Record<string, string> = {};
  const settled = await Promise.all(
    accountIds.map(async (id) => {
      try {
        return await fetchInboxForAccount(id, perAccountLimit);
      } catch (err) {
        errors[id] = err instanceof Error ? err.message : 'Failed to load';
        return [] as UnifiedEmail[];
      }
    }),
  );
  const emails = settled
    .flat()
    .sort((a, b) => new Date(b.receivedAt).getTime() - new Date(a.receivedAt).getTime());
  return { emails, errors };
}
