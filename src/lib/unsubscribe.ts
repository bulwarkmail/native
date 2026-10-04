// List-Unsubscribe (RFC 2369 / RFC 8058) and mailto: parsing. Port of the
// relevant parts of the webmail's `lib/validation.ts`.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test((value ?? '').trim());
}

export function isValidUnsubscribeUrl(url: string): boolean {
  if (!url?.trim()) return false;

  if (url.startsWith('mailto:')) {
    const email = url.substring(7);
    const emailPart = email.split('?')[0];
    return isValidEmail(emailPart);
  }

  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol);
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

  const matches = header.match(/<([^>]+)>/g);
  if (!matches) return {};

  const urls = matches.map((m) => m.slice(1, -1).trim());

  const http = urls.find((u) =>
    (u.startsWith('http://') || u.startsWith('https://')) && isValidUnsubscribeUrl(u),
  );
  const mailto = urls.find((u) => u.startsWith('mailto:') && isValidUnsubscribeUrl(u));

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
 * Parse a mailto: URL into its parts so the client can send the message
 * itself. Query values are percent-decoded manually rather than via
 * URLSearchParams because RFC 6068 uses %-encoding only - a literal "+" in a
 * subject or address must stay a plus, not become a space.
 */
export function parseMailtoUrl(url: string): MailtoFields | null {
  if (!url || !/^mailto:/i.test(url)) return null;

  const rest = url.slice(7);
  const queryIndex = rest.indexOf('?');
  const addressPart = queryIndex === -1 ? rest : rest.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : rest.slice(queryIndex + 1);

  const decode = (value: string): string => {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  };

  const to = addressPart
    .split(',')
    .map((a) => decode(a).trim())
    .filter((a) => isValidEmail(a));

  let subject: string | undefined;
  let body: string | undefined;
  const cc: string[] = [];
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq).toLowerCase();
    const value = decode(pair.slice(eq + 1));
    if (key === 'subject') subject = value;
    else if (key === 'body') body = value;
    else if (key === 'to') {
      for (const a of value.split(',')) if (isValidEmail(a.trim())) to.push(a.trim());
    } else if (key === 'cc') {
      for (const a of value.split(',')) if (isValidEmail(a.trim())) cc.push(a.trim());
    }
  }

  if (to.length === 0 && cc.length === 0) return null;
  return { to, cc: cc.length ? cc : undefined, subject, body };
}

export const UNSUBSCRIBE_SUBJECT_MAX = 200;
export const UNSUBSCRIBE_BODY_MAX = 500;

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

  const rest = url.slice(7);
  const queryIndex = rest.indexOf('?');
  const addressPart = queryIndex === -1 ? rest : rest.slice(0, queryIndex);
  const addresses = addressPart.split(',').filter((a) => a.trim() !== '');
  if (addresses.length !== 1) return null;
  let to: string;
  try {
    to = decodeURIComponent(addresses[0]).trim();
  } catch {
    to = addresses[0].trim();
  }
  if (!isValidEmail(to)) return null;

  const subject = parsed.subject?.replace(/[\r\n]+/g, ' ').trim().slice(0, UNSUBSCRIBE_SUBJECT_MAX) || undefined;
  const body = parsed.body?.slice(0, UNSUBSCRIBE_BODY_MAX) || undefined;
  return { to: [to], subject, body };
}

/** The recipient, then subject and body on their own lines, for the confirmation. */
export function unsubscribeConfirmDetails(fields: { to: [string]; subject?: string; body?: string }): string {
  return [fields.to[0], fields.subject, fields.body].filter((line): line is string => !!line).join('\n');
}
