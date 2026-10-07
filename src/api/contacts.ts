import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { ContactCard, AddressBook } from './types';
import { generateUUID } from '../lib/uuid';
import { contactFromWire, contactToWire } from '../lib/contact-wire';
import { isStaleLoad } from '../lib/network-error';
import { opScope, type AccountRef } from './op-scope';

const USING = [CAPABILITIES.CORE, CAPABILITIES.CONTACTS];

// Stalwart's default property list for AddressBook/get omits shareWith, so
// existing shares would be invisible after a fresh login (webmail #257).
const ADDRESS_BOOK_PROPERTIES = [
  'id',
  'name',
  'description',
  'sortOrder',
  'isDefault',
  'isSubscribed',
  'shareWith',
  'myRights',
] as const;

type SetError = { description?: string; type?: string; properties?: string[] };

function methodResult<T = any>(res: any, index = 0): T {
  const entry = res?.methodResponses?.[index];
  if (!entry) throw new Error('JMAP: empty method response');
  if (entry[0] === 'error') {
    const err = entry[1] || {};
    throw new Error(err.description || err.type || 'JMAP method error');
  }
  return entry[1] as T;
}

function setErrorMessage(err: SetError | undefined, fallback: string): string {
  if (!err) return fallback;
  const detail = err.description || err.type || fallback;
  return err.properties?.length ? `${detail} (${err.properties.join(', ')})` : detail;
}

/**
 * Primary account for the contacts capability (RFC 8620 `primaryAccounts`),
 * falling back to the mail primary. Contacts can live in a different account
 * than mail on some servers.
 */
export function getContactsAccountId(): string {
  const id = jmapClient.currentSession?.primaryAccounts?.[CAPABILITIES.CONTACTS];
  return id || jmapClient.accountId;
}

/**
 * Every account that may hold address books: the contacts primary first, then
 * accounts that advertise the contacts capability or are non-personal (shared
 * / group) accounts - Stalwart doesn't always advertise capabilities on group
 * accounts even when they have contact resources. Mirrors the webmail's
 * getContactCapableAccountIds().
 */
export function getContactCapableAccountIds(): string[] {
  const primaryId = getContactsAccountId();
  const accounts = jmapClient.currentSession?.accounts ?? {};
  const out: string[] = [];
  for (const [id, account] of Object.entries(accounts)) {
    if (id === primaryId) continue;
    if (account.accountCapabilities?.[CAPABILITIES.CONTACTS] || account.isPersonal === false) {
      out.push(id);
    }
  }
  return [primaryId, ...out];
}

function accountName(accountId: string): string {
  return jmapClient.currentSession?.accounts?.[accountId]?.name || accountId;
}

/** Namespace an id from a non-primary account as `<accountId>:<id>`. */
export function namespaceId(accountId: string, id: string): string {
  return `${accountId}:${id}`;
}

/**
 * Strip client-only metadata before a card goes to the server. Shared-account
 * cards carry namespaced ids and account tags that JMAP would reject as
 * unknown properties.
 */
export function stripClientFields<T extends Partial<ContactCard>>(contact: T): Partial<ContactCard> {
  const {
    originalId: _oid, accountId: _aid, accountName: _an, isShared: _is,
    ...rest
  } = contact as ContactCard;
  return rest;
}

export async function getAddressBooks(accountId?: string): Promise<AddressBook[]> {
  const account = accountId || getContactsAccountId();
  const res = await jmapClient.request(
    [['AddressBook/get', { accountId: account, properties: ADDRESS_BOOK_PROPERTIES }, '0']],
    USING,
  );
  return methodResult<{ list: AddressBook[] }>(res).list ?? [];
}

/**
 * Address books across every contacts-capable account. Books from non-primary
 * (shared / group) accounts get a namespaced id plus `accountId`, `accountName`
 * and `isShared`; a failing shared account never hides the user's own books.
 */
export async function getAllAddressBooks(): Promise<AddressBook[]> {
  const primaryId = getContactsAccountId();
  const all: AddressBook[] = [];
  for (const accountId of getContactCapableAccountIds()) {
    const isPrimary = accountId === primaryId;
    try {
      const books = await getAddressBooks(accountId);
      all.push(...books.map((book) => ({
        ...book,
        id: isPrimary ? book.id : namespaceId(accountId, book.id),
        originalId: book.id,
        accountId,
        accountName: isPrimary ? (jmapClient.username || accountName(accountId)) : accountName(accountId),
        isShared: !isPrimary,
      })));
    } catch (err) {
      if (isPrimary) throw err;
      console.warn(`[contacts] address books for shared account ${accountId} failed`, err);
    }
  }
  return all;
}

export async function queryContacts(
  filter?: { text?: string; inAddressBook?: string },
  limit?: number,
  accountId?: string,
): Promise<string[]> {
  // Match webmail: no `sort` (unsupported by Stalwart for ContactCard/query).
  // Client sorts by display name after fetch. The server may clamp `limit`
  // below what we ask for, so walk `position` until the total is reached.
  const account = accountId || getContactsAccountId();
  const batchSize = limit ?? jmapClient.getMaxObjectsInGet();
  const allIds: string[] = [];
  let position = 0;
  for (;;) {
    const args: Record<string, unknown> = { accountId: account, position, limit: batchSize };
    if (filter && Object.keys(filter).length > 0) args.filter = filter;
    const res = await jmapClient.request(
      [['ContactCard/query', args, '0']],
      USING,
    );
    const result = methodResult<{ ids?: string[]; total?: number }>(res);
    const ids = result.ids ?? [];
    allIds.push(...ids);
    const total = typeof result.total === 'number' ? result.total : -1;
    if (ids.length === 0 || ids.length < batchSize || (total >= 0 && allIds.length >= total)) break;
    position += ids.length;
  }
  return allIds;
}

export async function getContacts(ids: string[], accountId?: string): Promise<ContactCard[]> {
  if (ids.length === 0) return [];
  const account = accountId || getContactsAccountId();
  const batchSize = jmapClient.getMaxObjectsInGet();
  const all: ContactCard[] = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const res = await jmapClient.request(
      [['ContactCard/get', { accountId: account, ids: batch }, '0']],
      USING,
    );
    const list = methodResult<{ list: ContactCard[] }>(res).list ?? [];
    all.push(...list.map(contactFromWire));
  }
  return all;
}

/** Tag a card fetched from `accountId` with the client-side account metadata. */
function tagContact(contact: ContactCard, accountId: string, isPrimary: boolean): ContactCard {
  if (isPrimary) return contact;
  const addressBookIds = contact.addressBookIds
    ? Object.fromEntries(
      Object.entries(contact.addressBookIds).map(([bookId, v]) => [namespaceId(accountId, bookId), v]),
    )
    : contact.addressBookIds;
  return {
    ...contact,
    id: namespaceId(accountId, contact.id),
    originalId: contact.id,
    addressBookIds,
    accountId,
    accountName: accountName(accountId),
    isShared: true,
  };
}

/**
 * Contact cards across every contacts-capable account, namespaced like
 * getAllAddressBooks. A failing shared account is skipped; a failing primary
 * account throws so the store can surface the error.
 */
export async function getAllContacts(): Promise<ContactCard[]> {
  const primaryId = getContactsAccountId();
  const all: ContactCard[] = [];
  for (const accountId of getContactCapableAccountIds()) {
    const isPrimary = accountId === primaryId;
    try {
      const ids = await queryContacts(undefined, undefined, accountId);
      const cards = await getContacts(ids, accountId);
      all.push(...cards.map((card) => tagContact(card, accountId, isPrimary)));
    } catch (err) {
      if (isPrimary) throw err;
      console.warn(`[contacts] contacts for shared account ${accountId} failed`, err);
    }
  }
  return all;
}

/**
 * Up to `limit` cards matching `text` (server full-text, `ContactCard/query`)
 * from each contacts-capable account, tagged like getAllContacts. One page
 * per account, the query and the get in one request, every request on the
 * connection `account` names (see `OpScope`). A failing shared account is
 * skipped; a failing own account, or a replaced connection, throws.
 */
export async function searchContacts(text: string, limit: number, account?: AccountRef): Promise<ContactCard[]> {
  const { gen } = opScope(account);
  const primaryId = getContactsAccountId();
  const all: ContactCard[] = [];
  for (const accountId of getContactCapableAccountIds()) {
    const isPrimary = accountId === primaryId;
    try {
      const res = await jmapClient.request([
        ['ContactCard/query', { accountId, filter: { text }, limit }, '0'],
        ['ContactCard/get', {
          accountId,
          '#ids': { resultOf: '0', name: 'ContactCard/query', path: '/ids' },
        }, '1'],
      ], USING, { gen });
      methodResult(res, 0);
      const list = methodResult<{ list?: ContactCard[] }>(res, 1).list ?? [];
      all.push(...list.map((card) => tagContact(contactFromWire(card), accountId, isPrimary)));
    } catch (err) {
      if (isPrimary || isStaleLoad(err)) throw err;
      console.warn(`[contacts] search in shared account ${accountId} failed`, err);
    }
  }
  return all;
}

export async function getContact(id: string, accountId?: string): Promise<ContactCard | null> {
  const list = await getContacts([id], accountId);
  return list[0] ?? null;
}

export async function createContact(
  contact: Partial<ContactCard>,
  addressBookId: string,
  accountId?: string,
): Promise<ContactCard> {
  const account = accountId || getContactsAccountId();
  const data = contactToWire(contact, 'create');
  const res = await jmapClient.request(
    [['ContactCard/set', {
      accountId: account,
      create: {
        'new-contact': {
          ...data,
          // Stalwart stores the card without one if omitted (#644), which
          // breaks group membership and CardDAV round-trips.
          uid: (data.uid as string | undefined) || `urn:uuid:${generateUUID()}`,
          addressBookIds: { [addressBookId]: true },
        },
      },
    }, '0']],
    USING,
  );
  const result = methodResult<{
    created?: Record<string, Partial<ContactCard>>;
    notCreated?: Record<string, SetError>;
  }>(res);
  const created = result.created?.['new-contact'];
  if (!created?.id) {
    throw new Error(setErrorMessage(result.notCreated?.['new-contact'], 'Failed to create contact'));
  }
  // The set response only carries server-set properties (id, created,
  // updated...). Re-fetch the full card so the store appends a complete row
  // instead of an "Unnamed" stub; fall back to a client-side merge.
  try {
    const full = await getContact(created.id, account);
    if (full) return full;
  } catch {
    // fall through to the merge below
  }
  return contactFromWire({
    ...data,
    uid: data.uid,
    ...created,
    id: created.id,
    addressBookIds: { [addressBookId]: true },
  } as ContactCard);
}

export async function updateContact(
  id: string,
  changes: Partial<ContactCard>,
  accountId?: string,
): Promise<void> {
  const account = accountId || getContactsAccountId();
  const res = await jmapClient.request(
    [['ContactCard/set', { accountId: account, update: { [id]: contactToWire(changes, 'update') } }, '0']],
    USING,
  );
  const result = methodResult<{ notUpdated?: Record<string, SetError> }>(res);
  const err = result.notUpdated?.[id];
  if (err) throw new Error(setErrorMessage(err, 'Failed to update contact'));
}

/**
 * Destroy cards. Returns the ids the server actually destroyed; throws when
 * nothing could be destroyed (with the first server description) so a
 * single-card delete surfaces the reason.
 */
export async function deleteContacts(ids: string[], accountId?: string): Promise<string[]> {
  if (ids.length === 0) return [];
  const account = accountId || getContactsAccountId();
  const res = await jmapClient.request(
    [['ContactCard/set', { accountId: account, destroy: ids }, '0']],
    USING,
  );
  const result = methodResult<{
    destroyed?: string[];
    notDestroyed?: Record<string, SetError>;
  }>(res);
  const failed = result.notDestroyed ?? {};
  // Servers that omit `destroyed` still honoured everything not listed as failed.
  const destroyed = result.destroyed ?? ids.filter((id) => !(id in failed));
  if (destroyed.length === 0) {
    const firstFailure = Object.values(failed)[0];
    throw new Error(setErrorMessage(firstFailure, 'Failed to delete contact'));
  }
  return destroyed;
}

export async function createAddressBook(name: string, accountId?: string): Promise<AddressBook> {
  const account = accountId || getContactsAccountId();
  const res = await jmapClient.request(
    [['AddressBook/set', { accountId: account, create: { 'new-book': { name } } }, '0']],
    USING,
  );
  const result = methodResult<{
    created?: Record<string, AddressBook>;
    notCreated?: Record<string, SetError>;
  }>(res);
  const created = result.created?.['new-book'];
  if (created) return { ...created, name };
  throw new Error(setErrorMessage(result.notCreated?.['new-book'], 'Failed to create address book'));
}

export async function updateAddressBook(
  id: string,
  updates: Partial<AddressBook>,
  accountId?: string,
): Promise<void> {
  const account = accountId || getContactsAccountId();
  // Only forward server-settable properties. `isDefault` is deliberately not
  // among them: it is read-only in AddressBook/set and including it fails the
  // whole update with invalidProperties - use setDefaultAddressBook instead.
  const { name, description, sortOrder } = updates as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  if (name !== undefined) patch.name = name;
  if (description !== undefined) patch.description = description;
  if (sortOrder !== undefined) patch.sortOrder = sortOrder;

  const res = await jmapClient.request(
    [['AddressBook/set', { accountId: account, update: { [id]: patch } }, '0']],
    USING,
  );
  const result = methodResult<{ notUpdated?: Record<string, SetError> }>(res);
  const err = result.notUpdated?.[id];
  if (err) throw new Error(setErrorMessage(err, 'Failed to update address book'));
}

/**
 * Mark an address book as the account default. `isDefault` is read-only in
 * AddressBook/set - the default is changed via the `onSuccessSetIsDefault`
 * request argument instead (same shape as Calendar/set).
 */
export async function setDefaultAddressBook(id: string, accountId?: string): Promise<void> {
  const account = accountId || getContactsAccountId();
  const res = await jmapClient.request(
    [['AddressBook/set', { accountId: account, onSuccessSetIsDefault: id }, '0']],
    USING,
  );
  methodResult(res);
}

export async function deleteAddressBook(
  id: string,
  accountId?: string,
  options?: { removeContents?: boolean },
): Promise<void> {
  const account = accountId || getContactsAccountId();
  const res = await jmapClient.request(
    [['AddressBook/set', {
      accountId: account,
      destroy: [id],
      // Without this a book that still holds cards is refused (addressBookHasContents).
      ...(options?.removeContents ? { onDestroyRemoveContents: true } : {}),
    }, '0']],
    USING,
  );
  const result = methodResult<{ notDestroyed?: Record<string, SetError> }>(res);
  const err = result.notDestroyed?.[id];
  if (err) throw new Error(setErrorMessage(err, 'Failed to delete address book'));
}

/** Fetch all contact cards that live in a specific address book. */
export async function getContactsInBook(addressBookId: string, accountId?: string): Promise<ContactCard[]> {
  const ids = await queryContacts({ inAddressBook: addressBookId }, undefined, accountId);
  return getContacts(ids, accountId);
}
