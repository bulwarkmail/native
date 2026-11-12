import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { selectionRecipients } from '../contact-bulk';
import type { ContactCard } from '../../api/types';

// Webmail 1.21: ticked contacts could be exported, moved, tagged and deleted,
// but not written to or added to a group.
const card = (id: string, full: string, address?: string): ContactCard =>
  ({ id, addressBookIds: {}, name: { full }, ...(address ? { emails: { e: { address } } } : {}) }) as ContactCard;

describe('one message to the ticked contacts', () => {
  it('writes to each contact once, by name', () => {
    expect(selectionRecipients([
      card('a', 'Anna Berg', 'anna@example.org'),
      card('b', 'Ben', 'BEN@example.org'),
      card('b2', 'Ben again', 'ben@example.org'),
    ])).toEqual([
      { name: 'Anna Berg', email: 'anna@example.org' },
      { name: 'Ben', email: 'BEN@example.org' },
    ]);
  });

  it('leaves out contacts without an address, and a name that is only the address', () => {
    expect(selectionRecipients([card('a', 'No mail'), card('c', 'c@example.org', 'c@example.org')]))
      .toEqual([{ name: '', email: 'c@example.org' }]);
  });
});

// No render setup in the repo: the selection header is checked for the two
// actions and the sheets they open.
describe('the contacts selection header', () => {
  const src = readFileSync(join(__dirname, '../../screens/ContactsScreen.tsx'), 'utf-8');

  it('sends one message to everyone ticked', () => {
    expect(src).toMatch(/onPress=\{handleBulkCompose\}/);
    expect(src).toMatch(/navigation\.navigate\('Compose', \{ prefillTo: recipients \}\)/);
  });

  it('adds the ticked contacts to a group, or makes one of them', () => {
    expect(src).toMatch(/onPress=\{handleBulkAddToGroup\}/);
    expect(src).toMatch(/await addContactsToGroup\(groupId, ids\)/);
    expect(src).toMatch(/navigation\.navigate\('ContactForm', \{ asGroup: true, memberIds: ids \}\)/);
  });
});
