import { jmapClient } from './jmap-client';
import { assertSetResult, requireMethodResult } from './jmap-result';
import { CAPABILITIES } from './types';
import type { Identity, JMAPMethodCall } from './types';
import { sanitizeDisplayName } from '../lib/rfc5322-mailbox';

const USING = [CAPABILITIES.CORE, CAPABILITIES.SUBMISSION];

// A display name that carries an address or a line break produces a malformed
// `From:` on every message sent with the identity (#672); reduce it to the
// bare name before it reaches the server.
function sanitizeIdentityPatch(identity: Partial<Identity>): Partial<Identity> {
  if (typeof identity.name !== 'string') return identity;
  return { ...identity, name: sanitizeDisplayName(identity.name) };
}

export async function getIdentities(accountIdOverride?: string): Promise<Identity[]> {
  const accountId = accountIdOverride ?? jmapClient.accountId;
  const res = await jmapClient.request([['Identity/get', { accountId }, '0']], USING);
  const body = requireMethodResult<{ list?: Identity[] }>(res, '0', 'Identity/get');
  return body.list ?? [];
}

export async function createIdentity(
  identity: Partial<Identity>,
): Promise<Identity> {
  const accountId = jmapClient.accountId;
  const cid = 'new-identity';
  const res = await jmapClient.request(
    [['Identity/set', { accountId, create: { [cid]: sanitizeIdentityPatch(identity) } }, '0']],
    USING,
  );
  const body = requireMethodResult(res, '0', 'Identity/set');
  assertSetResult(body, [cid], 'identity');
  const created = body.created?.[cid] as Partial<Identity> | undefined;
  if (!created?.id) throw new Error('Identity/set returned no id');
  // The create echo carries only server-set properties; re-read the full
  // object so the caller gets name/email/signature back.
  const all = await getIdentities();
  return all.find((i) => i.id === created.id) ?? ({ ...identity, ...created } as Identity);
}

export async function updateIdentity(
  id: string,
  changes: Partial<Identity>,
): Promise<void> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['Identity/set', { accountId, update: { [id]: sanitizeIdentityPatch(changes) } }, '0']],
    USING,
  );
  assertSetResult(requireMethodResult(res, '0', 'Identity/set'), [id], 'identity');
}

export async function deleteIdentity(id: string): Promise<void> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['Identity/set', { accountId, destroy: [id] }, '0']],
    USING,
  );
  assertSetResult(requireMethodResult(res, '0', 'Identity/set'), [id], 'identity');
}

/** An address the identity matches exactly. */
function identityEmailMatchesExactly(identityEmail: string | undefined, from: string): boolean {
  return !!identityEmail && identityEmail.toLowerCase() === from;
}

/** An identity address `from` is a sub-address of (team+tag@ for team@, with the common "+" / "-" delimiters). */
function identityEmailIsSubAddressOf(identityEmail: string | undefined, from: string): boolean {
  if (!identityEmail) return false;
  const [idLocal, idDomain] = identityEmail.toLowerCase().split('@');
  const [fromLocal, fromDomain] = from.split('@');
  if (!idDomain || !fromDomain || idDomain !== fromDomain || idLocal === '*') return false;
  return fromLocal.startsWith(`${idLocal}+`) || fromLocal.startsWith(`${idLocal}-`);
}

/** A wildcard identity for the domain of `from` (RFC 8621 §6, "*@example.com"). */
function identityEmailIsWildcardFor(identityEmail: string | undefined, from: string): boolean {
  if (!identityEmail) return false;
  const [idLocal, idDomain] = identityEmail.toLowerCase().split('@');
  return idLocal === '*' && !!idDomain && idDomain === from.split('@')[1];
}

const IDENTITY_MATCHERS = [identityEmailMatchesExactly, identityEmailIsSubAddressOf, identityEmailIsWildcardFor];

// Draft autosave resolves on every save; identities rarely change.
let sendIdentitiesCache: { key: string; byAccount: Array<[string, Identity[]]>; expires: number } | null = null;

/** Forget the identities resolveSendAccountId read (tests, a switch of logins). */
export function resetSendIdentities(): void {
  sendIdentitiesCache = null;
}

/**
 * The identities of every account that can send, the delegated (group or
 * shared) ones first and the login's own last. Null when there is no
 * delegated account, or the identities can't be read.
 */
async function identitiesOfSendAccounts(): Promise<Array<[string, Identity[]]> | null> {
  const own = jmapClient.accountId;
  const delegated = jmapClient.getSubmissionAccountIds().filter((id) => id !== own);
  if (delegated.length === 0) return null;
  const candidates = [...delegated, own];
  // The server and login are part of the key: account ids repeat across them.
  const key = [jmapClient.serverUrl, jmapClient.username, ...candidates].join('\u0000');
  if (sendIdentitiesCache && sendIdentitiesCache.key === key && sendIdentitiesCache.expires > Date.now()) {
    return sendIdentitiesCache.byAccount;
  }
  try {
    const res = await jmapClient.request(
      candidates.map((accountId, i) => ['Identity/get', { accountId }, String(i)] as JMAPMethodCall),
      USING,
    );
    const byAccount = candidates.map((accountId, i): [string, Identity[]] => {
      const [name, body] = res.methodResponses.find(([, , callId]) => callId === String(i)) ?? [];
      return [accountId, name === 'Identity/get' ? ((body?.list ?? []) as Identity[]) : []];
    });
    sendIdentitiesCache = { key, byAccount, expires: Date.now() + 60_000 };
    return byAccount;
  } catch (err) {
    console.warn('[identity] could not read the identities to pick the sending account', err);
    return null;
  }
}

/**
 * The account a message sent From `fromEmail` belongs to: where it is
 * created, submitted and filed in Sent (webmail resolveSendAccountId,
 * #1090). Stalwart lists a group's send-as identity among the member's own
 * identities too, so going by the identity list alone sent the message
 * through the member's account and filed its Sent copy there.
 *
 * Order: an account named exactly `fromEmail`; then an account that owns an
 * identity for the address - exact, then sub-address, then wildcard, and a
 * delegated (group/shared) account before the own one, since the own one
 * may merely mirror the group's identity; else the own account. A
 * sub-address of the member's own address stays theirs even when a shared
 * catch-all account has a wildcard identity for the domain.
 */
export async function resolveSendAccountId(fromEmail?: string): Promise<string> {
  const own = jmapClient.accountId;
  const from = fromEmail?.trim().toLowerCase();
  if (!from) return own;
  const accounts = jmapClient.currentSession?.accounts ?? {};
  const named = Object.keys(accounts).find((id) => accounts[id]?.name?.toLowerCase() === from);
  if (named) return named;
  const byAccount = await identitiesOfSendAccounts();
  if (!byAccount) return own;
  for (const matches of IDENTITY_MATCHERS) {
    const hit = byAccount.find(([, list]) => list.some((identity) => matches(identity.email, from)));
    if (hit) return hit[0];
  }
  return own;
}

/**
 * The identity of `accountId` a message From `fromEmail` is submitted
 * through: identity ids are per account, so the one the composer picked
 * from the login's list names nothing (or another identity) in a group
 * account. Undefined when the account has none for the address.
 */
export async function sendIdentityIn(accountId: string, fromEmail: string): Promise<Identity | undefined> {
  const from = fromEmail.trim().toLowerCase();
  const byAccount = await identitiesOfSendAccounts();
  const list = byAccount?.find(([id]) => id === accountId)?.[1] ?? await getIdentities(accountId);
  for (const matches of IDENTITY_MATCHERS) {
    const hit = list.find((identity) => matches(identity.email, from));
    if (hit) return hit;
  }
  return undefined;
}
