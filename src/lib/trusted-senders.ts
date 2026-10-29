/**
 * Whether "Sync trusted senders to address book" is in effect. Never chosen
 * (null) counts as on, so trusted senders land in the dedicated "Trusted
 * Senders" address book out of the box; only the user's opt-out (false), or
 * a server without contacts, turns it off.
 */
export function isTrustedSendersSyncOn(setting: boolean | null | undefined, hasContacts: boolean): boolean {
  return hasContacts && setting !== false;
}

/**
 * Whether the viewer may load a sender's remote content (images, tracking
 * pixels) without asking.
 *
 * Only two lists count: the local allow-list and, while "Sync trusted senders
 * to address book" is on, the dedicated "Trusted Senders" address book. An
 * ordinary contact is never trusted just for being in the address book: the
 * From header is trivially spoofed, so that would let anyone who knows a
 * contact's address load pixels (webmail `components/email/email-viewer.tsx`).
 */
export function isSenderContentTrusted(
  senderEmail: string | null | undefined,
  opts: {
    /** The settings store's local allow-list check. */
    isLocallyTrusted: (email: string) => boolean;
    /** Whether address book sync is in effect (`isTrustedSendersSyncOn`). */
    syncEnabled: boolean;
    /** Lowercased addresses filed in the "Trusted Senders" book. */
    trustedBookEmails: readonly string[];
  },
): boolean {
  const email = senderEmail?.trim();
  if (!email) return false;
  if (opts.isLocallyTrusted(email)) return true;
  return opts.syncEnabled && opts.trustedBookEmails.includes(email.toLowerCase());
}
