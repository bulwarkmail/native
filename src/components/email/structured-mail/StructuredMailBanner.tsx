// App only: the booking, parcel and order cards for MessageContent, in one
// component so the reader mounts them with one line (the webmail wires the
// same pieces in email-viewer.tsx).
import React from 'react';
import type { Email } from '../../../api/types';
import { isSenderContentTrusted, isTrustedSendersSyncOn } from '../../../lib/trusted-senders';
import { useHasContacts } from '../../../lib/capabilities';
import { useContactsStore } from '../../../stores/contacts-store';
import { useSettingsStore } from '../../../stores/settings-store';
import { StructuredMailCards } from './structured-mail-cards';
import { useStructuredMail } from './use-structured-mail';

interface Props {
  email: Email;
  /** Account the message lives in (a shared mailbox's owner); undefined for the user's own. */
  jmapAccountId?: string;
}

/**
 * Cards from the message's schema.org markup and Wallet passes, for a sender
 * the receiving server verified. Nothing for any other message. Product
 * images load only when the body's remote content would load without a tap:
 * the policy allows it or the sender is trusted.
 */
export function StructuredMailBanner({ email, jmapAccountId }: Props) {
  const cards = useStructuredMail(email, jmapAccountId);
  const policy = useSettingsStore((s) => s.externalContentPolicy);
  const trustedSenders = useSettingsStore((s) => s.trustedSenders);
  const isSenderTrusted = useSettingsStore((s) => s.isSenderTrusted);
  const trustedSendersAddressBook = useSettingsStore((s) => s.trustedSendersAddressBook);
  const trustedBookEmails = useContactsStore((s) => s.trustedSenderEmails);
  const hasContacts = useHasContacts();
  const sender = email.from?.[0]?.email;
  const allowRemoteImages = React.useMemo(
    () => policy === 'allow' || isSenderContentTrusted(sender, {
      isLocallyTrusted: isSenderTrusted,
      syncEnabled: isTrustedSendersSyncOn(trustedSendersAddressBook, hasContacts),
      trustedBookEmails,
    }),
    // trustedSenders changes what isSenderTrusted answers.
    [policy, sender, isSenderTrusted, trustedSenders, trustedSendersAddressBook, hasContacts, trustedBookEmails], // eslint-disable-line react-hooks/exhaustive-deps
  );
  if (cards.length === 0) return null;
  return <StructuredMailCards cards={cards} allowRemoteImages={allowRemoteImages} />;
}
