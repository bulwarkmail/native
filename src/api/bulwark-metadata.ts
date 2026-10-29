// Bulwark's own data in JMAP Metadata (RFC draft, urn:ietf:params:jmap:metadata)
// of an account's Inbox: the shared tag definitions of a group account
// (namespace `org.bulwarkmail.tags`). Port of the reading half of the
// webmail's lib/jmap/bulwark-metadata.ts and client.getBulwarkMetadata.
//
// Stalwart 1.0.0 serves Metadata; 0.16 advertises none, and a pre-release
// 1.0 build advertised it but dropped the connection on a Mailbox/get that
// selects it (42751a6b). So this is the only module that asks for it: only
// for an account whose capabilities offer vendor namespaces on mailboxes,
// in a request of its own, and any failure pauses that account for ten
// minutes. Every other Mailbox/get keeps its explicit property list.

import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';

export const METADATA_CAPABILITY = 'urn:ietf:params:jmap:metadata';
export const BULWARK_NAMESPACE = 'org.bulwarkmail';

const PAUSE_AFTER_FAILURE_MS = 10 * 60_000;

/**
 * Whether the account's capabilities offer vendor-namespaced metadata on
 * mailboxes. Says nothing about whether the server really implements it.
 */
export function advertisesMailboxMetadata(accountCapabilities: Record<string, unknown> | undefined): boolean {
  const cap = accountCapabilities?.[METADATA_CAPABILITY] as
    | { dataTypes?: Record<string, { supportsVendorNamespaces?: boolean }> }
    | undefined;
  return cap?.dataTypes?.Mailbox?.supportsVendorNamespaces === true;
}

/** Bulwark's entries of a `metadata` object, by key (`tags`, `template.<id>`). */
export function bulwarkEntries(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const prefix = `${BULWARK_NAMESPACE}.`;
  const out: Record<string, unknown> = {};
  for (const [namespace, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (namespace.startsWith(prefix)) out[namespace.slice(prefix.length)] = value;
  }
  return out;
}

// Accounts whose last read failed, by server and account, with when.
const failedAt = new Map<string, number>();
const pauseKey = (accountId: string) => `${jmapClient.serverUrl ?? ''}|${accountId}`;

/** Whether the app may ask this account for its Inbox metadata now. */
export function supportsBulwarkMetadata(accountId: string): boolean {
  const failed = failedAt.get(pauseKey(accountId));
  if (failed !== undefined && Date.now() - failed < PAUSE_AFTER_FAILURE_MS) return false;
  const account = jmapClient.currentSession?.accounts?.[accountId] as
    | { accountCapabilities?: Record<string, unknown> }
    | undefined;
  return advertisesMailboxMetadata(account?.accountCapabilities);
}

/**
 * Bulwark's shared metadata entries of the account's Inbox, by key. Null
 * when the account has none to offer (0.16) or the read failed; no request
 * goes out for an account that doesn't advertise Metadata.
 */
export async function getBulwarkMetadata(accountId: string): Promise<Record<string, unknown> | null> {
  if (!supportsBulwarkMetadata(accountId)) return null;
  const property = 'metadata';
  try {
    const res = await jmapClient.request([
      ['Mailbox/query', { accountId, filter: { role: 'inbox' } }, 'q'],
      ['Mailbox/get', {
        accountId,
        '#ids': { resultOf: 'q', name: 'Mailbox/query', path: '/ids' },
        properties: ['id', property],
      }, 'g'],
    ], [CAPABILITIES.CORE, CAPABILITIES.MAIL, METADATA_CAPABILITY]);
    const get = res.methodResponses?.find((r) => r[0] === 'Mailbox/get');
    const inbox = (get?.[1] as { list?: Array<Record<string, unknown>> } | undefined)?.list?.[0];
    // An answer without the property is a server that doesn't keep it,
    // never "every entry was removed".
    if (!inbox || !(property in inbox)) throw new Error('No Inbox metadata in the answer');
    failedAt.delete(pauseKey(accountId));
    return bulwarkEntries(inbox[property]);
  } catch (err) {
    console.warn('[bulwark-metadata] unavailable for account', accountId, err);
    failedAt.set(pauseKey(accountId), Date.now());
    return null;
  }
}

/** Forget the failure pauses (sign-out, tests). */
export function resetBulwarkMetadataPauses(): void {
  failedAt.clear();
}
