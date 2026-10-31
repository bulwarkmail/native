import { describe, expect, it } from 'vitest';
import { participantSuggestions, participantsFromSuggestion } from '../calendar-participant-suggestions';
import type { RecipientSuggestion } from '../../stores/contacts-store';

const all: RecipientSuggestion[] = [
  { name: 'Team Alpha', email: '', group: { id: 'g1', memberCount: 2 } },
  { name: 'Ana', email: 'ana@example.com' },
  { name: 'Recent Ben', email: 'ben@example.com' },
];
const getAutocomplete = (q: string) => all.filter((s) => (s.name + s.email).toLowerCase().includes(q.toLowerCase()) || q === 'a');
const members = { g1: [{ name: 'Ana', email: 'ana@example.com' }, { name: 'Cem', email: 'cem@example.com' }] } as Record<string, { name: string; email: string }[]>;
const getGroupRecipients = (id: string) => members[id] ?? [];

describe('participantSuggestions', () => {
  it('offers contacts, groups and recent recipients, not the people already invited', () => {
    const shown = participantSuggestions('an', new Set(['ben@example.com']), () => all, getGroupRecipients);
    expect(shown.map((s) => s.name)).toEqual(['Team Alpha', 'Ana']);
  });

  it('drops a group whose members are all invited, and waits for two letters', () => {
    const shown = participantSuggestions('team', new Set(['ana@example.com', 'cem@example.com']), getAutocomplete, getGroupRecipients);
    expect(shown).toEqual([]);
    expect(participantSuggestions('t', new Set(), getAutocomplete, getGroupRecipients)).toEqual([]);
  });
});

describe('participantsFromSuggestion', () => {
  it('invites the members of a picked group who are not invited yet', () => {
    expect(participantsFromSuggestion(all[0], new Set(['ana@example.com']), getGroupRecipients))
      .toEqual([{ name: 'Cem', email: 'cem@example.com' }]);
    expect(participantsFromSuggestion(all[2], new Set(), getGroupRecipients))
      .toEqual([{ name: 'Recent Ben', email: 'ben@example.com' }]);
  });
});
