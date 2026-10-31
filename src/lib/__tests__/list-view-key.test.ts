import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { listViewKey } from '../list-view-key';

// The list kept its scroll offset when the folder, tag or search changed, so
// the new list opened somewhere in the middle (webmail #1138).

describe('list scroll position on a view switch (bulwarkmail/webmail#1138)', () => {
  it('changes with the folder, the search and the tag, and only with them', () => {
    const base = listViewKey('inbox', '', {});
    expect(listViewKey('inbox', '', {})).toBe(base);
    expect(listViewKey('inbox', ' ', {})).toBe(base);
    expect(listViewKey('archive', '', {})).not.toBe(base);
    expect(listViewKey('inbox', 'invoice', {})).not.toBe(base);
    expect(listViewKey('inbox', '', { keyword: '$label:red' })).not.toBe(base);
  });

  it('scrolls the list to the top when it changes', () => {
    const list = fs.readFileSync(path.resolve(__dirname, '../../screens/EmailListScreen.tsx'), 'utf8');
    expect(list).toMatch(/ref=\{listRef\}/);
    expect(list).toMatch(/listRef\.current\?\.scrollToOffset\(\{ offset: 0, animated: false \}\);\s*\}, \[viewKey\]\);/);
  });
});
