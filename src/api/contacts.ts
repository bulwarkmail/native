import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { ContactCard, AddressBook } from './types';

const USING = [CAPABILITIES.CORE, CAPABILITIES.CONTACTS];

export async function getAddressBooks(): Promise<AddressBook[]> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['AddressBook/get', { accountId }, '0']],
    USING,
  );
  return res.methodResponses[0][1].list;
}

export async function queryContacts(
  filter?: { text?: string; inAddressBook?: string },
  limit = 100,
): Promise<string[]> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['ContactCard/query', {
      accountId,
      filter: filter ?? {},
      sort: [{ property: 'name', isAscending: true }],
      limit,
    }, '0']],
    USING,
  );
  return res.methodResponses[0][1].ids;
}

export async function getContacts(ids: string[]): Promise<ContactCard[]> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['ContactCard/get', { accountId, ids }, '0']],
    USING,
  );
  return res.methodResponses[0][1].list;
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
