// What the reader says about a sender the server's checks don't back, from
// the webmail's components/email/email-viewer.tsx (88893463), as pure
// functions so the choice of words and of actions can be tested.

import type { MessageParams } from '../i18n';
import type { SenderVerification } from './email-headers';

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
