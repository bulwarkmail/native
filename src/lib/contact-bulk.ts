import type { ContactCard, EmailAddress } from '../api/types';
import { getContactDisplayName, getContactPrimaryEmail } from './contact-utils';

/**
 * One new message to everyone ticked: each contact's primary address once
 * (case-insensitive), with the contact's name when it is not just the
 * address. Contacts without an address are left out. Webmail
 * contact-selection-view.tsx selectionRecipients.
 */
export function selectionRecipients(contacts: readonly ContactCard[]): EmailAddress[] {
  const seen = new Set<string>();
  const out: EmailAddress[] = [];
  for (const contact of contacts) {
    const email = getContactPrimaryEmail(contact).trim();
    const key = email.toLowerCase();
    if (!email || seen.has(key)) continue;
    seen.add(key);
    const name = getContactDisplayName(contact);
    out.push({ name: name && name !== email ? name : '', email });
  }
  return out;
}
