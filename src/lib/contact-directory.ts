import type { Principal } from '../api/types';

// The company directory (#1253): the RFC 9670 principals the server lists for
// this account, read-only, for the Contacts "Directory" view and recipient
// lookups. Ported from the webmail's stores/contact-store.ts and
// components/contacts/directory-browser.tsx.

export interface DirectoryEntry {
  id?: string;
  /** Display name: the principal's description, else its name, else the address. */
  name: string;
  email: string;
  description?: string;
  type?: Principal['type'];
}

/**
 * Where the directory load stands:
 * - `unavailable`: the server has no principals capability;
 * - `restricted`: the server refused to list its whole directory (Stalwart
 *   1.0 keeps directory queries off by default, or the account lacks the
 *   right); the entries are the principals the user already knows: their
 *   own account, their groups, the accounts that shared something with them;
 * - `error`: the request failed.
 */
export type DirectoryStatus = 'idle' | 'loading' | 'ready' | 'restricted' | 'unavailable' | 'error';

export function principalsToDirectory(principals: Principal[]): DirectoryEntry[] {
  const entries: DirectoryEntry[] = [];
  const seen = new Set<string>();
  for (const p of principals) {
    // Only principals with an address can be written to.
    const email = p.email?.trim();
    if (!email || seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    entries.push({
      id: p.id,
      name: p.description || p.name || email,
      email,
      description: p.description ?? undefined,
      type: p.type,
    });
  }
  return entries;
}

function matches(entry: DirectoryEntry, q: string): boolean {
  return entry.name.toLowerCase().includes(q)
    || entry.email.toLowerCase().includes(q)
    || (entry.description?.toLowerCase().includes(q) ?? false);
}

/** The entries a search leaves, by name then address. */
export function filterDirectory(entries: DirectoryEntry[], query: string, locale?: string): DirectoryEntry[] {
  const q = query.trim().toLowerCase();
  const matched = q ? entries.filter((e) => matches(e, q)) : entries;
  const collator = new Intl.Collator(locale, { sensitivity: 'base' });
  return [...matched].sort((a, b) => collator.compare(a.name, b.name) || collator.compare(a.email, b.email));
}

/**
 * Recipient suggestions from the directory for what is typed, as the
 * composer's autocomplete shows them: a name only where it says more than the
 * address.
 */
export function directorySuggestions(
  entries: DirectoryEntry[],
  query: string,
  limit = 10,
): Array<{ name: string; email: string }> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: Array<{ name: string; email: string }> = [];
  for (const entry of entries) {
    if (out.length >= limit) break;
    if (!matches(entry, q)) continue;
    out.push({ name: entry.name !== entry.email ? entry.name : '', email: entry.email });
  }
  return out;
}
