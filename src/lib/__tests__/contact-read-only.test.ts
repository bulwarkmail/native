import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isContactReadOnly } from '../contact-read-only';

const books = [
  { id: 'own', myRights: { mayRead: true, mayWrite: true, mayShare: true, mayDelete: true } },
  { id: 'acc:ro', myRights: { mayRead: true, mayWrite: false, mayShare: false, mayDelete: false } },
  { id: 'plain' },
];

describe('contacts in a read-only address book', () => {
  it('counts a contact in a book shared read-only as read-only', () => {
    expect(isContactReadOnly({ addressBookIds: { 'acc:ro': true } }, books)).toBe(true);
  });

  it('leaves contacts in writable books, books without rights and unknown books editable', () => {
    expect(isContactReadOnly({ addressBookIds: { own: true } }, books)).toBe(false);
    expect(isContactReadOnly({ addressBookIds: { plain: true } }, books)).toBe(false);
    expect(isContactReadOnly({ addressBookIds: { gone: true, 'acc:ro': false } }, books)).toBe(false);
  });

  // No render setup in the repo: the detail screen is checked for hiding
  // Edit, Move and Delete behind the helper.
  it('is what the contact screen hides Edit, Move and Delete by', () => {
    const src = readFileSync(join(__dirname, '../../screens/ContactDetailScreen.tsx'), 'utf-8');
    expect(src).toMatch(/const readOnly = isContactReadOnly\(contact, addressBooks\);/);
    expect(src).toMatch(/\{!readOnly && \(\r?\n\s*<Pressable\r?\n\s*onPress=\{\(\) => navigation\.navigate\('ContactForm', \{ contactId: contact\.id \}\)\}/);
    expect(src).toMatch(/!readOnly && addressBooks\.length > 0 && \{/);
    expect(src).toMatch(/!readOnly && \{\r?\n\s*icon: <Trash2/);
  });
});
