import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { addressBookLabel } from '../address-book-label';

describe('addressBookLabel', () => {
  it('names a shared book once when Stalwart already put the account in its name', () => {
    // As Stalwart 0.16 and 1.0 name a group's default book.
    expect(addressBookLabel({ name: 'Stalwart Address Book (team@example.org)', isShared: true, accountName: 'team@example.org' }))
      .toBe('Stalwart Address Book (team@example.org)');
  });

  it('adds the account to a shared book whose name does not say where it is from', () => {
    expect(addressBookLabel({ name: 'Clients', isShared: true, accountName: 'team@example.org' })).toBe('Clients (team@example.org)');
    expect(addressBookLabel({ name: 'Clients', isShared: false, accountName: 'usera@example.org' })).toBe('Clients');
  });

  it('is what the contact form shows', () => {
    const form = fs.readFileSync(path.resolve(__dirname, '../../screens/ContactFormScreen.tsx'), 'utf8');
    expect(form).toMatch(/\{addressBookLabel\(book\)\}/);
    expect(form).not.toMatch(/\$\{book\.name\} \(\$\{book\.accountName\}\)/);
  });
});
