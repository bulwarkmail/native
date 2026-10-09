// What the reader says about a sender the server's checks don't back, from
// the webmail's components/email/email-viewer.tsx (88893463), as pure
// functions so the choice of words and of actions can be tested.

import type { MessageParams } from '../i18n';
import type { Email } from '../api/types';
import { deriveHeaderInfo, isFromDomainAuthenticated, type SenderVerification } from './email-headers';

export type Translate = (key: string, fallback?: string, params?: MessageParams) => string;

export interface SenderCheckText {
  /** `danger` for a failed check, `warning` for an unverified sender. */
  tone: 'danger' | 'warning';
  label: string;
  message: string;
  caution: string;
}

// Embedding, override and isolate controls (U+202A-202E, U+2066-2069) and the
// directional marks (U+200E, U+200F, U+061C): in a sender-written host they
// could make the shown name read as another.
const BIDI_CONTROLS = /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g;

/** Label, message and caution for the banner and badge; null for a verified sender. */
export function senderCheckText(verification: SenderVerification | null, t: Translate): SenderCheckText | null {
  if (!verification) return null;
  const v = {
    ...verification,
    domain: verification.domain.replace(BIDI_CONTROLS, ''),
    sentFrom: verification.sentFrom?.replace(BIDI_CONTROLS, ''),
  };
  const failed = v.status === 'failed';
  const label = failed
    ? t('email_viewer.sender_check.failed_label', 'Sender check failed')
    : t('email_viewer.sender_check.unverified_label', 'Unverified sender');
  const message = failed
    ? v.sentFrom
      ? t(
        'email_viewer.sender_check.failed_sent_from',
        "This message claims to be from {domain}, but it was sent from {host} and failed {domain}'s sender checks. It may be forged.",
        { domain: v.domain, host: v.sentFrom },
      )
      : t(
        'email_viewer.sender_check.failed',
        "This message claims to be from {domain}, but it failed that domain's sender checks. It may be forged.",
        { domain: v.domain },
      )
    : v.sentFrom
      ? t(
        'email_viewer.sender_check.unverified_sent_from',
        'This message claims to be from {domain}, but it was sent from {host} and has no valid signature from {domain}.',
        { domain: v.domain, host: v.sentFrom },
      )
      : t(
        'email_viewer.sender_check.unverified',
        "This message claims to be from {domain}, but nothing confirms that. It has no valid signature from {domain} and didn't come from a server {domain} authorizes.",
        { domain: v.domain },
      );
  const caution = t(
    'email_viewer.sender_check.caution',
    'Be careful with links, attachments and requests for passwords or payment details.',
  );
  return { tone: failed ? 'danger' : 'warning', label, message, caution };
}

/**
 * Whether to offer "Always trust this sender". Not for a sender the checks
 * don't back: trusting a forged address would load remote content for the
 * next forgery too. Nor while the verdict is unknown (`undefined`); `null`
 * means the checks back the sender or there are none to judge by.
 */
export function canOfferTrustSender(
  senderEmail: string | undefined,
  v: SenderVerification | null | undefined,
): boolean {
  return !!senderEmail && v === null;
}

type SenderSource = Pick<Email, 'from' | 'replyTo' | 'headers' | 'messageId'>;

/**
 * Who replying to `source` must not file as trusted: its From and Reply-To
 * (trimmed, lowercased, once each) when the server's checks flag it, failed
 * or unverified; nobody otherwise. Replying to a forgery would otherwise
 * trust the forged address. `serverHost` is the owning account's authserv
 * host (authservHostFor), never the live client's.
 */
export function untrustedReplyAddresses(source: SenderSource, serverHost: string | null): string[] {
  if (!deriveHeaderInfo(source, serverHost).senderVerification) return [];
  const out = new Set<string>();
  for (const a of [...(source.from ?? []), ...(source.replyTo ?? [])]) {
    const email = a.email?.trim().toLowerCase();
    if (email) out.add(email);
  }
  return [...out];
}

/**
 * Whether the owning server's checks positively tie `source` to its From
 * domain (isFromDomainAuthenticated on the pinned results). Unlike a null
 * sender check, no results to judge by is a no: a trusted address's remote
 * content loads on its own only for a message that passes.
 */
export function senderPassesCheck(source: Omit<SenderSource, 'replyTo'>, serverHost: string | null): boolean {
  return isFromDomainAuthenticated(deriveHeaderInfo(source, serverHost).auth, source.from?.[0]?.email);
}
