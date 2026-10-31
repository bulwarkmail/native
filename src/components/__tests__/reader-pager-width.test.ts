import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Tablet, landscape: the first message opened after a relaunch and a
// rotation showed an empty reading pane (toolbar and bottom bar only). The
// pager laid its pages out at the window's width before it knew the pane's,
// so initialScrollIndex put the open message at the wrong offset, and
// removeClippedSubviews could leave that page detached. The pages now wait
// for the measured width. No React Native renderer in the test env, so this
// checks the wiring.

const src = fs.readFileSync(path.resolve(__dirname, '..', '..', 'screens/EmailThreadScreen.tsx'), 'utf8');

describe('reader pager width', () => {
  it('renders the pages only once the pager is measured', () => {
    expect(src).toMatch(/<View style=\{styles\.pagerViewport\} onLayout=\{onPagerLayout\}>\s+\{measuredWidth > 0 && \(\s+<FlatList/);
    expect(src).toMatch(/const pageWidth = measuredWidth \|\| windowWidth;/);
  });

  it('does not clip the pages away', () => {
    const pager = src.slice(src.indexOf('<FlatList'), src.indexOf('renderItem={({ item, index })'));
    expect(pager).not.toMatch(/^\s+removeClippedSubviews\s*$/m);
  });

  it('re-renders the pages when their width changes', () => {
    expect(src).toMatch(/\(\) => \[cacheVersion, neighboursReady, pageWidth\]/);
  });
});
