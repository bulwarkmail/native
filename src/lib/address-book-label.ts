import type { AddressBook } from '../api/types';
import { collectionLabel } from './default-collection-name';

/**
 * A shared collection's name with the account it comes from, unless the name
 * already says so. Stalwart names a group's default address book
 * "Stalwart Address Book (team@example.org)" and its default calendar the
 * same way, which came out as "... (team@example.org) (team@example.org)".
 */
export function nameWithAccount(name: string, accountName: string | null | undefined): string {
  if (!accountName || name.includes(accountName)) return name;
  return `${name} (${accountName})`;
}

/**
 * How an address book is named in a picker: Stalwart's own default name as
 * `plainName` ("Contacts"), a shared one with the account it comes from,
 * unless its name already says so. Webmail contact-form.tsx.
 */
export function addressBookLabel(
  book: Pick<AddressBook, 'name' | 'isShared' | 'accountName'>,
  plainName = 'Contacts',
): string {
  const name = collectionLabel({ name: book.name ?? '', isShared: book.isShared }, 'addressBook', plainName);
  return book.isShared ? nameWithAccount(name, book.accountName) : name;
}
