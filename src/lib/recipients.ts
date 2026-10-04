// Recipient parsing / validation for the composer. Port of the webmail's
// lib/validation.ts (isValidEmail, parseMailtoUrl) and the recipient helpers
// in lib/email-composer-utils.ts (splitRecipients, parseRecipient,
// splitPastedRecipients, expandRecipients). All DOM-free.

import { splitMailbox } from './rfc5322-mailbox';
import { toAsciiEmail } from './idn';

/**
 * A composer recipient. Display name is optional; email is required - except
 * for contact-group chips, which carry their already-resolved members and an
 * empty email. Group chips are expanded into their members when the message
 * is sent or saved as a draft (see {@link expandRecipients}).
 */
export interface Recipient {
  name?: string;
  email: string;
  group?: { members: Array<{ name?: string; email: string }> };
}

/**
 * RFC 5322 compliant email validation with security enhancements.
 */
export function isValidEmail(input: string): boolean {
  // An internationalized domain is checked in its ASCII (punycode) form, the
  // form it is sent and stored in.
  const email = toAsciiEmail(input);

  // Length check
  if (!email || email.length > 254) return false;

  // Security: Block control characters and header injection
  if (/[\r\n\0<>]/.test(email)) return false;

  // RFC 5322 compliant regex (simplified but secure)
  const emailRegex = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

  if (!emailRegex.test(email)) return false;

  // Additional checks
  const [localPart, domain] = email.split('@');

  // Local part max 64 chars
  if (localPart.length > 64) return false;

  // Domain validation
  if (domain.length > 255) return false;
  if (domain.startsWith('.') || domain.endsWith('.')) return false;
  if (domain.includes('..')) return false;

  return true;
}

/**
 * True when the angle run that is open at `from` closes before the next one
 * opens. `from` is the index of the character under test (a separator, or the
 * opening `<` itself); the scan starts after it either way. A `>` inside a
 * quoted display name does not close anything, and a `<` with no `>` of its own
 * (or whose `>` sits past a later `<`) can never be an address delimiter, so
 * separators after it must stay separators.
 */
function angleRunCloses(value: string, from: number): boolean {
  let inQuotes = false;
  for (let i = from + 1; i < value.length; i++) {
    const ch = value[i];
    if (inQuotes && ch === '\\') i++;
    else if (ch === '"') inQuotes = !inQuotes;
    else if (inQuotes) continue;
    else if (ch === '>') return true;
    else if (ch === '<') return false;
  }
  return false;
}

/**
 * Splits a recipient string into individual entries on any character in
 * `separators`, treating those characters as literal when they sit inside a
 * quoted display name (`"Doo, John" <john@doo.org>`) or angle brackets
 * (`<a,b@x>`). Trims each part and drops empties.
 *
 * Defaults to comma-only, the (de)serialization boundary used by the composer
 * state and mailto handling. Pasted lists pass a wider set (see
 * {@link splitPastedRecipients}) because they also use `;` and line breaks.
 */
export function splitRecipients(value: string, separators = ','): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  let inAngle = false;
  let inGroup = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (inQuotes && ch === '\\' && i + 1 < value.length) {
      // A quoted-pair: formatRecipient writes a `"` in a display name as
      // `\"`. Taking it as the closing quote let a sender's name like
      // `Support", ceo@corp.example, "x` split into an extra recipient.
      current += ch + value[i + 1];
      i++;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === '<' && !inQuotes) {
      inAngle = true;
      current += ch;
    } else if (ch === '>' && !inQuotes) {
      inAngle = false;
      current += ch;
    } else if (separators.includes(ch) && inAngle && !inQuotes && !inGroup && !angleRunCloses(value, i)) {
      // An unclosed `<` would otherwise swallow every later separator, folding
      // the whole list into one entry that is not an address at all. Inside a
      // group the separators belong to the group, so `inGroup` still wins.
      inAngle = false;
      const trimmed = current.trim();
      if (trimmed) result.push(trimmed);
      current = '';
    } else if (ch === ':' && !inQuotes && !inAngle) {
      // RFC 5322 group syntax ("Team: a@x, b@y;") - keep the whole group,
      // separators inside it included, as a single entry. A colon inside a
      // display name is always quoted (see NAME_NEEDS_QUOTING), so a bare
      // colon reliably opens a group.
      inGroup = true;
      current += ch;
    } else if (ch === ';' && inGroup && !inQuotes && !inAngle) {
      inGroup = false;
      current += ch;
    } else if (separators.includes(ch) && !inQuotes && !inAngle && !inGroup) {
      const trimmed = current.trim();
      if (trimmed) result.push(trimmed);
      current = '';
    } else {
      current += ch;
    }
  }
  const trimmed = current.trim();
  if (trimmed) result.push(trimmed);
  return result;
}

// Display names containing any of these must be wrapped in a quoted-string so
// they survive comma-splitting at the serialization boundary and round-trip.
const NAME_NEEDS_QUOTING = /[,<>"@;:]/;

/**
 * Formats a recipient as a string. Bare email when there's no distinct name;
 * otherwise `Name <email>`, RFC 5322 quoting the name when it contains a comma
 * or other special character.
 */
export function formatRecipient(name: string | undefined, email: string): string {
  const trimmedName = name?.trim();
  if (!trimmedName || trimmedName === email) return email;
  const quoted = NAME_NEEDS_QUOTING.test(trimmedName)
    ? `"${trimmedName.replace(/(["\\])/g, '\\$1')}"`
    : trimmedName;
  return `${quoted} <${email}>`;
}

/** Strips a surrounding quoted-string (and its escapes) from a display name. */
function unquoteName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/\\(["\\])/g, '$1');
  }
  return trimmed;
}

/** Index of the first colon outside quotes/angle brackets, or -1. */
function findTopLevelColon(value: string): number {
  let inQuotes = false;
  let inAngle = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (inQuotes && ch === '\\') i++;
    else if (ch === '"') inQuotes = !inQuotes;
    else if (ch === '<' && !inQuotes) inAngle = true;
    else if (ch === '>' && !inQuotes) inAngle = false;
    else if (ch === ':' && !inQuotes && !inAngle) return i;
  }
  return -1;
}

/**
 * Parses a single recipient string (`Name <email>`, `"Quoted, Name" <email>`,
 * or bare `email`) into a {@link Recipient}. The display name is unquoted.
 * RFC 5322 group syntax (`Team: a@x, b@y;`) parses into a group chip - it is
 * how contact groups round-trip through the composer's string boundaries.
 */
export function parseRecipient(s: string): Recipient {
  const trimmed = s.trim();
  if (trimmed.endsWith(';')) {
    const colon = findTopLevelColon(trimmed);
    if (colon !== -1) {
      const members = splitRecipients(trimmed.slice(colon + 1, -1))
        .map(parseRecipient)
        .filter((m) => m.email && !m.group);
      // Only accept the group form when it actually carries members - typed
      // garbage like "Subject: hello;" stays a plain (invalid) recipient.
      if (members.length > 0) {
        return { name: unquoteName(trimmed.slice(0, colon)), email: '', group: { members } };
      }
    }
  }
  const angleMatch = trimmed.match(/^(.+?)\s*<([^>]+)>$/);
  if (angleMatch) {
    return { name: unquoteName(angleMatch[1]), email: angleMatch[2].trim() };
  }
  return { email: trimmed };
}

/** Parses a serialized comma-separated recipient string into an array. */
export function parseRecipientList(value: string): Recipient[] {
  return splitRecipients(value).map(parseRecipient);
}

/**
 * Formats a single composer recipient, using RFC 5322 group syntax for
 * contact-group chips so they survive the composer's string boundaries.
 */
export function formatRecipientEntry(r: Recipient): string {
  if (r.group) {
    const name = r.name?.trim() || 'Group';
    const quoted = NAME_NEEDS_QUOTING.test(name)
      ? `"${name.replace(/(["\\])/g, '\\$1')}"`
      : name;
    const members = r.group.members.map((m) => formatRecipient(m.name, m.email)).join(', ');
    return `${quoted}: ${members};`;
  }
  return formatRecipient(r.name, r.email);
}

/** Serializes a recipient array into a comma-separated string. */
export function formatRecipientList(recipients: Recipient[]): string {
  return recipients.map(formatRecipientEntry).join(', ');
}

/**
 * Expands contact-group chips into their members for sending and
 * draft-saving. Deduplicates case-insensitively by address across the whole
 * list, keeping the first occurrence - an explicitly added individual wins
 * over the same address arriving again via a group.
 */
export function expandRecipients(recipients: Recipient[]): Recipient[] {
  const seen = new Set<string>();
  const out: Recipient[] = [];
  for (const r of recipients) {
    for (const entry of r.group ? r.group.members : [r]) {
      const key = entry.email.trim().toLowerCase();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(entry.name ? { name: entry.name, email: entry.email } : { email: entry.email });
    }
  }
  return out;
}

/**
 * Top-level split of a pasted block into recipient entries on commas,
 * semicolons and newlines (separators inside a quoted name or angle brackets
 * stay literal).
 */
function splitPasteEntries(value: string): string[] {
  return splitRecipients(value, ',;\n\r');
}

/** True when a whitespace/semicolon token of `value` is an address in its own right. */
function carriesAddress(value: string): boolean {
  return value.split(/[\s;]+/).some((t) => isValidEmail(t.trim().replace(/^<|>$/g, '')));
}

/**
 * Splits typed or pasted text into recipient candidates and partitions them:
 * valid email addresses become `Recipient`s (deduped case-insensitively
 * against `existingEmails` and within the paste), and everything else is
 * returned as `invalid` for the caller to drop back into the input field.
 *
 * Handles both structured and bare lists, preserving display names:
 * - `"Name <email>"` (the whole recipient quoted), `Name <email>`, and
 *   `"Doe, John" <email>` entries are kept intact with their display name.
 * - Bare-address dumps (`a@x.com b@y.com`, spreadsheet columns, comma/space/
 *   semicolon/newline separated) split into one chip per address.
 * - A token wrapped in angle brackets (`<a@x.com>`) is unwrapped before
 *   validating, so an `a <a@x.com>` fragment still yields the address.
 * - `Name <email` entries that lost their closing bracket keep both the name
 *   and the address instead of falling apart into bare words.
 */
export function splitPastedRecipients(
  text: string,
  existingEmails: string[] = [],
): { valid: Recipient[]; invalid: string[] } {
  const seen = new Set(existingEmails.map((e) => e.toLowerCase()));
  const valid: Recipient[] = [];
  const invalid: string[] = [];

  // Adds a recipient if its address is valid and unseen. Returns true when the
  // entry is fully handled (valid or a known duplicate) so the caller can stop.
  const tryAdd = (r: Recipient): boolean => {
    if (!isValidEmail(r.email)) return false;
    const key = r.email.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      valid.push(r.name ? { name: r.name, email: r.email } : { email: r.email });
    }
    return true;
  };

  for (const entry of splitPasteEntries(text)) {
    // 1. Structured: `Name <email>`, a bare address, or the whole
    //    `Name <email>` wrapped in quotes (unwrap once and retry).
    if (tryAdd(parseRecipient(entry))) continue;
    const unwrapped = unquoteName(entry);
    if (unwrapped !== entry && tryAdd(parseRecipient(unwrapped))) continue;

    // 2. `Name <email` with the closing bracket lost - splitMailbox tolerates
    //    the missing `>`, so the display name survives the paste. It keeps the
    //    last angle run only, so everything ahead of it would become display
    //    name: skip this step when that prefix carries an address of its own
    //    (`a@x.com <b@y.com`) rather than silently swallowing it.
    const lastOpenAngle = entry.lastIndexOf('<');
    if (
      lastOpenAngle !== -1 &&
      !carriesAddress(entry.slice(0, lastOpenAngle)) &&
      tryAdd(splitMailbox(entry))
    ) continue;

    // 3. Fallback: a bare-address run (`a@x.com b@y.com`) or a
    //    `John Doe <j@x.com>` fragment where only the <addr> is valid.
    //    Whitespace/semicolon-tokenize; leftover tokens stay behind.
    for (const token of entry.split(/[\s;]+/).map((t) => t.trim()).filter(Boolean)) {
      if (!tryAdd({ email: token.replace(/^<|>$/g, '') })) invalid.push(token);
    }
  }

  return { valid, invalid };
}

/**
 * Parse a `mailto:` URL into composer prefill data. Returns null when the
 * URL carries no valid recipient. Port of the webmail's parseMailtoUrl.
 */
export function parseMailtoUrl(
  url: string,
): { to: string[]; cc?: string[]; bcc?: string[]; subject?: string; body?: string } | null {
  if (!url || !/^mailto:/i.test(url)) return null;

  const rest = url.slice(7);
  const queryIndex = rest.indexOf('?');
  const addressPart = queryIndex === -1 ? rest : rest.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : rest.slice(queryIndex + 1);

  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value.replace(/\+/g, '%20'));
    } catch {
      return value;
    }
  };

  const to = addressPart
    .split(',')
    .map((a) => decode(a).trim())
    .filter((a) => isValidEmail(a));

  const cc: string[] = [];
  const bcc: string[] = [];
  let subject: string | undefined;
  let body: string | undefined;
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq).toLowerCase();
    const value = decode(pair.slice(eq + 1));
    if (key === 'subject') subject = value;
    else if (key === 'body') body = value;
    else if (key === 'to') {
      for (const a of value.split(',').map((s) => s.trim())) if (isValidEmail(a)) to.push(a);
    } else if (key === 'cc') {
      for (const a of value.split(',').map((s) => s.trim())) if (isValidEmail(a)) cc.push(a);
    } else if (key === 'bcc') {
      for (const a of value.split(',').map((s) => s.trim())) if (isValidEmail(a)) bcc.push(a);
    }
  }

  if (to.length === 0 && cc.length === 0 && bcc.length === 0 && !subject && !body) return null;
  return {
    to,
    cc: cc.length ? cc : undefined,
    bcc: bcc.length ? bcc : undefined,
    subject,
    body,
  };
}
