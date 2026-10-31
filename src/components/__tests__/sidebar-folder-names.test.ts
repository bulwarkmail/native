import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Screen readers couldn't tell which folder was open, and the unread count
// was a button read as "Show unread" with no number (webmail 7c282f1f4).

describe('folder list names', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../SidebarDrawer.tsx'), 'utf8');

  it('marks the open folder as selected and says its unread count with its name', () => {
    expect(src).toMatch(/accessibilityState=\{isAccountHeader \? undefined : \{ selected: isSelected \}\}/);
    expect(src).toMatch(/const accessibleName = isAccountHeader \? label : unreadRowLabel\(label, unread, t\)/);
    const helper = fs.readFileSync(path.resolve(__dirname, '../../lib/unread-row-label.ts'), 'utf8');
    expect(helper).toMatch(/t\('shell\.name_unread', '\{name\}, \{count\} unread', \{ name, count: unread \}\)/);
    expect(src).toMatch(/accessibilityLabel=\{accessibleName\}/);
  });

  it('names the unread filter button with its count', () => {
    expect(src).not.toMatch(/sidebar\.show_unread/);
    expect(src).toMatch(/t\('sidebar\.unread_filter', 'Show unread only \(\{count\}\)', \{ count: unread \}\)/);
  });
});
