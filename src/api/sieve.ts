import { jmapClient } from './jmap-client';
import type { AccountRef, OpScope } from './op-scope';
import { CAPABILITIES, type JMAPAccountInfo } from './types';
import { secureFetch } from '../lib/client-cert';
import { observeServerFetch } from '../lib/server-reachability';
import type { SieveScript, SieveCapabilities } from '../lib/sieve/types';

// JMAP Sieve (RFC 9661) bindings. Mirrors the webmail JMAPClient Sieve methods
// but follows the mobile convention of a functional api/* module driving the
// shared `jmapClient` singleton (see api/vacation.ts, api/blob.ts).

const SIEVE_USING = [CAPABILITIES.CORE, CAPABILITIES.SIEVE];

function requireSession() {
  const session = jmapClient.currentSession;
  if (!session) throw new Error('Not connected');
  return session;
}

// Sieve lives on its own JMAP account (RFC 9661). Fall back to the mail account
// when the server does not advertise a dedicated one (Stalwart uses the same id).
// Every call below takes an optional account so the filters of a shared/group
// account can be managed too (webmail: "Shared with me" in Account settings).
export function getSieveAccountId(): string {
  const session = jmapClient.currentSession;
  return session?.primaryAccounts?.[CAPABILITIES.SIEVE] ?? jmapClient.accountId;
}

/**
 * The scope a Sieve call acts on: the one given, or the Sieve account named
 * (undefined: the user's own) on the live connection. A call with a scope
 * stops with `StaleLoadError` once its connection is gone, before sending.
 */
export function sieveScope(account?: AccountRef): OpScope {
  if (typeof account === 'object' && account !== null) return account;
  return { gen: jmapClient.connectionGen, accountId: account ?? getSieveAccountId() };
}

/**
 * Sieve account `accountId` (undefined: the user's own) on the connection of
 * `at`. The user's own Sieve account need not be the mail account `at` names.
 */
export function sieveScopeIn(at: OpScope, accountId: string | undefined): OpScope {
  return { gen: at.gen, accountId: accountId ?? getSieveAccountId() };
}

// Gate on the ACCOUNT capability, not only the server-wide session capability:
// RFC 9661 advertises Sieve per account, and an account without Sieve rights
// fails every SieveScript call. Stalwart doesn't always advertise capabilities
// on shared/group accounts, so treat non-personal accounts as capable - the
// rule the webmail's getSharedAccounts() applies. A server that populates no
// accountCapabilities at all keeps the session-wide answer.
export function accountSupportsSieve(
  account: JMAPAccountInfo | undefined,
  sessionCapabilities: Record<string, unknown> | undefined,
): boolean {
  if (!sessionCapabilities || !(CAPABILITIES.SIEVE in sessionCapabilities)) return false;
  if (!account) return false;
  if (!account.isPersonal || !account.accountCapabilities) return true;
  return CAPABILITIES.SIEVE in account.accountCapabilities;
}

export function isSieveSupported(accountId?: string): boolean {
  const session = jmapClient.currentSession;
  if (!session) return false;
  return accountSupportsSieve(
    session.accounts?.[accountId ?? getSieveAccountId()],
    session.capabilities,
  );
}

/**
 * The Sieve capabilities of an account. A shared/group account Stalwart lists
 * without its Sieve capabilities (see accountSupportsSieve) runs on the same
 * server as the user's own Sieve account, so it takes that one's: without
 * them the filters script would be written without what the server has (the
 * spam guard, folder ids, the vacation include). A scope from a connection
 * that is gone throws `StaleLoadError`.
 */
export function getSieveCapabilities(account?: AccountRef): SieveCapabilities | null {
  if (typeof account === 'object' && account !== null) jmapClient.assertCurrent(account.gen);
  const session = jmapClient.currentSession;
  if (!session) return null;
  const accountId = sieveScope(account).accountId;
  const info = session.accounts?.[accountId];
  const caps = info?.accountCapabilities?.[CAPABILITIES.SIEVE] as SieveCapabilities | undefined;
  if (caps) return caps;
  const own = getSieveAccountId();
  if (info && !info.isPersonal && accountId !== own) {
    const ownCaps = session.accounts?.[own]?.accountCapabilities?.[CAPABILITIES.SIEVE];
    return (ownCaps as SieveCapabilities) ?? null;
  }
  return null;
}

export async function getSieveScripts(account?: AccountRef): Promise<SieveScript[]> {
  const { gen, accountId } = sieveScope(account);
  const res = await jmapClient.request(
    [['SieveScript/get', { accountId }, '0']],
    SIEVE_USING,
    { gen },
  );
  const resp = res.methodResponses?.[0];
  if (resp && resp[0] === 'SieveScript/get') {
    return ((resp[1] as { list?: SieveScript[] }).list ?? []) as SieveScript[];
  }
  throw new Error('Failed to fetch Sieve scripts');
}

export async function getSieveScriptContent(
  blobId: string,
  account?: AccountRef,
): Promise<string> {
  const { gen, accountId } = sieveScope(account);
  // The URL and header of the scope's own connection, which must still have
  // the account (the same check a method call gets).
  jmapClient.assertAccountInSession(gen, accountId);
  const session = requireSession();
  // Blobs are scoped per account, so a shared account's script is downloaded
  // against that account's id.
  const url = session.downloadUrl
    .replace('{accountId}', encodeURIComponent(accountId))
    .replace('{blobId}', encodeURIComponent(blobId))
    .replace('{name}', encodeURIComponent('script.sieve'))
    .replace('{type}', encodeURIComponent('application/sieve'));

  const response = await observeServerFetch(secureFetch(url, {
    headers: { Authorization: jmapClient.authHeaderFor(gen) },
  }), undefined, () => jmapClient.isCurrent(gen));
  if (!response.ok) throw new Error(`Failed to download script: ${response.status}`);
  return response.text();
}

async function uploadSieveBlob(content: string, at: OpScope): Promise<string> {
  const { gen, accountId } = at;
  jmapClient.assertAccountInSession(gen, accountId);
  const session = requireSession();
  const uploadUrl = session.uploadUrl.replace(
    '{accountId}',
    encodeURIComponent(accountId),
  );

  const response = await observeServerFetch(secureFetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sieve',
      Authorization: jmapClient.authHeaderFor(gen),
    },
    // A plain string body is encoded as UTF-8 by RN's fetch. (api/blob.ts uses
    // an ArrayBuffer only because typed-array bodies get stringified there.)
    body: content,
  }), undefined, () => jmapClient.isCurrent(gen));

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Failed to upload Sieve script: ${response.status}${detail ? ` ${detail.substring(0, 200)}` : ''}`);
  }

  const raw = (await response.json()) as Record<string, unknown>;
  const direct = raw as { blobId?: string };
  if (typeof direct.blobId === 'string') return direct.blobId;
  const nested = raw[accountId] as { blobId?: string } | undefined;
  if (nested?.blobId) return nested.blobId;
  throw new Error('Upload succeeded but response did not include a blobId');
}

export async function createSieveScript(
  name: string,
  content: string,
  activate = true,
  account?: AccountRef,
): Promise<SieveScript> {
  const at = sieveScope(account);
  const { gen, accountId } = at;
  const blobId = await uploadSieveBlob(content, at);

  const setArgs: Record<string, unknown> = {
    accountId,
    create: { 'new-script': { name, blobId } },
  };
  if (activate) setArgs.onSuccessActivateScript = '#new-script';

  const res = await jmapClient.request([['SieveScript/set', setArgs, '0']], SIEVE_USING, { gen });
  const resp = res.methodResponses?.[0];
  if (resp && resp[0] === 'SieveScript/set') {
    const result = resp[1] as {
      notCreated?: Record<string, { description?: string }>;
      created?: Record<string, { id?: string }>;
    };
    if (result.notCreated?.['new-script']) {
      throw new Error(result.notCreated['new-script'].description ?? 'Failed to create Sieve script');
    }
    const createdId = result.created?.['new-script']?.id;
    if (createdId) {
      const scripts = await getSieveScripts(at);
      const script = scripts.find((s) => s.id === createdId);
      if (script) return script;
    }
  }
  throw new Error('Failed to create Sieve script');
}

export async function updateSieveScript(
  scriptId: string,
  content: string,
  activate = true,
  account?: AccountRef,
): Promise<void> {
  const at = sieveScope(account);
  const { gen, accountId } = at;
  const blobId = await uploadSieveBlob(content, at);

  const setArgs: Record<string, unknown> = {
    accountId,
    update: { [scriptId]: { blobId } },
  };
  if (activate) setArgs.onSuccessActivateScript = scriptId;

  const res = await jmapClient.request([['SieveScript/set', setArgs, '0']], SIEVE_USING, { gen });
  const resp = res.methodResponses?.[0];
  if (resp && resp[0] === 'SieveScript/set') {
    const result = resp[1] as { notUpdated?: Record<string, { description?: string }> };
    if (result.notUpdated?.[scriptId]) {
      throw new Error(result.notUpdated[scriptId].description ?? 'Failed to update Sieve script');
    }
    return;
  }
  throw new Error('Failed to update Sieve script');
}

async function setActiveScript(args: Record<string, unknown>, account: AccountRef, what: string): Promise<void> {
  const { gen, accountId } = sieveScope(account);
  const res = await jmapClient.request(
    [['SieveScript/set', { accountId, ...args }, '0']],
    SIEVE_USING,
    { gen },
  );
  const resp = res.methodResponses?.[0];
  if (resp && resp[0] === 'SieveScript/set') return;
  const detail = (resp?.[1] as { description?: string } | undefined)?.description;
  throw new Error(detail ?? `Failed to ${what} Sieve script`);
}

/** Make `scriptId` the account's active script (switches off the current one). */
export function activateSieveScript(
  scriptId: string,
  account?: AccountRef,
): Promise<void> {
  return setActiveScript({ onSuccessActivateScript: scriptId }, account, 'activate');
}

/** Switch the account's active script off, leaving no script active (RFC 9661 §2.2). */
export function deactivateSieveScript(account?: AccountRef): Promise<void> {
  return setActiveScript({ onSuccessDeactivateScript: true }, account, 'deactivate');
}

export async function deleteSieveScript(
  scriptId: string,
  account?: AccountRef,
): Promise<void> {
  const { gen, accountId } = sieveScope(account);
  const res = await jmapClient.request(
    [['SieveScript/set', { accountId, destroy: [scriptId] }, '0']],
    SIEVE_USING,
    { gen },
  );
  const resp = res.methodResponses?.[0];
  if (resp && resp[0] === 'SieveScript/set') {
    const result = resp[1] as { notDestroyed?: Record<string, { description?: string }> };
    if (result.notDestroyed?.[scriptId]) {
      throw new Error(result.notDestroyed[scriptId].description ?? 'Failed to delete Sieve script');
    }
    return;
  }
  throw new Error('Failed to delete Sieve script');
}

export async function validateSieveScript(
  content: string,
  account?: AccountRef,
): Promise<{ isValid: boolean; errors?: string[] }> {
  const at = sieveScope(account);
  const blobId = await uploadSieveBlob(content, at);
  const res = await jmapClient.request(
    [['SieveScript/validate', { accountId: at.accountId, blobId }, '0']],
    SIEVE_USING,
    { gen: at.gen },
  );
  const resp = res.methodResponses?.[0];
  if (resp && resp[0] === 'SieveScript/validate') {
    const result = resp[1] as { error?: { description?: string } };
    if (result.error) {
      return { isValid: false, errors: [result.error.description ?? 'Validation failed'] };
    }
    return { isValid: true };
  }
  if (resp && typeof resp[0] === 'string' && resp[0].endsWith('error')) {
    const error = resp[1] as { description?: string };
    return { isValid: false, errors: [error.description ?? 'Validation failed'] };
  }
  return { isValid: false, errors: ['Unexpected validation response'] };
}
