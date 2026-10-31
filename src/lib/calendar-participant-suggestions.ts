import type { EmailAddress } from '../api/types';
import type { RecipientSuggestion } from '../stores/contacts-store';

/**
 * What the event's participant field suggests for `query`: the composer's
 * autocomplete (contacts, contact groups and recent Sent recipients, webmail
 * participant-input.tsx), without the people already invited and groups
 * whose members all are.
 */
export function participantSuggestions(
  query: string,
  invited: ReadonlySet<string>,
  getAutocomplete: (query: string, limit?: number) => RecipientSuggestion[],
  getGroupRecipients: (groupId: string) => EmailAddress[],
  limit = 6,
): RecipientSuggestion[] {
  const q = query.trim();
  if (q.length < 2) return [];
  return getAutocomplete(q, 16)
    .filter((s) => (s.group
      ? getGroupRecipients(s.group.id).some((m) => !invited.has(m.email.toLowerCase()))
      : !invited.has(s.email.toLowerCase())))
    .slice(0, limit);
}

/** The people a picked suggestion invites: the person, or the group's members not yet invited. */
export function participantsFromSuggestion(
  suggestion: RecipientSuggestion,
  invited: ReadonlySet<string>,
  getGroupRecipients: (groupId: string) => EmailAddress[],
): { name: string; email: string }[] {
  const people = suggestion.group
    ? getGroupRecipients(suggestion.group.id).map((m) => ({ name: m.name ?? '', email: m.email }))
    : [{ name: suggestion.name, email: suggestion.email }];
  const seen = new Set(invited);
  return people.filter((p) => {
    const key = p.email.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
