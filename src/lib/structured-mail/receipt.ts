// Mirrors authenticationResultsOnReceipt of webmail lib/email-headers.ts at
// 609464471; keep the two in step. The app's src/lib/email-headers.ts has
// no receipt check yet.

/**
 * `with` protocols (RFC 3848) that record an authenticated submission: the
 * client handed the message in after logging in, so whatever
 * Authentication-Results it carries below that hop are the client's own text.
 */
const SUBMISSION_PROTOCOL_RE = /\bwith\s+(?:UTF8)?(?:E?SMTP|LMTP)S?A\b/i;

/**
 * Whether the topmost Authentication-Results header looks like it was
 * written by a server that received the message, rather than by whoever
 * composed it. A receiving server writes its Received line first and its
 * Authentication-Results below it (Stalwart and Gmail both do), so: a
 * Received header must sit above the topmost Authentication-Results, and the
 * nearest one must not record an authenticated submission. Takes the headers
 * in message order.
 *
 * This only catches a forged header on its own. Stalwart (0.16 and 1.0)
 * keeps both headers when a signed-in user writes them into a mail they
 * submit over JMAP, and adds nothing above them, so a forged Received line
 * followed by a forged "dkim=pass" arrives exactly like mail from outside.
 * Only the server can tell them apart.
 */
export function authenticationResultsOnReceipt(headers: readonly { name: string; value: string }[]): boolean {
  const index = headers.findIndex((header) => header.name.toLowerCase() === 'authentication-results');
  if (index < 0) return false;
  for (let i = index - 1; i >= 0; i--) {
    if (headers[i].name.toLowerCase() !== 'received') continue;
    return !SUBMISSION_PROTOCOL_RE.test(headers[i].value);
  }
  return false;
}
