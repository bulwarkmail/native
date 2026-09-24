// Builds an RFC 8098 Message Disposition Notification (MDN) as a raw RFC 5322
// message string. JMAP/Stalwart has no native MDN support, so the client
// constructs the multipart/report itself and sends it via
// blob-upload -> Email/import -> EmailSubmission/set (see api/email sendMdn).
// Port of the webmail's `lib/mdn.ts`.
//
// The message has two parts:
//   1. text/plain  - human-readable explanation (rarely shown)
//   2. message/disposition-notification - the machine-readable fields
// The optional third part (original message/headers) is omitted; RFC 8098 §3.1
// permits a two-part report.

export interface MdnOptions {
  /** Address that requested the receipt (Disposition-Notification-To) - the MDN recipient. */
  to: string;
  /** Our identity address (sender of the MDN). */
  fromEmail: string;
  /** Optional display name for the From header. */
  fromName?: string;
  /** Original Message-ID. JMAP may hand this back as a string[]. */
  originalMessageId?: string | string[] | null;
  /** Original Subject (used to build the MDN subject). */
  originalSubject?: string;
  /**
   * The address the original message was delivered to (our address/alias).
   * Used for Final-Recipient/Original-Recipient. Falls back to fromEmail.
   */
  originalRecipient?: string;
  /** true => automatic-action (setting "always"); false => manual-action (user tapped send). */
  automatic?: boolean;
  /** Reporting-UA value, e.g. "mail.example; Bulwark Mobile". */
  reportingUa?: string;
  /** Localized full Subject line. Defaults to "Read: <originalSubject>". */
  subject?: string;
  /** Localized human-readable explanation (first report part). Defaults to English. */
  humanText?: string;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** RFC 5322 date in UTC, e.g. "Thu, 28 May 2026 14:23:00 +0000". */
export function rfc5322Date(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]}, ${pad(d.getUTCDate())} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} `
    + `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} +0000`;
}

function utf8Bytes(value: string): Uint8Array {
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value);
  // Hermes ships TextEncoder; this is a defensive fallback for test runtimes.
  const out: number[] = [];
  for (const ch of value) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
  }
  return new Uint8Array(out);
}

/** UTF-8 string -> base64. */
export function utf8ToBase64(value: string): string {
  const bytes = utf8Bytes(value);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** UTF-8 base64 body, wrapped at 76 chars per RFC 2045. */
function base64Body(text: string): string {
  return (utf8ToBase64(text).match(/.{1,76}/g) || []).join('\r\n');
}

/**
 * Remove the characters that must never reach a header we assemble as text:
 * CR, LF, the remaining C0 controls and DEL. Runs collapse to one space.
 *
 * Every value that lands in a header here ultimately comes from the message
 * we are answering (its Subject, Message-ID, Disposition-Notification-To),
 * and Stalwart hands those back already RFC 2047-decoded. A sender can
 * therefore smuggle a bare CRLF past SMTP inside an encoded-word; if it were
 * interpolated verbatim it would terminate the header and let the sender
 * append headers and a body of their choosing to a message the user's own
 * account submits (GHSA-w38p-hpqv-g89c).
 */
function stripHeaderControls(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x1F\x7F]+/g, ' ').trim();
}

/** Address-like atoms (mailboxes, message-ids) may contain no whitespace at all. */
function headerAtom(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\x00-\x20\x7F]+/g, '');
}

/**
 * Header value safe to place after "Name: ". Control characters are stripped
 * first; the result is RFC 2047-encoded when it contains non-ASCII.
 */
export function encodeHeaderWord(value: string): string {
  const clean = stripHeaderControls(value);
  if (!/[^\x20-\x7E]/.test(clean)) return clean;
  return `=?UTF-8?B?${utf8ToBase64(clean)}?=`;
}

/** Display-name for a mailbox: encoded-word if non-ASCII, quoted if it uses specials. */
function displayName(value: string): string {
  const encoded = encodeHeaderWord(value);
  if (encoded.startsWith('=?') || !/[()<>[\]:;@\\,."]/.test(encoded)) return encoded;
  return `"${encoded.replace(/["\\]/g, '\\$&')}"`;
}

function ensureAngles(messageId: string | string[] | null | undefined): string {
  const raw = Array.isArray(messageId) ? messageId[0] : messageId;
  if (typeof raw !== 'string') return '';
  const trimmed = headerAtom(raw);
  if (!trimmed) return '';
  return trimmed.startsWith('<') ? trimmed : `<${trimmed}>`;
}

function randomToken(): string {
  const rnd = Math.random().toString(36).slice(2);
  return `${Date.now().toString(36)}.${rnd}`;
}

/**
 * Build the raw RFC 5322 MDN message. Lines are CRLF-terminated as required
 * by the MIME standard so the bytes import/transmit verbatim.
 */
export function buildMdnMessage(opts: MdnOptions): string {
  // Everything interpolated into a header line goes through headerAtom /
  // encodeHeaderWord so that no CR/LF (or other control) can split a line.
  const to = headerAtom(opts.to);
  const fromEmail = headerAtom(opts.fromEmail);
  const originalRecipient = opts.originalRecipient ? headerAtom(opts.originalRecipient) : '';
  const finalRecipient = originalRecipient || fromEmail;
  const domain = fromEmail.split('@')[1] || 'localhost';
  const messageId = `<mdn.${randomToken()}@${domain}>`;
  const boundary = `----=_MDN_${randomToken()}`;
  const origMsgId = ensureAngles(opts.originalMessageId);

  const fromName = opts.fromName ? displayName(opts.fromName) : '';
  const fromHeader = fromName ? `${fromName} <${fromEmail}>` : fromEmail;

  const subject = encodeHeaderWord(
    opts.subject ?? `Read: ${opts.originalSubject || ''}`.trim(),
  );

  const disposition = opts.automatic
    ? 'automatic-action/MDN-sent-automatically; displayed'
    : 'manual-action/MDN-sent-manually; displayed';

  const reportingUa = stripHeaderControls(opts.reportingUa || '') || `${domain}; Bulwark Mobile`;

  const humanText = opts.humanText ?? [
    `This is a return receipt for the message you sent to ${finalRecipient}.`,
    '',
    'Note: This receipt only acknowledges that the message was displayed on the',
    "recipient's device. There is no guarantee that the recipient has read or",
    'understood the message contents.',
  ].join('\r\n');

  const mdnFields = [
    `Reporting-UA: ${reportingUa}`,
    `Final-Recipient: rfc822;${finalRecipient}`,
    ...(originalRecipient ? [`Original-Recipient: rfc822;${originalRecipient}`] : []),
    ...(origMsgId ? [`Original-Message-ID: ${origMsgId}`] : []),
    `Disposition: ${disposition}`,
  ].join('\r\n');

  return [
    `Date: ${rfc5322Date()}`,
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    ...(origMsgId ? [`In-Reply-To: ${origMsgId}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: multipart/report; report-type=disposition-notification;',
    `\tboundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Body(humanText),
    '',
    `--${boundary}`,
    'Content-Type: message/disposition-notification',
    'Content-Transfer-Encoding: 7bit',
    '',
    mdnFields,
    '',
    `--${boundary}--`,
    '',
  ].join('\r\n');
}
