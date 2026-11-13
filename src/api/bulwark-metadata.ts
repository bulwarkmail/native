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
// An object has two sets of namespaces: `metadata`, which everyone the
// object is shared with reads, and `privateMetadata`, which only the signed-in
// user reads and writes (seen live on 1.1.0, 2026-11-13: a delegate gets the
// first and an empty second). Templates and tags are in the shared set, as
// the webmail keeps them; the user's settings are in the private one
// (lib/settings-sync). The private set has limits of its own: 8 KB per
// namespace again, 16 KB in all where the shared set has 64 KB.
//
// This is the only module that names the Metadata capability or property
// (src/api/__tests__/jmap-metadata-requests.test.ts).

import { jmapClient, type JMAPClient } from './jmap-client';
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

/**
 * The client a request goes through. The app's own by default; settings sync
 * hands in one of its own for an account that isn't the active one
 * (stores/settings-sync-store).
 */
export type MetadataClient = Pick<JMAPClient, 'request' | 'currentSession' | 'serverUrl' | 'username'>;

/** Which set of namespaces: the one shared with the object, or the user's own. */
export type MetadataScope = 'shared' | 'private';

const propertyOf = (scope: MetadataScope) => (scope === 'private' ? 'privateMetadata' : 'metadata');

// Account ids repeat across servers and logins.
const keyOf = (accountId: string, client: MetadataClient) =>
  `${client.serverUrl ?? ''}\u0000${client.username ?? ''}\u0000${accountId}`;
// A pause is for one set of namespaces: a failed read of the settings must
// not stop the templates of the same account, nor the other way round.
const pauseKey = (accountId: string, client: MetadataClient, scope: MetadataScope) =>
  `${keyOf(accountId, client)}\u0000${scope}`;
const failedAt = new Map<string, number>();
const inboxIds = new Map<string, string>();

/** Forget paused accounts and Inbox ids (tests). */
export function resetBulwarkMetadata(): void {
  failedAt.clear();
  inboxIds.clear();
}

/** Whether the account advertises vendor metadata on mailboxes, whatever its last request did. */
export function advertisesBulwarkMetadata(
  accountId: string,
  client: MetadataClient = jmapClient,
  scope: MetadataScope = 'shared',
): boolean {
  const caps = client.currentSession?.accounts?.[accountId]?.accountCapabilities as Record<string, unknown> | undefined;
  const cap = caps?.[METADATA_CAPABILITY] as
    | { dataTypes?: Record<string, { supportsVendorNamespaces?: boolean; supportsPrivate?: boolean }> }
    | undefined;
  const mailbox = cap?.dataTypes?.Mailbox;
  return mailbox?.supportsVendorNamespaces === true && (scope === 'shared' || mailbox.supportsPrivate === true);
}

/** Whether Bulwark may keep data in this account's Inbox metadata now. */
export function supportsBulwarkMetadata(
  accountId: string,
  client: MetadataClient = jmapClient,
  scope: MetadataScope = 'shared',
): boolean {
  const at = failedAt.get(pauseKey(accountId, client, scope));
  if (at !== undefined && Date.now() - at < PAUSE_MS) return false;
  return advertisesBulwarkMetadata(accountId, client, scope);
}

/** End a pause early: the user asked for another try, or the network is back. */
export function resumeBulwarkMetadata(
  accountId: string,
  client: MetadataClient = jmapClient,
  scope: MetadataScope = 'shared',
): void {
  failedAt.delete(pauseKey(accountId, client, scope));
}

/**
 * Bulwark's metadata entries of the account's Inbox, by key. Null when the
 * account has no usable metadata; a failure pauses the account.
 */
export async function getBulwarkMetadata(
  accountId: string,
  client: MetadataClient = jmapClient,
  scope: MetadataScope = 'shared',
): Promise<Record<string, unknown> | null> {
  if (!supportsBulwarkMetadata(accountId, client, scope)) return null;
  const property = propertyOf(scope);
  try {
    const res = await client.request([
      ['Mailbox/query', { accountId, filter: { role: 'inbox' } }, 'q'],
      ['Mailbox/get', {
        accountId, '#ids': { resultOf: 'q', name: 'Mailbox/query', path: '/ids' }, properties: ['id', property],
      }, 'g'],
    ] as JMAPMethodCall[], USING);
    const get = res.methodResponses.find(([name]) => name === 'Mailbox/get');
    const inbox = (get?.[1] as { list?: Array<Record<string, unknown>> } | undefined)?.list?.[0];
    // An answer without the property is a server that doesn't keep it,
    // never "every entry was removed".
    if (!inbox || !(property in inbox)) throw new MetadataUnsupportedError('No Inbox metadata in the answer');
    inboxIds.set(keyOf(accountId, client), inbox.id as string);
    failedAt.delete(pauseKey(accountId, client, scope));
    return bulwarkEntries(inbox[property]);
  } catch (err) {
    console.warn(`[metadata] unavailable for account ${accountId}:`, err);
    failedAt.set(pauseKey(accountId, client, scope), Date.now());
    return null;
  }
}

/**
 * Write one Bulwark entry of the account's Inbox metadata (null removes it),
 * leaving every other entry as it is. Throws MetadataTooLargeError when the
 * value is over the size the server takes, MetadataRefusedError for another
 * refusal, MetadataUnsupportedError when the account has none.
 */
export async function setBulwarkMetadata(
  accountId: string,
  key: string,
  value: unknown,
  client: MetadataClient = jmapClient,
): Promise<void> {
  if (!supportsBulwarkMetadata(accountId, client)) throw new MetadataUnsupportedError();
  if (value !== null && metadataValueBytes(value) > MAX_METADATA_ENTRY_BYTES) {
    throw new MetadataTooLargeError(`The entry is larger than ${MAX_METADATA_ENTRY_BYTES} bytes`);
  }
  await patchBulwarkMetadata(accountId, [{ key, value }], client);
}

/** One change of a patch: a whole entry, or one member of an entry that exists. */
export interface MetadataChange {
  key: string;
  /** A member of the entry's object. The server refuses it for an entry that doesn't exist yet. */
  member?: string;
  /** Null removes the entry or the member. */
  value: unknown;
}

// JSON Pointer (RFC 6901): what a member name must have escaped.
const pointerToken = (name: string) => name.replace(/~/g, '~0').replace(/\//g, '~1');

/**
 * Apply several changes to the account's Inbox metadata in one update: all
 * of them or none. Other entries, and the other members of a patched entry,
 * stay as they are, so two devices writing different members of one entry
 * don't undo each other. Throws like setBulwarkMetadata.
 */
export async function patchBulwarkMetadata(
  accountId: string,
  changes: MetadataChange[],
  client: MetadataClient = jmapClient,
  scope: MetadataScope = 'shared',
): Promise<void> {
  if (!supportsBulwarkMetadata(accountId, client, scope)) throw new MetadataUnsupportedError();
  if (changes.length === 0) return;
  let inboxId = inboxIds.get(keyOf(accountId, client));
  if (!inboxId) {
    await getBulwarkMetadata(accountId, client, scope);
    inboxId = inboxIds.get(keyOf(accountId, client));
    if (!inboxId) throw new MetadataUnsupportedError();
  }
  const patch: Record<string, unknown> = {};
  for (const change of changes) {
    const entry = `${propertyOf(scope)}/${namespaceFor(change.key)}`;
    patch[change.member === undefined ? entry : `${entry}/${pointerToken(change.member)}`] = change.value;
  }
  const res = await client.request(
    [['Mailbox/set', { accountId, update: { [inboxId]: patch } }, '0']],
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
