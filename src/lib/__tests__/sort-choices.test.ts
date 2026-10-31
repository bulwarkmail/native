import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { sortChoiceChanges, sortChoiceFor } from '../sort-choices';

// The list header only flipped newest/oldest; the order presets were three
// screens away in Settings > Layout (webmail e3f1ccce7 has a Sort menu).

describe('list header sort menu', () => {
  it('names the order the open folder uses', () => {
    expect(sortChoiceFor([], false)).toBe('newest');
    expect(sortChoiceFor([], true)).toBe('oldest');
    expect(sortChoiceFor([{ criterion: 'unread', direction: 'desc' }], false)).toBe('unread');
    expect(sortChoiceFor([{ criterion: 'from', direction: 'asc' }, { criterion: 'receivedAt', direction: 'desc' }], false)).toBe('sender');
    expect(sortChoiceFor([{ criterion: 'unread', direction: 'desc' }, { criterion: 'starred', direction: 'desc' }], false)).toBeNull();
  });

  it('writes the order setting, and widens an Inbox-only order when picked elsewhere', () => {
    expect(sortChoiceChanges('largest', 'inbox', 'inbox')).toEqual({
      messageListOrder: [{ criterion: 'size', direction: 'desc' }], mailSortAscending: false,
    });
    expect(sortChoiceChanges('starred', 'inbox', 'archive')?.messageListOrderScope).toBe('all');
    expect(sortChoiceChanges('oldest', 'inbox', 'archive')).toEqual({ messageListOrder: [], mailSortAscending: true });
  });

  it('opens from the header button', () => {
    const list = fs.readFileSync(path.resolve(__dirname, '../../screens/EmailListScreen.tsx'), 'utf8');
    expect(list).toMatch(/onPress=\{\(\) => setSortMenuOpen\(true\)\}/);
    expect(list).toMatch(/sortChoiceChanges\(choice\.key, messageListOrderScope, currentRole\)/);
  });
});
