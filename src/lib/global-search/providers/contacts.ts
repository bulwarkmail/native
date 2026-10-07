import { getContactsAccountId, searchContacts } from '../../../api/contacts';
import { jmapClient } from '../../../api/jmap-client';
import { CAPABILITIES, type AddressBook, type ContactCard } from '../../../api/types';
import { useContactsStore } from '../../../stores/contacts-store';
import { getContactDisplayName, getContactPrimaryEmail } from '../../contact-utils';
import { matchesTerms } from '../query-parser';
import type { ContactHit, SearchAccount, SearchProvider } from '../types';
import { interleaveByOwner, isShownAndServed, searchShown, shownCacheAccount } from './shown';

// Contacts of the shown account only: there is no detached read path for
// them (plan, "Not in this phase"). The store holds that account's cards,
// with shared-book cards namespaced `${owner}:${id}`; a hit keeps that store
// id for the contacts screen and the raw id with its owner for the server.

function contactFields(contact: ContactCard): string[] {
  const fields: string[] = [getContactDisplayName(contact)];
  for (const email of Object.values(contact.emails ?? {})) if (email?.address) fields.push(email.address);
  for (const org of Object.values(contact.organizations ?? {})) if (org?.name) fields.push(org.name);
  for (const phone of Object.values(contact.phones ?? {})) if (phone?.number) fields.push(phone.number);
  for (const nick of Object.values(contact.nicknames ?? {})) if (nick?.name) fields.push(nick.name);
  return fields;
}

function bookName(contact: ContactCard, books: AddressBook[]): string {
  for (const id of Object.keys(contact.addressBookIds ?? {})) {
    const book = books.find((b) => b.id === id);
    if (book?.name) return book.name;
  }
  return '';
}

function toHit(contact: ContactCard, account: SearchAccount, source: 'local' | 'remote', books: AddressBook[]): ContactHit {
  const title = getContactDisplayName(contact) || getContactPrimaryEmail(contact) || contact.originalId || contact.id;
  const email = getContactPrimaryEmail(contact);
  return {
    kind: 'contacts',
    serverUrl: account.serverUrl,
    appAccountId: account.appAccountId,
    jmapAccountId: contact.accountId ?? getContactsAccountId(),
    id: contact.originalId ?? contact.id,
    accountLabel: account.label,
    title,
    subtitle: [bookName(contact, books), email && email !== title ? email : ''].filter(Boolean).join(' · '),
    date: contact.updated ?? null,
    source,
    contact,
    // Cards from searchContacts are tagged like the store's, so the id is the store's.
    storeId: contact.id,
  };
}

export const contactsProvider: SearchProvider = {
  kind: 'contacts',

  supports: (account) => isShownAndServed(account.appAccountId) && jmapClient.hasCapability(CAPABILITIES.CONTACTS),

  local: (parsed, accounts, limit) => {
    const account = shownCacheAccount(accounts);
    if (!account) return [];
    const { contacts, addressBooks } = useContactsStore.getState();
    const hits: ContactHit[] = [];
    for (const contact of contacts) {
      if (!matchesTerms(parsed.terms, contactFields(contact))) continue;
      hits.push(toHit(contact, account, 'local', addressBooks));
      if (hits.length >= limit) break;
    }
    return hits;
  },

  remote: (parsed, account, { limit, signal }) => searchShown(account, signal, async (at) => {
    // One more than asked from each account, to know whether there is more.
    const found = interleaveByOwner(await searchContacts(parsed.text, limit + 1, at), (c) => c.accountId ?? '');
    const { addressBooks } = useContactsStore.getState();
    return {
      hits: found.slice(0, limit).map((contact) => toHit(contact, account, 'remote', addressBooks)),
      hasMore: found.length > limit,
    };
  }),
};
