// The mail search's "Search everything" row was drawn over by the search and
// folder chips once results loaded, and was gone once the field lost focus.
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { searchEverythingPlacement } from '../search-everything-entry';

const src = fs.readFileSync(path.resolve(__dirname, '../../screens/EmailListScreen.tsx'), 'utf8');

describe('Search everything in the mail search', () => {
  it('sits in the panel while the field has focus', () => {
    expect(searchEverythingPlacement({ searchFocused: true, hasActiveSearchOrFilter: true })).toBe('panel');
    expect(searchEverythingPlacement({ searchFocused: true, hasActiveSearchOrFilter: false })).toBe('panel');
  });

  it('stays reachable as a chip once the field loses focus with a search on', () => {
    expect(searchEverythingPlacement({ searchFocused: false, hasActiveSearchOrFilter: true })).toBe('chips');
    expect(searchEverythingPlacement({ searchFocused: false, hasActiveSearchOrFilter: false })).toBeNull();
  });

  it('has a row that keeps its height, not flex: 1 in the panel column', () => {
    const row = /<Pressable\s+(?:\/\/[^\n]*\n\s*)*style=\{([^}]+)\}\s+onPress=\{openSearchEverything\}/.exec(src);
    expect(row).not.toBeNull();
    expect(row![1]).not.toContain('recentSearchMain');
    const style = /searchEverythingRow: \{([^}]*)\}/.exec(src);
    expect(style?.[1]).toMatch(/minHeight: 44/);
    expect(style?.[1]).not.toMatch(/flex: 1/);
  });

  it('is rendered where the placement says', () => {
    expect(src).toMatch(/searchEverythingAt === 'panel' && \(/);
    expect(src).toMatch(/searchEverythingAt === 'chips' \? \(\s*<FilterChip[\s\S]{0,200}onPress=\{openSearchEverything\}/);
  });
});
