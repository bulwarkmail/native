/**
 * DATA_SYNC1 of a contacts data row: which card entry (or entries) the row
 * was written from. Keys are hints, not identity (docs/device-sync.md, "Row
 * matching"): editors that re-insert rows drop them.
 *
 *   name                                  the StructuredName row
 *   emails:work1                          one entry of a map
 *   organizations:o1|titles:t1,r1         an organization with its title and role key
 *   titles:,r1                            a role without an organization
 *   relatedTo:urn:uuid:…                  relatedTo is keyed by its value
 *   members:<acct>/<groupCardId>          a group membership
 *
 * Map keys may hold any character; `%`, `|` and `,` are escaped so the
 * organization form stays parseable.
 */

export const NAME_KEY = 'name';

const escapeKey = (key: string) => key.replace(/%/g, '%25').replace(/\|/g, '%7C').replace(/,/g, '%2C');

function unescapeKey(text: string): string | null {
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

export function entryKey(map: string, key: string): string {
  return `${map}:${escapeKey(key)}`;
}

/** `{ map, key }` of a simple entry key; null for the name, organizations and anything unreadable. */
export function parseEntryKey(text: string | null): { map: string; key: string } | null {
  if (!text) return null;
  const colon = text.indexOf(':');
  if (colon <= 0) return null;
  const map = text.slice(0, colon);
  if (map === 'organizations' || map === 'titles') return null;
  const key = unescapeKey(text.slice(colon + 1));
  return key ? { map, key } : null;
}

export interface OrgKeyParts {
  org: string | null;
  title: string | null;
  role: string | null;
}

export function orgKey({ org, title, role }: OrgKeyParts): string {
  const titles = title || role ? `titles:${title ? escapeKey(title) : ''},${role ? escapeKey(role) : ''}` : '';
  if (org === null) return titles;
  return titles ? `organizations:${escapeKey(org)}|${titles}` : `organizations:${escapeKey(org)}`;
}

export function parseOrgKey(text: string | null): OrgKeyParts | null {
  if (!text) return null;
  const m = /^(?:organizations:([^|]*))?(?:\|?titles:([^,]*),([^,]*))?$/.exec(text);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  const part = (s: string | undefined) => (s ? unescapeKey(s) : null);
  const org = part(m[1]);
  if (m[1] !== undefined && !org) return null;
  const parts = { org, title: part(m[2]), role: part(m[3]) };
  return parts.org || parts.title || parts.role ? parts : null;
}
