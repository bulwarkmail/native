/**
 * The pre-send check behind "Send outside your organisation?" (webmail
 * lib/outgoing/external-recipients.ts): when the admin turned the recipient
 * warning on, recipients outside the organisation (and, with trustContacts,
 * not in the user's contacts) are listed in one question. The composer asks
 * it in its send-check sheet, quick reply and the event editor's
 * invitations in an alert.
 */

import { usePolicyStore } from '../../stores/policy-store';
import { useSettingsStore } from '../../stores/settings-store';
import { TRUSTED_SENDERS_BOOK_NAME, useContactsStore } from '../../stores/contacts-store';
import {
  addressDomain,
  addressKey,
  externalMailPolicyOf,
  externalRecipients,
  internalDomains,
  type ExternalRecipient,
} from '../external-mail';
import { policyForSender } from './classification';

/** Longest the send waits for the contacts to load the first time. */
export const CONTACTS_WAIT_MS = 3000;

/**
 * Waits for the contacts the first time, at most CONTACTS_WAIT_MS: a send
 * right after signing in shouldn't ask about every contact, nor hang on a
 * slow address book.
 */
export async function ensureContactsLoaded(waitMs = CONTACTS_WAIT_MS): Promise<void> {
  const contacts = useContactsStore.getState();
  if (contacts.contactsFetchedAt > 0 || contacts.contacts.length > 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      contacts.fetchContacts(),
      new Promise((resolve) => { timer = setTimeout(resolve, waitMs); }),
    ]);
  } catch {
    // No contacts: everyone outside is asked about.
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The addresses of the loaded contacts, as addressKey makes them. A card
 * that sits only in the "Trusted Senders" book is left out: that book is the
 * list of senders whose images load, not people the user writes to.
 */
export function contactAddresses(): Set<string> {
  const { contacts, addressBooks, trustedSendersBookId } = useContactsStore.getState();
  const trustedBooks = new Set(addressBooks.filter((book) => book.name === TRUSTED_SENDERS_BOOK_NAME).map((book) => book.id));
  if (trustedSendersBookId) trustedBooks.add(trustedSendersBookId);
  const out = new Set<string>();
  for (const contact of contacts) {
    const books = Object.keys(contact.addressBookIds ?? {}).filter((id) => contact.addressBookIds?.[id]);
    if (books.length > 0 && books.every((id) => trustedBooks.has(id))) continue;
    for (const entry of Object.values(contact.emails ?? {})) {
      const address = entry?.address?.trim();
      if (address) out.add(addressKey(address));
    }
  }
  return out;
}

export interface RecipientCheckInput {
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
  /**
   * The sending identity's own address: internal. A From typed over it in the
   * composer is not (anyone can type any domain there), so the composer
   * passes the identity's address, never the typed one.
   */
  identityEmail?: string | null;
}

/** The recipients the user is asked about; empty when the check doesn't apply. */
export async function recipientsToConfirm(input: RecipientCheckInput): Promise<ExternalRecipient[]> {
  const policy = externalMailPolicyOf(policyForSender(input.identityEmail)?.organisation ?? usePolicyStore.getState().effective?.organisation);
  if (!policy.recipientWarning) return [];
  const identities = useSettingsStore.getState().identities ?? [];
  const internal = internalDomains(identities.map((i) => i.email ?? ''), policy.domains);
  const identityDomain = addressDomain(input.identityEmail);
  if (identityDomain && !internal.includes(identityDomain)) internal.push(identityDomain);
  let trusted: ((address: string) => boolean) | undefined;
  if (policy.trustContacts) {
    await ensureContactsLoaded();
    const known = contactAddresses();
    trusted = (address) => known.has(address);
  }
  return externalRecipients(input, internal, trusted);
}
