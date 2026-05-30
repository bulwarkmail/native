import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import { secureFetch } from '../lib/client-cert';
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
export function getSieveAccountId(): string {
  const session = jmapClient.currentSession;
  return session?.primaryAccounts?.[CAPABILITIES.SIEVE] ?? jmapClient.accountId;
}

export function isSieveSupported(): boolean {
  const session = jmapClient.currentSession;
  if (!session) return false;
  return CAPABILITIES.SIEVE in (session.capabilities ?? {});
}

export function getSieveCapabilities(): SieveCapabilities | null {
  const session = jmapClient.currentSession;
  if (!session) return null;
  const info = session.accounts?.[getSieveAccountId()];
  const caps = info?.accountCapabilities?.[CAPABILITIES.SIEVE];
  return (caps as SieveCapabilities) ?? null;
}

export async function getSieveScripts(): Promise<SieveScript[]> {
  const res = await jmapClient.request(
    [['SieveScript/get', { accountId: getSieveAccountId() }, '0']],
    SIEVE_USING,
  );
  const resp = res.methodResponses?.[0];
  if (resp && resp[0] === 'SieveScript/get') {
    return ((resp[1] as { list?: SieveScript[] }).list ?? []) as SieveScript[];
  }
  throw new Error('Failed to fetch Sieve scripts');
}

export async function getSieveScriptContent(blobId: string): Promise<string> {
  const session = requireSession();
  const url = session.downloadUrl
    .replace('{accountId}', encodeURIComponent(getSieveAccountId()))
    .replace('{blobId}', encodeURIComponent(blobId))
    .replace('{name}', encodeURIComponent('script.sieve'))
    .replace('{type}', encodeURIComponent('application/sieve'));

  const response = await secureFetch(url, {
    headers: { Authorization: jmapClient.authHeader },
  });
  if (!response.ok) throw new Error(`Failed to download script: ${response.status}`);
  return response.text();
}

async function uploadSieveBlob(content: string): Promise<string> {
  const session = requireSession();
  const uploadUrl = session.uploadUrl.replace(
    '{accountId}',
    encodeURIComponent(getSieveAccountId()),
  );

  const response = await secureFetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/sieve',
      Authorization: jmapClient.authHeader,
    },
    // A plain string body is encoded as UTF-8 by RN's fetch. (api/blob.ts uses
    // an ArrayBuffer only because typed-array bodies get stringified there.)
    body: content,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Failed to upload Sieve script: ${response.status}${detail ? ` ${detail.substring(0, 200)}` : ''}`);
  }

  const raw = (await response.json()) as Record<string, unknown>;
  const direct = raw as { blobId?: string };
  if (typeof direct.blobId === 'string') return direct.blobId;
  const nested = raw[getSieveAccountId()] as { blobId?: string } | undefined;
  if (nested?.blobId) return nested.blobId;
  throw new Error('Upload succeeded but response did not include a blobId');
}

export async function createSieveScript(
  name: string,
  content: string,
  activate = true,
): Promise<SieveScript> {
  const blobId = await uploadSieveBlob(content);
  const accountId = getSieveAccountId();

  const setArgs: Record<string, unknown> = {
    accountId,
    create: { 'new-script': { name, blobId } },
  };
  if (activate) setArgs.onSuccessActivateScript = '#new-script';

  const res = await jmapClient.request([['SieveScript/set', setArgs, '0']], SIEVE_USING);
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
      const scripts = await getSieveScripts();
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
): Promise<void> {
  const blobId = await uploadSieveBlob(content);
  const accountId = getSieveAccountId();

  const setArgs: Record<string, unknown> = {
    accountId,
    update: { [scriptId]: { blobId } },
  };
  if (activate) setArgs.onSuccessActivateScript = scriptId;

  const res = await jmapClient.request([['SieveScript/set', setArgs, '0']], SIEVE_USING);
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

export async function deleteSieveScript(scriptId: string): Promise<void> {
  const res = await jmapClient.request(
    [['SieveScript/set', { accountId: getSieveAccountId(), destroy: [scriptId] }, '0']],
    SIEVE_USING,
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
): Promise<{ isValid: boolean; errors?: string[] }> {
  const blobId = await uploadSieveBlob(content);
  const res = await jmapClient.request(
    [['SieveScript/validate', { accountId: getSieveAccountId(), blobId }, '0']],
    SIEVE_USING,
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
