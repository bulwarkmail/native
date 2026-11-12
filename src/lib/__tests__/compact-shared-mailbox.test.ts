import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { buildMailboxTree, flattenVisible } from '../mailbox-tree';
import { compactSharedTree } from '../compact-shared-mailbox';
import type { Mailbox } from '../../api/types';

// Shared mailboxes always showed as a header with their folders; the webmail
// can fold each into one row (lib/compact-shared-mailbox.ts, fca08981a, #1483).

function box(id: string, role: string | null, extra: Partial<Mailbox> = {}): Mailbox {
  return { id, name: role ?? id, role, totalEmails: 0, unreadEmails: 0, ...extra } as Mailbox;
}

const shared = (raw: string, role: string | null, extra: Partial<Mailbox> = {}) =>
  box(`grp:${raw}`, role, { accountId: 'grp', accountName: 'Support', isShared: true, originalId: raw, ...extra });

const MAILBOXES = [
  box('in', 'inbox'),
  shared('in', 'inbox', { totalEmails: 4 }),
  shared('sent', 'sent'),
  shared('trash', 'trash'),
  shared('drafts', 'drafts', { totalEmails: 1 }),
  shared('cases', null, { name: 'Cases' }),
  shared('sub', null, { name: 'Escalated', parentId: 'grp:in' }),
];

describe('compact shared mailboxes', () => {
  it("folds a shared account into its Inbox's row, named after the account, with empty Trash left out", () => {
    const tree = compactSharedTree(buildMailboxTree(MAILBOXES));
    const row = tree.find((n) => n.id === 'grp:in')!;
    expect(row.compactAccountName).toBe('Support');
    expect(row.depth).toBe(0);
    const ids = row.children.map((n) => n.id);
    // The inbox's own subfolders, then the owners' folders, then the standard ones in sidebar order.
    expect(ids.slice(0, 2)).toEqual(['grp:sub', 'grp:cases']);
    expect([...ids.slice(2)].sort()).toEqual(['grp:drafts', 'grp:sent']);
    expect(row.children.every((n) => n.depth === 1)).toBe(true);
    expect(tree.some((n) => n.isAccountNode)).toBe(false);
    const flat = flattenVisible(tree, new Set(['grp:in']));
    expect(flat.map((n) => n.id)).toContain('grp:cases');
  });

  it('keeps the header of an account without an inbox', () => {
    const tree = compactSharedTree(buildMailboxTree([box('in', 'inbox'), shared('cases', null)]));
    expect(tree.some((n) => n.isAccountNode)).toBe(true);
  });

  it('is a switch in the layout settings that the drawer follows', () => {
    const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '../..', p), 'utf8');
    expect(read('components/settings/LayoutSettings.tsx')).toMatch(/update\('compactSharedMailboxes', v\)/);
    const drawer = read('components/SidebarDrawer.tsx');
    expect(drawer).toMatch(/return compactShared \? compactSharedTree\(full\) : full;/);
    expect(drawer).toMatch(/compactAccountName \?\? localizeMailboxName/);
  });
});
