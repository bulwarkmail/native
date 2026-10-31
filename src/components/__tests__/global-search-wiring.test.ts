import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Checked on the source: the suite has no React Native renderer.
const read = (file: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', file), 'utf8');

describe('Search everything', () => {
  it('opens from the mail search field with what was typed', () => {
    const source = read('screens/EmailListScreen.tsx');
    expect(source).toMatch(/testID="search-everything"/);
    expect(source).toMatch(/setGlobalSearchOpen\(true\)/);
    expect(source).toMatch(/<GlobalSearchSheet\s+visible=\{globalSearchOpen\}\s+initialQuery=\{searchInput\}/);
  });

  it('searches every kind of every login and opens a hit in its account', () => {
    const source = read('components/search/GlobalSearchSheet.tsx');
    expect(source).toMatch(/providers: GLOBAL_SEARCH_PROVIDERS/);
    expect(source).toMatch(/accounts: getSearchAccounts/);
    expect(source).toMatch(/openHit\(hit, navigation, allHits\)/);
    // Scope and account chips, as in the webmail palette.
    expect(source).toMatch(/global_search\.scope_files/);
    expect(source).toMatch(/global_search\.all_accounts/);
  });
});
