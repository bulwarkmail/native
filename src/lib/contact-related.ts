import type { ContactCard } from '../api/types';

/** A card's uid as other cards name it: with or without `urn:uuid:`, in any case. */
function bareUid(value: string): string {
  return value.trim().replace(/^urn:uuid:/i, '').toLowerCase();
}

/**
 * The card a `relatedTo` key names. RFC 9553 keys the map by the related
 * card's uid, so the card is looked up among the loaded ones: in the same
 * account as `contact` first, since a uid is only unique within an account.
 * Ported from the webmail's lib/contact-related.ts (83c6e5eef, #1578).
 *
 * Undefined when no card has that uid. Importers also keep other values
 * there (a name from an Android custom relation, a URL); those are shown as
 * stored.
 */
export function findRelatedContact(
  key: string,
  contact: Pick<ContactCard, 'id' | 'accountId'>,
  contacts: readonly ContactCard[],
): ContactCard | undefined {
  const wanted = bareUid(key);
  if (!wanted) return undefined;
  const matches = contacts.filter((c) => c.id !== contact.id && !!c.uid && bareUid(c.uid) === wanted);
  if (matches.length === 0) return undefined;
  const sameAccount = (c: ContactCard) => (c.accountId ?? '') === (contact.accountId ?? '');
  return matches.find(sameAccount) ?? (matches.length === 1 ? matches[0] : undefined);
}
