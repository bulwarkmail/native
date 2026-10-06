// The one mailto: parser and email-address validator. `mailto:` links opened
// from other apps, share intents, links inside a message body and the
// List-Unsubscribe header all go through here, so a fix to either lands
// everywhere. Port of the webmail's parseMailtoUrl (lib/validation.ts) with
// cc/bcc support.
//
// Strictness is the unsubscribe parser's (the sender wrote that URL): every
// address is checked after percent-decoding, and one that could be read as
// several recipients or that hides characters (`, < > : ;`, whitespace,
// control, bidi and other invisible format characters) is dropped. Input is
// sender-controlled, so everything here is linear: no nested quantifiers, and
// lengths are capped before any regex runs.

import { toAsciiEmail } from './idn';

export interface ParsedMailto {
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string;
  body?: string;
}

const MAX_ADDRESS = 254;
const MAX_LOCAL = 64;
const MAX_DOMAIN = 253;

// Dot-atom local part (RFC 5322 atext) and LDH domain labels. ATEXT excludes
// the dot, so `ATEXT(\.ATEXT)*` cannot backtrack across the separators.
const ATEXT = "[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+";
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const ADDRESS_RE = new RegExp(`^${ATEXT}(?:\\.${ATEXT})*@${LABEL}(?:\\.${LABEL})*$`);
// Control characters and invisible/bidi format characters (\p{Cf}). Checked on
// the address as given: an IDN domain would otherwise punycode them away.
const HIDDEN_RE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/**
 * One address, nothing else: no display name, angle brackets, list
 * separators, whitespace, control or bidi characters. A non-ASCII domain is
 * checked in its ASCII (punycode) form, the form it is sent and stored in;
 * the local part must be ASCII.
 */
export function isValidEmail(value: string): boolean {
  const input = (value ?? '').trim();
  if (!input || input.length > MAX_ADDRESS || HIDDEN_RE.test(input)) return false;
  const email = toAsciiEmail(input);
  if (email.length > MAX_ADDRESS || !ADDRESS_RE.test(email)) return false;
  const at = email.lastIndexOf('@');
  return at <= MAX_LOCAL && email.length - at - 1 <= MAX_DOMAIN;
}

/**
 * RFC 6068 only percent-encodes: a `+` is a literal plus (sub-addresses such
 * as `alice+news@...`, "a+b" in a subject), not the form-encoding for a space.
 */
export function decodeMailtoComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The part between `mailto:` and `?`, and the query; null for any other scheme. */
export function splitMailtoUrl(url: string): { addressPart: string; query: string } | null {
  if (!url || !/^mailto:/i.test(url)) return null;
  const rest = url.slice(7);
  const queryIndex = rest.indexOf('?');
  return queryIndex === -1
    ? { addressPart: rest, query: '' }
    : { addressPart: rest.slice(0, queryIndex), query: rest.slice(queryIndex + 1) };
}

// A comma-separated list of addresses, as a tapped mailto: link may carry in
// its path or in `to=`/`cc=`/`bcc=`. Each address is decoded, then held to
// isValidEmail on its own, so `a%2Cb@x.com` is one (invalid) address rather
// than two recipients.
function validAddresses(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const address = decodeMailtoComponent(part).trim();
    if (isValidEmail(address)) out.push(address);
  }
  return out;
}

/**
 * Parse a `mailto:` URL (RFC 6068; the scheme is case-insensitive). Invalid
 * addresses are dropped; returns null unless at least one valid recipient
 * (in the path or a to/cc/bcc query field) remains.
 */
export function parseMailtoUrl(url: string): ParsedMailto | null {
  const parts = splitMailtoUrl(url);
  if (!parts) return null;

  const to = validAddresses(parts.addressPart);
  const cc: string[] = [];
  const bcc: string[] = [];
  let subject: string | undefined;
  let body: string | undefined;

  for (const pair of parts.query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq).toLowerCase();
    const raw = pair.slice(eq + 1);
    if (key === 'subject') subject = decodeMailtoComponent(raw);
    else if (key === 'body') body = decodeMailtoComponent(raw);
    else if (key === 'to') to.push(...validAddresses(raw));
    else if (key === 'cc') cc.push(...validAddresses(raw));
    else if (key === 'bcc') bcc.push(...validAddresses(raw));
  }

  if (to.length === 0 && cc.length === 0 && bcc.length === 0) return null;
  return { to, cc, bcc, subject, body };
}
