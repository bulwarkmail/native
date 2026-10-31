import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { searchScopeFolders } from '../search-scope-folders';
import type { Mailbox } from '../../api/types';

// The search panel's Folder picker was a flat list cut at twelve folders, so
// deeper or later folders couldn't be searched on their own (webmail
// lib/search-scope-folders.ts lists them all as a tree).

const box = (id: string, parentId: string | null = null, role: string | null = null) =>
  ({ id, name: id, parentId, role, sortOrder: 0, totalEmails: 0, unreadEmails: 0, isShared: false } as unknown as Mailbox);

describe('search folder picker', () => {
  it('lists every folder, each subfolder after its parent with its depth, without the open one', () => {
    const boxes = [box('inbox', null, 'inbox'), ...Array.from({ length: 15 }, (_, i) => box(`f${String(i).padStart(2, '0')}`)), box('child', 'f03')];
    const list = searchScopeFolders(boxes, 'inbox');
    expect(list).toHaveLength(16);
    const ids = list.map((m) => m.id);
    expect(ids.indexOf('child')).toBe(ids.indexOf('f03') + 1);
    expect(list.find((m) => m.id === 'child')?.depth).toBe(1);
    expect(ids).not.toContain('inbox');
  });

  it('is what the panel shows, uncut', () => {
    const list = fs.readFileSync(path.resolve(__dirname, '../../screens/EmailListScreen.tsx'), 'utf8');
    expect(list).not.toMatch(/\.slice\(0, 12\)/);
    expect(list).toMatch(/searchScopeFolders\(scopedMailboxes, currentMailboxId\)\.map/);
  });
});
