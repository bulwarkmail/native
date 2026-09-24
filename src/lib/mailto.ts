// Port of the webmail's parseMailtoUrl (lib/validation.ts) with cc/bcc
// support. Used for `mailto:` links opened from other apps and for share
// intents that carry an address.

export interface ParsedMailto {
  to: string[];
  cc: string[];
  bcc: string[];
  subject?: string;
  body?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmail(value: string): boolean {
  return EMAIL_RE.test(value.trim());
}

// RFC 6068 only percent-encodes: a `+` is a literal plus (sub-addresses such
// as `alice+news@…`, "a+b" in a subject), not the form-encoding for a space.
function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function splitAddresses(raw: string): string[] {
  return raw
    .split(',')
    .map((a) => decode(a).trim())
    .filter((a) => isValidEmail(a));
}

/**
 * Parse a `mailto:` URL (RFC 6068). Returns null unless at least one valid
 * recipient (in the path or a `to=` query) is present.
 */
export function parseMailtoUrl(url: string): ParsedMailto | null {
  if (!url || !/^mailto:/i.test(url)) return null;

  const rest = url.slice(7);
  const queryIndex = rest.indexOf('?');
  const addressPart = queryIndex === -1 ? rest : rest.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : rest.slice(queryIndex + 1);

  const to = splitAddresses(addressPart);
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
    else if (key === 'to') to.push(...splitAddresses(value));
    else if (key === 'cc') cc.push(...splitAddresses(value));
    else if (key === 'bcc') bcc.push(...splitAddresses(value));
  }

  if (to.length === 0 && cc.length === 0 && bcc.length === 0) return null;
  return { to, cc, bcc, subject, body };
}
