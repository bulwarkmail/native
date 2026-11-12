import type { AddressBook, ContactCard } from '../api/types';

/**
 * A contact in an address book shared read-only can't be changed: its
 * screens leave out Edit, Move and Delete (webmail contacts-app.tsx
 * isContactReadOnly, 8dfaa3960). The server would refuse them afterwards.
 */
export function isContactReadOnly(
  contact: Pick<ContactCard, 'addressBookIds'>,
  addressBooks: Pick<AddressBook, 'id' | 'myRights'>[],
): boolean {
  return Object.entries(contact.addressBookIds ?? {})
    .some(([id, inBook]) => inBook && addressBooks.find((b) => b.id === id)?.myRights?.mayWrite === false);
}
