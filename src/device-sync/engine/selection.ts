/**
 * Which collections sync. The store keeps explicit choices only; a
 * collection the user never touched follows the default: the personal
 * account's collections on, shared accounts' off (docs/device-sync.md,
 * "App integration"), except the webmail's allow-list address book.
 */
import { collectionKey } from '../common/ids';
import { CONTACTS_AUTHORITY, type Authority } from '../types';

/**
 * The address book the webmail keeps its allow-listed senders in. Mirrors
 * TRUSTED_SENDERS_BOOK_NAME in src/stores/contacts-store.ts, which the pure
 * engine cannot import.
 */
export const TRUSTED_SENDERS_BOOK_NAME = 'Trusted Senders';

/**
 * Whether a collection the user never chose syncs: those of the personal
 * account do, shared ones don't; nor does the "Trusted Senders" address
 * book, a mail filter rather than people to call.
 */
export function collectionDefaultOn(personal: boolean, authority: Authority, name: string | null | undefined): boolean {
  if (!personal) return false;
  return !(authority === CONTACTS_AUTHORITY && name === TRUSTED_SENDERS_BOOK_NAME);
}

/** An explicit choice wins; otherwise the default. */
export function isCollectionSelected(
  explicit: Readonly<Record<string, boolean>>,
  account: { id: string; personal: boolean },
  authority: Authority,
  collection: { id: string; name?: string | null },
): boolean {
  const choice = explicit[collectionKey(account.id, collection.id)];
  return typeof choice === 'boolean' ? choice : collectionDefaultOn(account.personal, authority, collection.name);
}
