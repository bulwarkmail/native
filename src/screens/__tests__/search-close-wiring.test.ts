import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// #127: the X in the mail list's search field shows as soon as the field has
// focus: it clears the text, and on an empty field closes the search. iOS has
// no back button to leave an empty, focused field. No React Native renderer in the test env, so this checks the
// wiring.

const src = fs.readFileSync(path.resolve(__dirname, '..', 'EmailListScreen.tsx'), 'utf8');

describe('mail search close wiring', () => {
  it('shows the X while the field has focus or holds text', () => {
    expect(src).toMatch(/\{\(searchInput\.length > 0 \|\| searchFocused\) && \(\s+<Pressable\s+onPress=\{clearOrCloseSearch\}/);
  });

  it('clears typed text first, then closes the panel and lets go of the keyboard', () => {
    expect(src).toMatch(
      /const clearOrCloseSearch = React\.useCallback\(\(\) => \{\s+if \(searchInput\.length > 0\) \{\s+setSearchInput\(''\);\s+setSearchQuery\(''\);\s+return;\s+\}\s+setSearchFocused\(false\);\s+searchInputRef\.current\?\.blur\(\);/,
    );
  });
});
