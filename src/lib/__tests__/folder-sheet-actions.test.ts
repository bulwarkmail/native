import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { gateFolderActions, unreadInTree } from '../folder-sheet-actions';

// The folder sheet offered Mark folder as read with nothing unread, and its
// actions ended in an error alert offline (webmail f92b7d942).

const actions = ['read', 'tree', 'mute', 'all', 'empty', 'sub', 'share', 'rename', 'delete'].map((key) => ({ key }));
const disabled = (list: { key: string; disabled?: boolean }[]) => list.filter((a) => a.disabled).map((a) => a.key);

describe('folder sheet actions', () => {
  it('greys out Mark as read with nothing unread in what it covers', () => {
    expect(disabled(gateFolderActions(actions, { offline: false, unreadHere: 0, unreadBelow: 3, unreadAll: 3 }))).toEqual(['read']);
    expect(disabled(gateFolderActions(actions, { offline: false, unreadHere: 0, unreadBelow: 0, unreadAll: 0 }))).toEqual(['read', 'tree', 'all']);
    // An unknown count doesn't grey it out.
    expect(disabled(gateFolderActions(actions, { offline: false }))).toEqual([]);
  });

  it('greys out everything that needs the server while offline, not muting', () => {
    expect(disabled(gateFolderActions(actions, { offline: true, unreadHere: 2 }))).toEqual(
      ['read', 'tree', 'all', 'empty', 'sub', 'share', 'rename', 'delete'],
    );
  });

  it('counts the unread mail of a folder and the folders under it', () => {
    const boxes = [
      { id: 'a', unreadEmails: 0 },
      { id: 'b', parentId: 'a', unreadEmails: 2 },
      { id: 'c', parentId: 'b', unreadEmails: 1 },
      { id: 'd', unreadEmails: 5 },
    ];
    expect(unreadInTree(boxes[0], boxes)).toBe(3);
    expect(unreadInTree(boxes[2], boxes)).toBe(1);
    expect(unreadInTree({ id: 'x' }, boxes)).toBeUndefined();
  });

  it('is what the drawer opens its folder sheets with', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../components/SidebarDrawer.tsx'), 'utf8');
    expect(src.match(/actions: gateFolderActions\(actions, \{/g)).toHaveLength(2);
    expect(src).toMatch(/disabled=\{a\.disabled\}/);
    expect(src).toMatch(/menuAudit\.offline_header/);
  });
});
