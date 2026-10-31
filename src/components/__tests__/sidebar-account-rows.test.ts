import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Two accounts with the same name looked alike in the account switcher: both
// rows led with the shared name (webmail 3bb9f7df8). The rows now use
// accountRowText, which leads with the address then, and show IDN addresses
// as written. No React Native renderer in the test env, so this checks the
// wiring; accountRowText itself is covered in account-row-text.test.ts.

describe('account switcher rows in the sidebar', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../SidebarDrawer.tsx'), 'utf8');

  it('titles each row from accountRowText over all accounts', () => {
    expect(src).toMatch(/const rowText = accountRowText\(acc, accounts\);/);
    expect(src).toMatch(/\{toUnicodeEmail\(rowText\.title\)\}/);
    expect(src).not.toMatch(/\{acc\.displayName \|\| acc\.username\}/);
  });

  it('shows the address line only when accountRowText gives one', () => {
    expect(src).toMatch(/\{rowText\.subtitle \? \(\s*<Text style=\{styles\.accountMenuHost\} numberOfLines=\{1\}>\{toUnicodeEmail\(rowText\.subtitle\)\}<\/Text>/);
    expect(src).not.toMatch(/accEmail/);
  });
});
