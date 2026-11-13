/**
 * The ARF format of a phishing report (RFC 5965, an admin option of
 * Organisation > Security > Phishing reports), ported from the webmail's
 * lib/phishing-report-arf.ts: a multipart/report with
 * report-type=feedback-report and three parts, a short text for people, the
 * machine-readable message/feedback-report (Feedback-Type: fraud, which
 * RFC 5965 §7.3 defines as "fraud or phishing"), and the original whole and
 * unchanged as message/rfc822.
 *
 * JMAP can't set the report-type parameter through Email/set, so this is
 * raw MIME: the original's bytes are downloaded, wrapped and uploaded, then
 * imported and submitted without a Sent copy. The upload counts against
 * the server's upload quota and is limited by maxSizeUpload.
 */

import type { Email } from '../api/types';
import { base64Body, displayName, encodeHeaderWord, headerAtom, randomToken, rfc5322Date } from './mdn';
import { reportSubject } from './phishing-report';

export interface ArfParts {
  /** Everything before the original's bytes. */
  head: string;
  /** Everything after them. */
  tail: string;
}

/** "Reported-Domain": the domain of the original's From, when it has one. */
function senderDomain(email: Pick<Email, 'from'>): string | null {
  const address = email.from?.[0]?.email ?? '';
  const domain = address.slice(address.lastIndexOf('@') + 1);
  return address.includes('@') && /^[A-Za-z0-9.-]+$/.test(domain) ? domain.toLowerCase() : null;
}

/** How the original goes in: message/rfc822 may not be base64-encoded (RFC 2046 §5.2.1). */
export type RawEncoding = '7bit' | '8bit' | 'binary';

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
  appVersion: string;
  recipient?: string;
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
    `User-Agent: Bulwark/${headerAtom(input.appVersion) || 'unknown'}`,
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
  const tail = `\r\n--${boundary}--\r\n`;
  return { head, tail };
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

const DELIVERY_HEADERS = ['delivered-to', 'x-original-to', 'x-delivered-to', 'x-original-delivered-to'];
const ANGLE_ADDRESS = /<\s*([^<>\s@]+@[^<>\s@]+)\s*>/;
const BARE_ADDRESS = /([^\s<>"',;:@]+@[^\s<>"',;:@]+)/;

/**
 * The address the message was delivered to, for Original-Rcpt-To: the
 * topmost delivery header (the last hop, our own server), else the To
 * address that is the reporter's. The webmail's deliveryAddresses.
 */
export function deliveryRecipient(
  email: Pick<Email, 'headers' | 'to'>,
  reporterEmail: string,
): string | undefined {
  for (const name of DELIVERY_HEADERS) {
    for (const header of email.headers ?? []) {
      if (header.name.toLowerCase() !== name) continue;
      const match = header.value.match(ANGLE_ADDRESS) ?? header.value.match(BARE_ADDRESS);
      if (match) return match[1].replace(/\.$/, '');
    }
  }
  const own = reporterEmail.toLowerCase();
  return email.to?.find((addr) => addr.email?.toLowerCase() === own)?.email;
}

/** Joins the report around the original's bytes. */
export function assembleArfReport(parts: ArfParts, original: Uint8Array): Uint8Array {
  const encoder = new TextEncoder();
  // The original goes in byte for byte; the closing boundary needs a line break before it.
  const endsWithBreak = original.length >= 2 && original[original.length - 2] === 0x0d && original[original.length - 1] === 0x0a;
  const head = encoder.encode(parts.head);
  const tail = encoder.encode(endsWithBreak ? parts.tail.slice(2) : parts.tail);
  const out = new Uint8Array(head.length + original.length + tail.length);
  out.set(head, 0);
  out.set(original, head.length);
  out.set(tail, head.length + original.length);
  return out;
}
