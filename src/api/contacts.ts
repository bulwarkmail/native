import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { ContactCard, AddressBook } from './types';

const USING = [CAPABILITIES.CORE, CAPABILITIES.CONTACTS];

function methodResult<T = any>(res: any, index = 0): T {
  const entry = res?.methodResponses?.[index];
  if (!entry) throw new Error('JMAP: empty method response');
  if (entry[0] === 'error') {
    const err = entry[1] || {};
    throw new Error(err.description || err.type || 'JMAP method error');
  }
  return entry[1] as T;
}

export async function getAddressBooks(): Promise<AddressBook[]> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['AddressBook/get', { accountId }, '0']],
    USING,
  );
  return methodResult<{ list: AddressBook[] }>(res).list ?? [];
}

export async function queryContacts(
  filter?: { text?: string; inAddressBook?: string },
  limit = 1000,
): Promise<string[]> {
  // Match webmail: no `sort` (unsupported by Stalwart for ContactCard/query).
  // Client sorts by display name after fetch.
  const accountId = jmapClient.accountId;
  const args: Record<string, unknown> = { accountId, limit };
  if (filter && Object.keys(filter).length > 0) args.filter = filter;
  const res = await jmapClient.request(
    [['ContactCard/query', args, '0']],
    USING,
  );
  return methodResult<{ ids: string[] }>(res).ids ?? [];
}

export async function getContacts(ids: string[]): Promise<ContactCard[]> {
  if (ids.length === 0) return [];
  const accountId = jmapClient.accountId;
  const batchSize = jmapClient.getMaxObjectsInGet();
  const all: ContactCard[] = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const res = await jmapClient.request(
      [['ContactCard/get', { accountId, ids: batch }, '0']],
      USING,
    );
    const list = methodResult<{ list: ContactCard[] }>(res).list ?? [];
    all.push(...list);
  }
  return all;
}

export async function createContact(
  contact: Partial<ContactCard>,
  addressBookId: string,
): Promise<ContactCard> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['ContactCard/set', {
      accountId,
      create: {
        'new-contact': { ...contact, addressBookIds: { [addressBookId]: true } },
      },
    }, '0']],
    USING,
  );
  return res.methodResponses[0][1].created['new-contact'];
}

export async function updateContact(
  id: string,
  changes: Partial<ContactCard>,
): Promise<void> {
  const accountId = jmapClient.accountId;
  await jmapClient.request(
    [['ContactCard/set', { accountId, update: { [id]: changes } }, '0']],
    USING,
  );
}

export async function deleteContacts(ids: string[]): Promise<void> {
  const accountId = jmapClient.accountId;
  await jmapClient.request(
    [['ContactCard/set', { accountId, destroy: ids }, '0']],
    USING,
  );
}
