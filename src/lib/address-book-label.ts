import type { AddressBook } from '../api/types';

/**
 * How an address book is named in a picker: a shared one with the account
 * it comes from, unless its name already says so. Stalwart names a default
 * book "Stalwart Address Book (team@example.org)", which came out as
 * "... (team@example.org) (team@example.org)". Webmail contact-form.tsx.
 */
export function addressBookLabel(book: Pick<AddressBook, 'name' | 'isShared' | 'accountName'>): string {
  const name = book.name ?? '';
  if (!book.isShared || !book.accountName || name.includes(book.accountName)) return name;
  return `${name} (${book.accountName})`;
}
