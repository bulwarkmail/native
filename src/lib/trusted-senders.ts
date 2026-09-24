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
    /** The "Sync trusted senders to address book" setting (null = never chosen, off). */
    syncEnabled: boolean | null;
    /** Lowercased addresses filed in the "Trusted Senders" book. */
    trustedBookEmails: readonly string[];
  },
): boolean {
  const email = senderEmail?.trim();
  if (!email) return false;
  if (opts.isLocallyTrusted(email)) return true;
  return !!opts.syncEnabled && opts.trustedBookEmails.includes(email.toLowerCase());
}
