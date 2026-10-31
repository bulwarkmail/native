import type { RecipientSuggestion } from '../stores/contacts-store';

// The composer's recipient suggestions, in the webmail's order
// (stores/contact-store.ts getAutocomplete, email-composer.tsx
// handleServerSearch): contacts and groups, then people in the company
// directory (RFC 9670 principals), then recent recipients from the Sent
// folder, then what an on-demand search of the Sent folder found. An address
// shows once, first where it comes up; a directory entry lends its name to a
// contact suggestion that has none.

export interface SuggestionSources {
  /** getAutocomplete's answer: contacts and groups first, then recent recipients. */
  local: RecipientSuggestion[];
  /** Whether a local suggestion is a contact or a group (the rest are recent recipients). */
  isContact: (s: RecipientSuggestion) => boolean;
  /** lookupDirectory's answer. */
  directory: RecipientSuggestion[];
  /** searchRecipients' answer for the same query, once asked for. */
  server: RecipientSuggestion[];
  /** Addresses already on the message (lowercase); groups are always offered. */
  exclude: ReadonlySet<string>;
  /** How many contact, directory and recent suggestions to show. Server hits come on top. */
  limit: number;
}

export function mergeRecipientSuggestions(src: SuggestionSources): RecipientSuggestion[] {
  const out: RecipientSuggestion[] = [];
  const seen = new Map<string, RecipientSuggestion>();
  const offer = (s: RecipientSuggestion): boolean => {
    if (s.group) {
      out.push(s);
      return true;
    }
    const key = s.email.trim().toLowerCase();
    if (!key || seen.has(key) || src.exclude.has(key)) return false;
    const copy = { ...s };
    seen.set(key, copy);
    out.push(copy);
    return true;
  };

  const contacts = src.local.filter((s) => src.isContact(s));
  const recent = src.local.filter((s) => !src.isContact(s));
  for (const s of contacts) offer(s);
  for (const s of src.directory) {
    const known = seen.get(s.email.trim().toLowerCase());
    if (known) {
      if (!known.name && s.name) known.name = s.name;
      continue;
    }
    offer(s);
  }
  for (const s of recent) offer(s);
  const shown = out.slice(0, src.limit);
  // What fell past the limit may come back from the server search.
  const shownKeys = new Set(shown.filter((s) => !s.group).map((s) => s.email.trim().toLowerCase()));
  for (const s of src.server) {
    const key = s.email.trim().toLowerCase();
    if (!key || shownKeys.has(key) || src.exclude.has(key)) continue;
    shownKeys.add(key);
    shown.push({ ...s });
  }
  return shown;
}
