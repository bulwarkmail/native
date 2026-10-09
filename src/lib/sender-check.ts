// What the reader says about a sender the server's checks don't back, from
// the webmail's components/email/email-viewer.tsx (88893463), as pure
// functions so the choice of words and of actions can be tested.

import type { MessageParams } from '../i18n';
import type { Email } from '../api/types';
import { deriveHeaderInfo, isFromDomainAuthenticated, type EmailHeaderInfo, type SenderVerification } from './email-headers';

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
 * What the blocked-content banner says about the sender:
 * - `offer_trust`: "Always trust this sender". Only on a message that passes
 *   the sender check, the only kind a trusted address loads on its own;
 *   offered elsewhere, the next message would ask again.
 * - `trusted_unverified`: the sender is already trusted but this message
 *   didn't pass, so say why it is blocked.
 * - `none`: neither (an unknown verdict, `undefined`, counts as no pass).
 */
export type TrustSenderBannerMode = 'offer_trust' | 'trusted_unverified' | 'none';

export function trustSenderBannerMode(
  senderEmail: string | null | undefined,
  { listed, senderAuthenticated }: { listed: boolean; senderAuthenticated: boolean | undefined },
): TrustSenderBannerMode {
  if (!senderEmail?.trim()) return 'none';
  if (senderAuthenticated === true) return listed ? 'none' : 'offer_trust';
  return listed ? 'trusted_unverified' : 'none';
}

/**
 * Whether the server's checks positively tie a message to its From domain,
 * from its derived header info (already pinned to the owning server).
 */
export function passesFromHeaderInfo(
  headerInfo: Pick<EmailHeaderInfo, 'auth'>,
  fromEmail: string | null | undefined,
): boolean {
  return isFromDomainAuthenticated(headerInfo.auth, fromEmail);
}

type SenderSource = Pick<Email, 'from' | 'replyTo' | 'to' | 'cc' | 'headers' | 'messageId'>;

/**
 * Who replying to `source` must not file as trusted: every address on it,
 * From, Reply-To, To and Cc (trimmed, lowercased, once each), unless the
 * message passes the sender check (senderPassesCheck). Failed, unverified
 * and no results to judge by all count: replying to a forgery would
 * otherwise trust the forged address, and a reply-all the To and Cc the
 * forger picked.
 * `serverHost` is the owning account's authserv host (authservHostFor),
 * never the live client's.
 */
export function untrustedReplyAddresses(source: SenderSource, serverHost: string | null): string[] {
  if (senderPassesCheck(source, serverHost)) return [];
  const out = new Set<string>();
  for (const a of [...(source.from ?? []), ...(source.replyTo ?? []), ...(source.to ?? []), ...(source.cc ?? [])]) {
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
export function senderPassesCheck(source: Pick<Email, 'from' | 'headers' | 'messageId'>, serverHost: string | null): boolean {
  return passesFromHeaderInfo(deriveHeaderInfo(source, serverHost), source.from?.[0]?.email);
}
