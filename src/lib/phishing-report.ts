/**
 * "Report phishing": sends a message to the address the organisation's admin
 * set (policy `organisation.phishingReport`) and moves it to Junk with $junk
 * and $phishing. Port of the webmail's lib/phishing-report.ts and the pure
 * half of lib/phishing-report-arf.ts (50f95f446); the server calls are in
 * src/api/phishing-report.ts.
 *
 * - One report per message: report desks discard reports with several
 *   messages attached, and RFC 5965 §2(e) says one message per report.
 * - No copy in Sent: the admin's mailbox is the record.
 * - Forward format: the original attached by its blobId. ARF (RFC 5965):
 *   raw MIME around the original's bytes, imported and submitted.
 */

import type { Email, Identity } from '../api/types';
import type { OrgPolicy } from './org-policy';
import { encodeHeaderWord, rfc5322Date, utf8ToBase64 } from './mdn';
import { PHISHING_KEYWORD } from './phishing-links';

export { PHISHING_KEYWORD };

export type PhishingReportFormat = 'forward' | 'arf';

export interface PhishingReportSetup {
  address: string;
  format: PhishingReportFormat;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The setup in a policy; null while reporting is off (no address). */
export function phishingReportSetup(policy: Pick<OrgPolicy, 'organisation'> | null | undefined): PhishingReportSetup | null {
  const section = isRecord(policy?.organisation) ? policy!.organisation!.phishingReport : undefined;
  if (!isRecord(section)) return null;
  const address = typeof section.address === 'string' ? section.address.trim() : '';
  if (!address) return null;
  return { address, format: section.format === 'arf' ? 'arf' : 'forward' };
}

/** Folders whose messages are the user's own: nothing to report there. */
const OWN_MAIL_ROLES = new Set(['sent', 'drafts', 'scheduled']);

/**
 * Whether `email`, shown in a folder of `mailboxRole`, can be reported.
 * `folderRoles`: the roles of the folders the message itself is in.
 */
export function isReportable(
  email: Pick<Email, 'blobId' | 'keywords'>,
  mailboxRole?: string | null,
  folderRoles: readonly (string | null | undefined)[] = [],
): boolean {
  if (!email.blobId) return false;
  if (mailboxRole && OWN_MAIL_ROLES.has(mailboxRole)) return false;
  if (folderRoles.some((role) => !!role && OWN_MAIL_ROLES.has(role))) return false;
  if (email.keywords?.$draft) return false;
  // Reported already: it is in Junk with its links off.
  return email.keywords?.[PHISHING_KEYWORD] !== true;
}

/** The subject of the report: Microsoft's reporting mailboxes read "Phishing:" as the verdict. */
export function reportSubject(subject: string | undefined | null): string {
  const clean = (subject ?? '').replace(/[\r\n]+/g, ' ').trim();
  return clean ? `Phishing: ${clean}` : 'Phishing';
}

/** The short text of a forwarded report. English: it is read by the security team, not the user. */
export function reportText(reporter: { name?: string; email: string }): string {
  const who = reporter.name?.trim() ? `${reporter.name.trim()} <${reporter.email}>` : reporter.email;
  return `Reported as phishing by ${who} with Bulwark.\r\nThe reported message is attached unchanged.\r\n`;
}

/** The identity a report goes out from: the login's own address first, never a catch-all. */
export function reporterIdentity(identities: Identity[], username: string): Identity | null {
  const usable = identities.filter((identity) => identity.email && !identity.email.includes('*'));
  const own = username.trim().toLowerCase();
  return usable.find((identity) => identity.email.toLowerCase() === own) ?? usable[0] ?? null;
}

/** The attachment name of the reported message. */
export function reportedMessageName(subject: string | undefined | null): string {
  const clean = (subject ?? '').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  return `${clean || 'message'}.eml`;
}

// ─── ARF (RFC 5965) ─────────────────────────────────────────────────────

/** How the original goes in: message/rfc822 may not be base64-encoded (RFC 2046 §5.2.1). */
export type RawEncoding = '7bit' | '8bit' | 'binary';

export interface ArfParts {
  /** Everything before the original's bytes. */
  head: string;
  /** Everything after them. */
  tail: string;
}

// eslint-disable-next-line no-control-regex
const headerAtom = (value: string) => value.replace(/[\x00-\x20\x7F]+/g, '');

function displayName(value: string): string {
  const encoded = encodeHeaderWord(value);
  if (encoded.startsWith('=?') || !/[()<>[\]:;@\\,."]/.test(encoded)) return encoded;
  return `"${encoded.replace(/["\\]/g, '\\$&')}"`;
}

function randomToken(): string {
  return `${Date.now().toString(36)}.${Math.random().toString(36).slice(2)}`;
}

function base64Body(text: string): string {
  return (utf8ToBase64(text).match(/.{1,76}/g) || []).join('\r\n');
}

/** "Reported-Domain": the domain of the original's From, when it has one. */
function senderDomain(email: Pick<Email, 'from'>): string | null {
  const address = email.from?.[0]?.email ?? '';
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return address.includes('@') && /^[A-Za-z0-9.-]+$/.test(domain) ? domain.toLowerCase() : null;
}

/**
 * The report around the original. `encoding`: what the original's bytes
 * are (rawEncoding). `recipient`: the address the original was delivered
 * to, for Original-Rcpt-To; left out when unknown.
 */
export function buildArfParts(input: {
  email: Pick<Email, 'subject' | 'receivedAt' | 'from'>;
  reporter: { name?: string; email: string };
  to: string;
  encoding: RawEncoding;
  recipient?: string;
  appVersion?: string;
  now?: Date;
}): ArfParts {
  const { email, reporter } = input;
  const fromEmail = headerAtom(reporter.email);
  const domain = fromEmail.split('@')[1] || 'localhost';
  const boundary = `----=_ARF_${randomToken()}`;
  const fromName = reporter.name?.trim() ? displayName(reporter.name.trim()) : '';
  const arrival = email.receivedAt ? new Date(email.receivedAt) : null;
  const reportedDomain = senderDomain(email);
  const human = [
    `This is a phishing report (RFC 5965) sent by ${fromEmail} with Bulwark.`,
    '',
    'The reported message is attached unchanged.',
  ].join('\r\n');
  const report = [
    'Feedback-Type: fraud',
    `User-Agent: Bulwark/${input.appVersion || 'unknown'}`,
    'Version: 1',
    ...(arrival && !Number.isNaN(arrival.getTime()) ? [`Arrival-Date: ${rfc5322Date(arrival)}`] : []),
    ...(input.recipient ? [`Original-Rcpt-To: ${headerAtom(input.recipient)}`] : []),
    ...(reportedDomain ? [`Reported-Domain: ${reportedDomain}`] : []),
  ].join('\r\n');

  const head = [
    `Date: ${rfc5322Date(input.now ?? new Date())}`,
    `From: ${fromName ? `${fromName} <${fromEmail}>` : fromEmail}`,
    `To: ${headerAtom(input.to)}`,
    `Subject: ${encodeHeaderWord(reportSubject(email.subject))}`,
    `Message-ID: <arf.${randomToken()}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: multipart/report; report-type=feedback-report;',
    `\tboundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(human),
    '',
    `--${boundary}`,
    'Content-Type: message/feedback-report',
    'Content-Transfer-Encoding: 7bit',
    '',
    report,
    '',
    `--${boundary}`,
    'Content-Type: message/rfc822',
    'Content-Disposition: attachment; filename="reported-message.eml"',
    `Content-Transfer-Encoding: ${input.encoding}`,
    '',
    '',
  ].join('\r\n');
  return { head, tail: `\r\n--${boundary}--\r\n` };
}

/**
 * 7bit or 8bit lines of at most 998 octets ending in CRLF (RFC 2045 §2.7,
 * §2.8); anything else (a NUL, a bare CR or LF, a longer line) is binary.
 */
export function rawEncoding(bytes: Uint8Array): RawEncoding {
  let eightBit = false;
  let line = 0;
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 0x00) return 'binary';
    if (b === 0x0d) {
      if (bytes[i + 1] !== 0x0a) return 'binary';
      i++;
      line = 0;
      continue;
    }
    if (b === 0x0a) return 'binary';
    if (b > 0x7f) eightBit = true;
    if (++line > 998) return 'binary';
  }
  return eightBit ? '8bit' : '7bit';
}

/** The whole ARF report: the original byte for byte between head and tail. */
export function arfReportBytes(parts: ArfParts, original: Uint8Array): Uint8Array {
  const enc = new TextEncoder();
  const head = enc.encode(parts.head);
  // The closing boundary needs a line break before it.
  const endsWithBreak = original.length >= 2 && original[original.length - 2] === 0x0d && original[original.length - 1] === 0x0a;
  const tail = enc.encode(endsWithBreak ? parts.tail.slice(2) : parts.tail);
  const out = new Uint8Array(head.length + original.length + tail.length);
  out.set(head, 0);
  out.set(original, head.length);
  out.set(tail, head.length + original.length);
  return out;
}
