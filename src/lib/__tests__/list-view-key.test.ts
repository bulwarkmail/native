import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { listViewKey } from '../list-view-key';

// The list kept its scroll offset when the folder, tag or search changed, so
// the new list opened somewhere in the middle (webmail #1138).

describe('list scroll position on a view switch (bulwarkmail/webmail#1138)', () => {
  it('changes with the account, the folder, the search and the tag, and only with them', () => {
    const base = listViewKey('acc1', 'inbox', '', {});
    expect(listViewKey('acc1', 'inbox', '', {})).toBe(base);
    expect(listViewKey('acc1', 'inbox', ' ', {})).toBe(base);
    expect(listViewKey('acc1', 'archive', '', {})).not.toBe(base);
    expect(listViewKey('acc1', 'inbox', 'invoice', {})).not.toBe(base);
    expect(listViewKey('acc1', 'inbox', '', { keyword: '$label:red' })).not.toBe(base);
  });

  it("changes on a switch to another account's folder of the same id", () => {
    // Stalwart gives every account's Inbox the same id ("a").
    expect(listViewKey('usera@server', 'a', '', {})).not.toBe(listViewKey('userb@server', 'a', '', {}));
  });

  it('scrolls the list to the top when it changes', () => {
    const list = fs.readFileSync(path.resolve(__dirname, '../../screens/EmailListScreen.tsx'), 'utf8');
    expect(list).toMatch(/ref=\{listRef\}/);
    expect(list).toMatch(/const viewKey = listViewKey\(listAccountId, currentMailboxId, storeSearchQuery, filters\);/);
    expect(list).toMatch(/const listAccountId = useEmailStore\(\(s\) => s\.activeAccountId\);/);
    expect(list).toMatch(/listRef\.current\?\.scrollToOffset\(\{ offset: 0, animated: false \}\);\s*\}, \[viewKey\]\);/);
  });

  it('scrolls the unified inbox to the top when its accounts change', () => {
    const unified = fs.readFileSync(path.resolve(__dirname, '../../screens/UnifiedInboxScreen.tsx'), 'utf8');
    expect(unified).toMatch(/<FlatList\s+ref=\{listRef\}/);
    expect(unified).toMatch(/listRef\.current\?\.scrollToOffset\(\{ offset: 0, animated: false \}\);\s*\}, \[accountIds\]\);/);
  });
});
