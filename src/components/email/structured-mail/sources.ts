// Mirrors webmail components/email/structured-mail/sources.ts at 66c73d0f4;
// keep the two in step. App: the blob context is the JMAP account id alone,
// since the app has one client (api/jmap-client).
import type { Email } from '../../../api/types';
import type { StructuredCard } from '../../../lib/structured-mail';

/**
 * Card sources beyond the HTML markup, read asynchronously once a trusted
 * message is open (Apple Wallet passes among its attachments). Each gets the
 * message and returns cards that are validated but not zone-resolved; the
 * hook merges them with the markup cards and resolves zones for all. A
 * source must read only `email.attachments` (never parts unwrapped from an
 * attached message) and must not throw.
 */
export interface CardSourceContext {
  email: Email;
  mailDate: Date;
  /** JMAP account the message's blobs live in; undefined for the primary account. */
  accountId: string | undefined;
  signal: AbortSignal;
}

export type CardSource = (context: CardSourceContext) => Promise<StructuredCard[]>;

/** Registered sources. */
export const CARD_SOURCES: CardSource[] = [];
