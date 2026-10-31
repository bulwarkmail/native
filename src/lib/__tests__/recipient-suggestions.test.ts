import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { mergeRecipientSuggestions } from '../recipient-suggestions';
import type { RecipientSuggestion } from '../../stores/contacts-store';

// The composer's suggestions in the webmail's order: contacts and groups,
// directory people, recent recipients, then what "Search the server" found
// in the Sent folder (parity 06 autocomplete row).

const contact = (name: string, email: string): RecipientSuggestion => ({ name, email });
const contactEmails = new Set(['ann@example.com', 'nameless@example.com']);
const isContact = (s: RecipientSuggestion) => !!s.group || contactEmails.has(s.email);

describe('mergeRecipientSuggestions', () => {
  it('puts directory people after contacts and before recent recipients', () => {
    const out = mergeRecipientSuggestions({
      local: [contact('Ann', 'ann@example.com'), contact('Recent Rob', 'rob@example.com')],
      isContact,
      directory: [contact('Dana Directory', 'dana@example.com')],
      server: [],
      exclude: new Set(),
      limit: 8,
    });
    expect(out.map((s) => s.email)).toEqual(['ann@example.com', 'dana@example.com', 'rob@example.com']);
  });

  it('lists an address once and lends a directory name to a contact without one', () => {
    const out = mergeRecipientSuggestions({
      local: [contact('', 'nameless@example.com'), contact('Recent Dana', 'dana@example.com')],
      isContact,
      directory: [contact('Nora Nameless', 'Nameless@example.com'), contact('Dana Directory', 'dana@example.com')],
      server: [],
      exclude: new Set(),
      limit: 8,
    });
    expect(out).toEqual([
      { name: 'Nora Nameless', email: 'nameless@example.com' },
      { name: 'Dana Directory', email: 'dana@example.com' },
    ]);
  });

  it('adds server hits below the rest, skipping known and selected addresses', () => {
    const local = Array.from({ length: 10 }, (_, i) => contact(`Recent ${i}`, `r${i}@example.com`));
    const out = mergeRecipientSuggestions({
      local,
      isContact,
      directory: [],
      server: [contact('R0 again', 'r0@example.com'), contact('Picked', 'picked@example.com'), contact('Found', 'found@example.com'), contact('R9', 'r9@example.com')],
      exclude: new Set(['picked@example.com']),
      limit: 8,
    });
    // Eight local ones, then the server's new ones; r9 fell past the limit
    // and comes back from the server.
    expect(out.map((s) => s.email)).toEqual([
      ...local.slice(0, 8).map((s) => s.email), 'found@example.com', 'r9@example.com',
    ]);
  });

  it('keeps groups and leaves out addresses already on the message', () => {
    const group: RecipientSuggestion = { name: 'Team', email: '', group: { id: 'g1', memberCount: 3 } };
    const out = mergeRecipientSuggestions({
      local: [group, contact('Ann', 'ann@example.com')],
      isContact,
      directory: [contact('Ann', 'ANN@example.com')],
      server: [],
      exclude: new Set(['ann@example.com']),
      limit: 8,
    });
    expect(out).toEqual([group]);
  });
});

// No React Native renderer in the test env: the composer is checked for the
// wiring.
describe('composer suggestions wiring', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../screens/ComposeScreen.tsx'), 'utf8');

  it('merges contacts, directory people and server hits', () => {
    expect(src).toMatch(/mergeRecipientSuggestions\(\{\s*local: getAutocomplete\(q, 16\),/);
    expect(src).toMatch(/directory: lookupDirectory\(q, 16\),/);
    expect(src).toMatch(/server: serverHits\?\.query === q \? serverHits\.results : \[\],/);
    expect(src).toMatch(/if \(directoryStatus === 'idle' && !loginMovedFrom\(ownerLoginRef\.current\)\) void fetchDirectory\(\);/);
  });

  it('offers "Search the server" when a Sent folder is known, on the composer\'s login only', () => {
    expect(src).toMatch(/const results = await searchRecipients\(q\);/);
    expect(src).toMatch(/if \(!q \|\| searchingServer \|\| loginMovedFrom\(ownerLoginRef\.current\)\) return;/);
    expect(src).toMatch(/onSearchServer=\{canSearchServer \?/);
    const list = fs.readFileSync(path.resolve(__dirname, '../../components/compose/RecipientSuggestionList.tsx'), 'utf8');
    expect(list).toMatch(/t\('email_composer\.autocomplete_search_server', 'Search the server'\)/);
  });
});
