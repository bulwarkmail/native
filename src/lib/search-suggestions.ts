// People suggested while a search is typed (webmail lib/search-suggestions.ts,
// 4c5f3d8f2): the contacts that match, then the senders of the mail already
// loaded, so an account without contacts still gets suggestions. Each
// address once.

export interface PersonSuggestion {
  name: string;
  email: string;
}

/** Contact and sender matches shown while typing. */
export const MAX_PERSON_SUGGESTIONS = 5;

/** Senders of the loaded messages whose name or address contains the query. */
export function listSenderMatches(
  emails: ReadonlyArray<{ from?: ReadonlyArray<{ name?: string | null; email?: string | null }> | null }>,
  query: string,
  limit = MAX_PERSON_SUGGESTIONS,
): PersonSuggestion[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const found: PersonSuggestion[] = [];
  const seen = new Set<string>();
  for (const email of emails) {
    const sender = email.from?.[0];
    const address = sender?.email?.trim();
    if (!address) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    const name = sender?.name?.trim() ?? '';
    if (!key.includes(q) && !name.toLowerCase().includes(q)) continue;
    seen.add(key);
    found.push({ name, email: address });
    if (found.length >= limit) break;
  }
  return found;
}

/** `first`, then `more`, each address once, at most `limit`. */
export function mergePersonSuggestions(
  first: readonly PersonSuggestion[],
  more: readonly PersonSuggestion[],
  limit = MAX_PERSON_SUGGESTIONS,
): PersonSuggestion[] {
  const out: PersonSuggestion[] = [];
  const seen = new Set<string>();
  for (const person of [...first, ...more]) {
    const email = person.email.trim();
    const key = email.toLowerCase();
    if (!email || seen.has(key)) continue;
    seen.add(key);
    out.push({ name: person.name.trim(), email });
    if (out.length >= limit) break;
  }
  return out;
}
