// List-Unsubscribe (RFC 2369 / RFC 8058) and mailto: parsing. Port of the
// relevant parts of the webmail's `lib/validation.ts`.

import {
  decodeMailtoComponent, isValidEmail, parseMailtoUrl as parseSharedMailtoUrl, splitMailtoUrl,
} from './mailto';

export { isValidEmail };

const MAILTO_SCHEME = /^mailto:/i;
const HTTP_SCHEME = /^https?:\/\//i;

/**
 * A usable unsubscribe target: an http(s) URL (scheme in any case) or a
 * mailto: that parseUnsubscribeMailto accepts, so "valid" here means the
 * banner can really act on it.
 */
export function isValidUnsubscribeUrl(url: string): boolean {
  if (!url?.trim()) return false;
  if (MAILTO_SCHEME.test(url)) return parseUnsubscribeMailto(url) !== null;

  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol.toLowerCase());
  } catch {
    return false;
  }
}

export interface UnsubscribeUrls {
  http?: string;
  mailto?: string;
  preferred?: 'http' | 'mailto';
}

/**
 * Parse a List-Unsubscribe header and extract all valid URLs. RFC 2369 allows
 * multiple comma-separated URLs in <url> format.
 */
export function parseUnsubscribeUrls(header: string): UnsubscribeUrls {
  if (!header?.trim()) return {};

  // Same cut as /<([^>]+)>/g, scanned by hand: the regex rescans to the end
  // for every `<` of a header full of them, which is quadratic.
  const urls: string[] = [];
  for (let open = header.indexOf('<'); open !== -1;) {
    const close = header.indexOf('>', open + 1);
    if (close === -1) break;
    if (close > open + 1) urls.push(header.slice(open + 1, close).trim());
    open = header.indexOf('<', close + 1);
  }

  // The first *valid* candidate of each kind: an earlier one that fails the
  // strict parse must not hide a later one that works.
  const http = urls.find((u) => HTTP_SCHEME.test(u) && isValidUnsubscribeUrl(u));
  const mailto = urls.find((u) => MAILTO_SCHEME.test(u) && isValidUnsubscribeUrl(u));

  const preferred = http ? 'http' : (mailto ? 'mailto' : undefined);

  return { http, mailto, preferred };
}

/**
 * RFC 8058 one-click: when the message also carries
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click`, the https URL accepts
 * a POST with that body and unsubscribes without a confirmation page.
 */
export function isOneClickUnsubscribe(listUnsubscribePost: string | undefined, httpUrl: string | undefined): boolean {
  if (!listUnsubscribePost || !httpUrl) return false;
  if (!/^https:\/\//i.test(httpUrl)) return false;
  return /list-unsubscribe\s*=\s*one-click/i.test(listUnsubscribePost);
}

export interface MailtoFields {
  to: string[];
  cc?: string[];
  subject?: string;
  body?: string;
}

/**
 * The shared strict mailto: parser, with the optional-field shape this
 * module's callers (message-body links) expect.
 */
export function parseMailtoUrl(url: string): MailtoFields | null {
  const parsed = parseSharedMailtoUrl(url);
  if (!parsed) return null;
  return { to: parsed.to, cc: parsed.cc.length ? parsed.cc : undefined, subject: parsed.subject, body: parsed.body };
}

export const UNSUBSCRIBE_SUBJECT_MAX = 200;
export const UNSUBSCRIBE_BODY_MAX = 500;

// An unsubscribe address is held to more than isValidEmail: ASCII only
// (bidi/invisible characters in a domain would pass as punycode) and a dotted
// domain.
function isPlainAddress(address: string): boolean {
  return isValidEmail(address) && /^[\x21-\x7e]+@[^@]*\.[^@]*$/.test(address);
}

/**
 * Parse a List-Unsubscribe mailto: URL for a one-click send from the user's
 * own account. The sender wrote this URL, so it is held to what an
 * unsubscribe request needs: exactly one recipient from the address part
 * (to=/cc= fields are ignored, a list of addresses is refused), a
 * single-line subject and a short body.
 */
export function parseUnsubscribeMailto(url: string): { to: [string]; subject?: string; body?: string } | null {
  const parsed = parseMailtoUrl(url);
  if (!parsed) return null;

  const addressPart = splitMailtoUrl(url)?.addressPart ?? '';
  const addresses = addressPart.split(',').filter((a) => a.trim() !== '');
  if (addresses.length !== 1) return null;
  const to = decodeMailtoComponent(addresses[0]).trim();
  if (!isPlainAddress(to)) return null;

  const subject = parsed.subject?.replace(/[\r\n]+/g, ' ').replace(/\p{Cf}/gu, '').trim().slice(0, UNSUBSCRIBE_SUBJECT_MAX) || undefined;
  const body = parsed.body?.slice(0, UNSUBSCRIBE_BODY_MAX) || undefined;
  return { to: [to], subject, body };
}

/** The recipient, then subject and body on their own lines, for the confirmation. */
export function unsubscribeConfirmDetails(fields: { to: [string]; subject?: string; body?: string }): string {
  return [fields.to[0], fields.subject, fields.body].filter((line): line is string => !!line).join('\n');
}
