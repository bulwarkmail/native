// People you reply to are people you trust: after a reply goes out, allow
// their remote content from now on (webmail 1.5.x). Shared by the composer and
// the offline send queue's replay.

import { useSettingsStore } from '../stores/settings-store';
import { useContactsStore } from '../stores/contacts-store';
import { useAuthStore } from '../stores/auth-store';
import { withoutRefused } from './send-errors';
import { isTrustedSendersSyncOn } from './trusted-senders';
import { CAPABILITIES } from '../api/types';
import type { EmailAddress } from '../api/types';

/**
 * Trust the recipients the server accepted (a refused address is not someone
 * to trust). With `syncToBook`, each is also filed in the "Trusted Senders"
 * address book, best effort. `exclude` (lowercased) names addresses never to
 * trust: those on a message that failed or couldn't be verified
 * (untrustedReplyAddresses). Without the list (an Outbox entry from before
 * the sender check, a caller that never worked it out) nobody is trusted.
 */
export function trustRecipients(
  recipients: EmailAddress[],
  refused: { email: string }[] | undefined,
  { syncToBook, exclude }: { syncToBook: boolean; exclude: readonly string[] | undefined },
): void {
  if (!Array.isArray(exclude)) return;
  const settings = useSettingsStore.getState();
  const contacts = useContactsStore.getState();
  for (const r of withoutRefused(recipients, refused)) {
    if (exclude.includes(r.email.trim().toLowerCase())) continue;
    settings.addTrustedSender(r.email);
    if (syncToBook) {
      contacts.addToTrustedSendersBook(r.name ? `${r.name} <${r.email}>` : r.email).catch(() => undefined);
    }
  }
}

/** Whether "Sync trusted senders to address book" is in effect right now (outside React). */
export function trustedSendersBookSyncOn(): boolean {
  const session = useAuthStore.getState().session;
  const hasContacts = session ? CAPABILITIES.CONTACTS in session.capabilities : true;
  return isTrustedSendersSyncOn(useSettingsStore.getState().trustedSendersAddressBook, hasContacts);
}
