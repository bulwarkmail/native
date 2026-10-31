import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { showsDefaultBadge } from '../address-book-rows';

describe('Settings > Contacts address book rows', () => {
  it('marks only the user’s own default book as Default, not a group’s', () => {
    expect(showsDefaultBadge({ isDefault: true, isShared: false })).toBe(true);
    expect(showsDefaultBadge({ isDefault: true, isShared: true })).toBe(false);
    expect(showsDefaultBadge({ isDefault: false, isShared: false })).toBe(false);
    expect(showsDefaultBadge({})).toBe(false);
  });

  it('is what the rows use, and the page loads the books when it opens', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..', 'ContactsSettings.tsx'), 'utf8');
    expect(src).toMatch(/\{showsDefaultBadge\(book\) \? ` · \$\{t\('contacts\.address_books\.default', 'Default'\)\}` : ''\}/);
    expect(src).toMatch(/React\.useEffect\(\(\) => \{ void fetchAddressBooks\(\); \}, \[fetchAddressBooks\]\);/);
  });
});
