// Internationalized domain names (IDN) in email addresses and server hosts.
//
// Stalwart keeps domains in their ASCII (punycode, `xn--`) form and maps a
// Unicode domain to it on lookup, so everything the user types is converted to
// ASCII before it goes anywhere (sign-in, discovery, validation); the Unicode
// form is only for display.
//
// Hermes' `URL` does no IDNA, so unlike the webmail (which leans on the WHATWG
// URL parser) this goes through `punycode`. It does the RFC 3492 encoding but
// not the UTS #46 mapping, so case and compatibility forms are folded first.
// The trailing slash keeps the bundler on the npm package rather than Node's
// deprecated built-in of the same name.
import punycode from 'punycode/';

// Characters that would make the input read as something other than a bare
// host (path, query, port, userinfo, percent-escapes, IPv6).
const NON_HOST_CHARS = /[\s/\\?#@:%[\]]/;
const ACE_LABEL = /(^|\.)xn--/i;
const NON_ASCII = /[^\p{ASCII}]/u;
const ASCII_HOST = /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?(?:\.[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?)*$/;

/**
 * The ASCII form of a domain (`bücher.de` -> `xn--bcher-kva.de`), lowercased.
 * Null when the input is not a valid host name.
 */
export function toAsciiDomain(domain: string): string | null {
  const trimmed = domain.trim();
  if (!trimmed || NON_HOST_CHARS.test(trimmed)) return null;
  try {
    const ascii = punycode.toASCII(trimmed.normalize('NFKC').toLowerCase());
    if (ascii.length > 253 || !ASCII_HOST.test(ascii)) return null;
    // An `xn--` label that does not decode is not punycode at all.
    if (ACE_LABEL.test(ascii)) punycode.toUnicode(ascii);
    return ascii;
  } catch {
    return null;
  }
}

/**
 * The address with its domain in ASCII form. Only a non-ASCII domain is
 * touched, so ASCII addresses and bare login names come back unchanged; the
 * local part is never changed (it is case-sensitive to the server).
 */
export function toAsciiEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return address;
  const domain = address.slice(at + 1);
  if (!NON_ASCII.test(domain)) return address;
  const ascii = toAsciiDomain(domain);
  return ascii ? `${address.slice(0, at)}@${ascii}` : address;
}

/**
 * The Unicode form of a domain for display (`xn--bcher-kva.de` -> `bücher.de`).
 * Returns the input unchanged when it has no `xn--` label or does not decode
 * to a valid, canonical domain.
 */
export function toUnicodeDomain(domain: string): string {
  if (!ACE_LABEL.test(domain)) return domain;
  // Punycode keeps the case of its ASCII letters, so decode the lowercased
  // domain or `XN--BCHER-KVA.DE` would come out as `BüCHER.DE`.
  const lower = domain.toLowerCase();
  try {
    const unicode = punycode.toUnicode(lower);
    return toAsciiDomain(unicode) === lower ? unicode : domain;
  } catch {
    return domain;
  }
}

/** The address with its domain in Unicode form, for display. */
export function toUnicodeEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return address;
  const domain = address.slice(at + 1);
  const unicode = toUnicodeDomain(domain);
  return unicode === domain ? address : `${address.slice(0, at)}@${unicode}`;
}
