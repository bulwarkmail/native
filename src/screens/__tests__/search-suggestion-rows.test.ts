import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The suggestion panel under the search field is a column whose height is
// its rows'. A row styled with `flex: 1` there gets a zero flex basis, so the
// panel leaves its height out and the filter chips below are drawn over it:
// "Search everything" once (d20532af), then the People rows (25e0b977). No
// React Native renderer in the test env, so this reads the styles the
// panel's rows use.

const src = fs.readFileSync(path.resolve(__dirname, '..', 'EmailListScreen.tsx'), 'utf8');

/** The body of one entry of the screen's StyleSheet (`name: { ... }`). */
function styleBody(name: string): string {
  const m = new RegExp(`\\n\\s+${name}: \\{([^}]*)\\}`).exec(src);
  if (!m) throw new Error(`no style ${name}`);
  return m[1];
}

/** The style names on the rows of a block of the panel. */
function rowStyles(block: string): string[] {
  const names = new Set<string>();
  for (const m of block.matchAll(/<Pressable\s+key=\{[^}]+\}[\s\S]*?style=\{([^}]+)\}/g)) {
    for (const n of m[1].matchAll(/styles\.(\w+)/g)) names.add(n[1]);
  }
  return [...names];
}

describe('search suggestion panel rows', () => {
  it('keep their height, so the filter chips are laid out below them', () => {
    const start = src.indexOf("t('advanced_search.suggestions_people', 'People')");
    expect(start).toBeGreaterThan(0);
    const block = src.slice(start, src.indexOf('</>', start));
    const names = rowStyles(block);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(styleBody(name), name).not.toMatch(/(^|[\s,{])flex: 1\b/);
  });

  it('draws Search everything with a style that keeps its height too', () => {
    expect(styleBody('searchEverythingRow')).not.toMatch(/(^|[\s,{])flex: 1\b/);
  });
});
