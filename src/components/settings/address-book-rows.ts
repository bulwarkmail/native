import type { AddressBook } from '../../api/types';

/**
 * Whether Settings > Contacts marks a book "Default": the user's own default
 * book only. A group's book is the default of the group's account, which made
 * the own and the team book both read "· Default".
 */
export function showsDefaultBadge(book: Pick<AddressBook, 'isDefault' | 'isShared'>): boolean {
  return !!book.isDefault && !book.isShared;
}
