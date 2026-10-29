// Bulwark's own data in JMAP Metadata (RFC draft, urn:ietf:params:jmap:metadata)
// of an account's Inbox: personal templates in the user's own account, team
// templates in a group account (webmail lib/jmap/bulwark-metadata.ts).
//
// What Stalwart does: 1.0.0 serves it (seen live 2026-10-29: Mailbox/get and
// Mailbox/set with `metadata/<namespace>` pointers on the Inbox, at most
// 8 KB per namespace, "Metadata value size … exceeds the maximum of 8192
// bytes" above that). Vendor namespaces need a dot, so every item gets one
// of its own: `org.bulwarkmail.<key>`. 0.16 has no metadata and refuses the
// capability in `using` (notRequest); an account that doesn't advertise it
// is never asked. A pre-release 1.0 build advertised it but dropped the
// connection on such a request, so the calls go in requests of their own
// and any failure pauses that account for ten minutes.
//
// This is the only module that names the Metadata capability or property
// (src/api/__tests__/jmap-metadata-requests.test.ts).

import { jmapClient } from './jmap-client';
import { CAPABILITIES, type JMAPMethodCall } from './types';

const METADATA_CAPABILITY = 'urn:ietf:params:jmap:metadata';
export const BULWARK_NAMESPACE = 'org.bulwarkmail';
/** Largest value Stalwart's default config takes in one namespace. */
export const MAX_METADATA_ENTRY_BYTES = 8192;

const KEY_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)*$/;
const USING = [CAPABILITIES.CORE, CAPABILITIES.MAIL, METADATA_CAPABILITY];
const PAUSE_MS = 10 * 60_000;

export class MetadataTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetadataTooLargeError';
  }
}

/** The server refused a metadata change; `type` is its SetError type. */
export class MetadataRefusedError extends Error {
  constructor(readonly type: string, message: string) {
    super(message);
    this.name = 'MetadataRefusedError';
  }
}

export class MetadataUnsupportedError extends Error {
  constructor(message = 'This server keeps no metadata for Bulwark') {
    super(message);
    this.name = 'MetadataUnsupportedError';
  }
}

/** `templates`, `template.<id>`: lowercase, digits, dashes, dot-separated. */
export function isValidMetadataKey(key: string): boolean {
  return key.length <= 120 && KEY_RE.test(key);
}

function namespaceFor(key: string): string {
  if (!isValidMetadataKey(key)) throw new Error(`Invalid metadata key: ${key}`);
  return `${BULWARK_NAMESPACE}.${key}`;
}

/** The size Stalwart counts for a value: its JSON in UTF-8. */
export function metadataValueBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/** Bulwark's entries of a metadata object, by key. */
export function bulwarkEntries(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const prefix = `${BULWARK_NAMESPACE}.`;
  const out: Record<string, unknown> = {};
  for (const [namespace, value] of Object.entries(metadata as Record<string, unknown>)) {
    if (namespace.startsWith(prefix)) out[namespace.slice(prefix.length)] = value;
  }
  return out;
}

// Account ids repeat across servers and logins.
const keyOf = (accountId: string) => `${jmapClient.serverUrl ?? ''}\u0000${jmapClient.username ?? ''}\u0000${accountId}`;
const failedAt = new Map<string, number>();
const inboxIds = new Map<string, string>();

/** Forget paused accounts and Inbox ids (tests). */
export function resetBulwarkMetadata(): void {
  failedAt.clear();
  inboxIds.clear();
}

/** Whether the account advertises vendor metadata on mailboxes, whatever its last request did. */
export function advertisesBulwarkMetadata(accountId: string): boolean {
  const caps = jmapClient.currentSession?.accounts?.[accountId]?.accountCapabilities as Record<string, unknown> | undefined;
  const cap = caps?.[METADATA_CAPABILITY] as
    | { dataTypes?: Record<string, { supportsVendorNamespaces?: boolean }> }
    | undefined;
  return cap?.dataTypes?.Mailbox?.supportsVendorNamespaces === true;
}

/** Whether Bulwark may keep data in this account's Inbox metadata now. */
export function supportsBulwarkMetadata(accountId: string): boolean {
  const at = failedAt.get(keyOf(accountId));
  if (at !== undefined && Date.now() - at < PAUSE_MS) return false;
  return advertisesBulwarkMetadata(accountId);
}

/**
 * Bulwark's metadata entries of the account's Inbox, by key. Null when the
 * account has no usable metadata; a failure pauses the account.
 */
export async function getBulwarkMetadata(accountId: string): Promise<Record<string, unknown> | null> {
  if (!supportsBulwarkMetadata(accountId)) return null;
  try {
    const res = await jmapClient.request([
      ['Mailbox/query', { accountId, filter: { role: 'inbox' } }, 'q'],
      ['Mailbox/get', {
        accountId, '#ids': { resultOf: 'q', name: 'Mailbox/query', path: '/ids' }, properties: ['id', 'metadata'],
      }, 'g'],
    ] as JMAPMethodCall[], USING);
    const get = res.methodResponses.find(([name]) => name === 'Mailbox/get');
    const inbox = (get?.[1] as { list?: Array<Record<string, unknown>> } | undefined)?.list?.[0];
    // An answer without the property is a server that doesn't keep it,
    // never "every entry was removed".
    if (!inbox || !('metadata' in inbox)) throw new MetadataUnsupportedError('No Inbox metadata in the answer');
    inboxIds.set(keyOf(accountId), inbox.id as string);
    failedAt.delete(keyOf(accountId));
    return bulwarkEntries(inbox.metadata);
  } catch (err) {
    console.warn(`[metadata] unavailable for account ${accountId}:`, err);
    failedAt.set(keyOf(accountId), Date.now());
    return null;
  }
}

/**
 * Write one Bulwark entry of the account's Inbox metadata (null removes it),
 * leaving every other entry as it is. Throws MetadataTooLargeError when the
 * value is over the size the server takes, MetadataRefusedError for another
 * refusal, MetadataUnsupportedError when the account has none.
 */
export async function setBulwarkMetadata(accountId: string, key: string, value: unknown): Promise<void> {
  if (!supportsBulwarkMetadata(accountId)) throw new MetadataUnsupportedError();
  if (value !== null && metadataValueBytes(value) > MAX_METADATA_ENTRY_BYTES) {
    throw new MetadataTooLargeError(`The entry is larger than ${MAX_METADATA_ENTRY_BYTES} bytes`);
  }
  let inboxId = inboxIds.get(keyOf(accountId));
  if (!inboxId) {
    await getBulwarkMetadata(accountId);
    inboxId = inboxIds.get(keyOf(accountId));
    if (!inboxId) throw new MetadataUnsupportedError();
  }
  const res = await jmapClient.request(
    [['Mailbox/set', { accountId, update: { [inboxId]: { [`metadata/${namespaceFor(key)}`]: value } } }, '0']],
    USING,
  );
  const [name, body] = res.methodResponses[0] ?? [];
  if (name !== 'Mailbox/set') {
    throw new Error((body as { description?: string } | undefined)?.description || 'Failed to save metadata');
  }
  const refused = (body as { notUpdated?: Record<string, { type?: string; description?: string }> }).notUpdated?.[inboxId];
  if (refused) {
    if (/exceeds the maximum/i.test(refused.description ?? '')) throw new MetadataTooLargeError(refused.description!);
    throw new MetadataRefusedError(refused.type ?? 'unknown', refused.description || `Failed to save metadata (${refused.type ?? 'unknown'})`);
  }
}

/**
 * The group accounts of the session: shared accounts whose principal is a
 * group (Stalwart uses the account id as the principal id). A mailbox
 * another person shared is not a team. Empty when the server won't say.
 */
export async function groupAccounts(): Promise<Array<{ id: string; name: string }>> {
  const session = jmapClient.currentSession;
  if (!session || !jmapClient.hasCapability(CAPABILITIES.PRINCIPALS)) return [];
  const own = jmapClient.accountId;
  const shared = Object.entries(session.accounts ?? {})
    .filter(([id, account]) => id !== own && account && account.isPersonal === false);
  if (shared.length === 0) return [];
  try {
    const res = await jmapClient.request(
      [['Principal/get', { accountId: own, ids: shared.map(([id]) => id), properties: ['id', 'type'] }, '0']],
      [CAPABILITIES.CORE, CAPABILITIES.PRINCIPALS],
    );
    const [name, body] = res.methodResponses[0] ?? [];
    if (name !== 'Principal/get') return [];
    const types = new Map(((body as { list?: Array<{ id: string; type?: string }> }).list ?? []).map((p) => [p.id, p.type]));
    return shared.filter(([id]) => types.get(id) === 'group').map(([id, account]) => ({ id, name: account.name }));
  } catch {
    return [];
  }
}
