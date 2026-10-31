/**
 * Internationalized domain names (IDN) in email addresses (webmail
 * lib/idn.ts, #1100).
 *
 * Stalwart keeps domains in their ASCII (punycode, `xn--`) form and maps a
 * Unicode domain to it on lookup, so the app does the same: whatever the
 * user types is converted to ASCII before it is sent anywhere, and the ASCII
 * form is turned back into Unicode only for display.
 *
 * The webmail converts through the WHATWG URL parser, which React Native's
 * URL doesn't implement for hosts, so ToASCII is done here: NFKC and
 * lowercasing (the UTS #46 mapping for everything a mail domain contains in
 * practice), then RFC 3492 for each non-ASCII label. A decoded domain is
 * only shown when it converts back to exactly the ASCII form it came from.
 */

// Characters that make the input something other than a bare host (path,
// query, port, userinfo, percent-escapes, IPv6) and the URL parser's other
// forbidden host code points.
const NON_HOST_CHARS = /[\s/\\?#@:%[\]<>^|]/;
const ACE_LABEL = /(^|\.)xn--/i;
const NON_ASCII = /[^\x00-\x7f]/;
// UTS #46 label separators: full stop, ideographic, fullwidth, halfwidth.
const SEPARATORS = /[.。．｡]/;

function mapLabel(label: string): string {
  let mapped = label;
  try {
    mapped = mapped.normalize('NFKC');
  } catch {
    // An engine without normalize(): the label as typed.
  }
  return mapped.toLowerCase();
}

/**
 * The ASCII form of a domain (`bücher.de` -> `xn--bcher-kva.de`), lowercased
 * and mapped. Null when the input is not a valid host name.
 */
export function toAsciiDomain(domain: string): string | null {
  const trimmed = domain.trim();
  if (!trimmed || NON_HOST_CHARS.test(trimmed)) return null;
  const labels = trimmed.split(SEPARATORS);
  const out: string[] = [];
  for (let i = 0; i < labels.length; i++) {
    const label = mapLabel(labels[i]);
    if (!label) {
      // Only a trailing dot may leave an empty label.
      if (i === labels.length - 1 && i > 0) {
        out.push('');
        continue;
      }
      return null;
    }
    if (NON_HOST_CHARS.test(label)) return null;
    if (!NON_ASCII.test(label)) {
      // An ACE label must be valid, canonical punycode of a non-ASCII label.
      if (label.startsWith('xn--')) {
        const decoded = decodePunycode(label.slice(4));
        if (decoded === null || !NON_ASCII.test(decoded) || encodePunycode(decoded) !== label.slice(4)) return null;
      }
      out.push(label);
      continue;
    }
    const encoded = encodePunycode(label);
    if (encoded === null) return null;
    out.push(`xn--${encoded}`);
  }
  return out.join('.');
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
  const decoded: string[] = [];
  for (const label of lower.split('.')) {
    if (!label.startsWith('xn--')) {
      decoded.push(label);
      continue;
    }
    const unicode = decodePunycode(label.slice(4));
    if (unicode === null) return domain;
    decoded.push(unicode);
  }
  const unicode = decoded.join('.');
  return toAsciiDomain(unicode) === lower ? unicode : domain;
}

/** The address with its domain in Unicode form, for display. */
export function toUnicodeEmail(address: string): string {
  const at = address.lastIndexOf('@');
  if (at <= 0) return address;
  const domain = address.slice(at + 1);
  const unicode = toUnicodeDomain(domain);
  return unicode === domain ? address : `${address.slice(0, at)}@${unicode}`;
}

/**
 * `toUnicodeEmail` for an address in a message, applied only when it is on
 * one of the user's own domains (taken from `ownAddresses`). Anyone else's
 * IDN domain keeps its xn-- form: a Unicode domain can be drawn to look like
 * a familiar one, and the ASCII form gives such a look-alike away.
 */
export function toUnicodeEmailOnOwnDomains(
  address: string,
  ownAddresses: readonly (string | null | undefined)[],
): string {
  const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
  if (!ACE_LABEL.test(domain)) return address;
  const own = ownAddresses.some((ownAddress) => {
    if (!ownAddress) return false;
    const ascii = toAsciiEmail(ownAddress);
    return ascii.slice(ascii.lastIndexOf('@') + 1).toLowerCase() === domain;
  });
  return own ? toUnicodeEmail(address) : address;
}

// RFC 3492 section 5 parameters.
const BASE = 36;
const T_MIN = 1;
const T_MAX = 26;
const SKEW = 38;
const DAMP = 700;
const INITIAL_BIAS = 72;
const INITIAL_N = 0x80;
const MAX_INT = 0x7fffffff;

function adapt(delta: number, numPoints: number, firstTime: boolean): number {
  let d = firstTime ? Math.floor(delta / DAMP) : Math.floor(delta / 2);
  d += Math.floor(d / numPoints);
  let k = 0;
  while (d > ((BASE - T_MIN) * T_MAX) / 2) {
    d = Math.floor(d / (BASE - T_MIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - T_MIN + 1) * d) / (d + SKEW));
}

function digitValue(code: number): number {
  if (code >= 0x30 && code <= 0x39) return code - 0x16; // 0-9 -> 26-35
  if (code >= 0x41 && code <= 0x5a) return code - 0x41; // A-Z -> 0-25
  if (code >= 0x61 && code <= 0x7a) return code - 0x61; // a-z -> 0-25
  return BASE;
}

function digitChar(d: number): string {
  // 0-25 -> a-z, 26-35 -> 0-9
  return String.fromCharCode(d < 26 ? 0x61 + d : 0x16 + d);
}

/** RFC 3492 section 6.3 encoding of one label (without `xn--`). */
function encodePunycode(input: string): string | null {
  const codePoints = Array.from(input, (ch) => ch.codePointAt(0)!);
  let output = '';
  for (const cp of codePoints) if (cp < 0x80) output += String.fromCharCode(cp);
  const basic = output.length;
  let handled = basic;
  if (basic > 0) output += '-';

  let n = INITIAL_N;
  let delta = 0;
  let bias = INITIAL_BIAS;
  while (handled < codePoints.length) {
    let m = MAX_INT;
    for (const cp of codePoints) if (cp >= n && cp < m) m = cp;
    if (m - n > Math.floor((MAX_INT - delta) / (handled + 1))) return null;
    delta += (m - n) * (handled + 1);
    n = m;
    for (const cp of codePoints) {
      if (cp < n) {
        delta += 1;
        if (delta > MAX_INT) return null;
      }
      if (cp === n) {
        let q = delta;
        for (let k = BASE; ; k += BASE) {
          const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
          if (q < t) break;
          output += digitChar(t + ((q - t) % (BASE - t)));
          q = Math.floor((q - t) / (BASE - t));
        }
        output += digitChar(q);
        bias = adapt(delta, handled + 1, handled === basic);
        delta = 0;
        handled += 1;
      }
    }
    delta += 1;
    n += 1;
  }
  return output;
}

/** RFC 3492 section 6.2 decoding of one label (without `xn--`). */
function decodePunycode(input: string): string | null {
  const output: number[] = [];
  const basic = Math.max(input.lastIndexOf('-'), 0);
  for (let j = 0; j < basic; j++) {
    const code = input.charCodeAt(j);
    if (code >= 0x80) return null;
    output.push(code);
  }

  let n = INITIAL_N;
  let bias = INITIAL_BIAS;
  let i = 0;
  for (let index = basic > 0 ? basic + 1 : 0; index < input.length;) {
    const oldI = i;
    for (let w = 1, k = BASE; ; k += BASE) {
      if (index >= input.length) return null;
      const digit = digitValue(input.charCodeAt(index++));
      if (digit >= BASE || digit > Math.floor((MAX_INT - i) / w)) return null;
      i += digit * w;
      const t = k <= bias ? T_MIN : k >= bias + T_MAX ? T_MAX : k - bias;
      if (digit < t) break;
      if (w > Math.floor(MAX_INT / (BASE - t))) return null;
      w *= BASE - t;
    }
    const length = output.length + 1;
    bias = adapt(i - oldI, length, oldI === 0);
    if (Math.floor(i / length) > MAX_INT - n) return null;
    n += Math.floor(i / length);
    i %= length;
    if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return null;
    output.splice(i++, 0, n);
  }
  if (output.length === 0) return null;
  return String.fromCodePoint(...output);
}
