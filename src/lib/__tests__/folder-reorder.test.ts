import { describe, it, expect } from 'vitest';
import { planFolderMove, siblingsOf, withSortOrders, withUnlistedFolders } from '../folder-reorder';
import { buildMailboxTree, flattenAll, SHARED_ACCOUNT_NODE_PREFIX } from '../mailbox-tree';
import type { Mailbox } from '../../api/types';

const RIGHTS: Mailbox['myRights'] = {
  mayReadItems: true,
  mayAddItems: true,
  mayRemoveItems: true,
  maySetSeen: true,
  maySetKeywords: true,
  mayCreateChild: true,
  mayRename: true,
  mayDelete: true,
  maySubmit: true,
};

function mb(id: string, name: string, extra: Partial<Mailbox> = {}): Mailbox {
  return {
    id,
    name,
    totalEmails: 0,
    unreadEmails: 0,
    totalThreads: 0,
    unreadThreads: 0,
    myRights: RIGHTS,
    ...extra,
  };
}

describe('planFolderMove', () => {
  it('moving down swaps with the next sibling and numbers the group 1..n', () => {
    expect(planFolderMove(
      [{ id: 'a', sortOrder: 0 }, { id: 'b', sortOrder: 0 }, { id: 'c', sortOrder: 0 }],
      'a',
      'down',
    )).toEqual([{ id: 'b', sortOrder: 1 }, { id: 'a', sortOrder: 2 }, { id: 'c', sortOrder: 3 }]);
  });

  it('returns only folders whose number changes', () => {
    expect(planFolderMove(
      [{ id: 'a', sortOrder: 1 }, { id: 'b', sortOrder: 2 }, { id: 'c', sortOrder: 3 }],
      'c',
      'up',
    )).toEqual([{ id: 'c', sortOrder: 2 }, { id: 'b', sortOrder: 3 }]);
  });

  it('numbers a folder the server sent without a sortOrder', () => {
    expect(planFolderMove([{ id: 'a' }, { id: 'b' }], 'b', 'up'))
      .toEqual([{ id: 'b', sortOrder: 1 }, { id: 'a', sortOrder: 2 }]);
  });

  it('does nothing at the top or bottom edge', () => {
    const g = [{ id: 'a', sortOrder: 0 }, { id: 'b', sortOrder: 0 }];
    expect(planFolderMove(g, 'a', 'up')).toEqual([]);
    expect(planFolderMove(g, 'b', 'down')).toEqual([]);
  });

  it('does nothing for a folder outside the group', () => {
    expect(planFolderMove([{ id: 'a', sortOrder: 0 }], 'z', 'down')).toEqual([]);
  });
});

describe('siblingsOf', () => {
  const mailboxes = [
    mb('inbox', 'Inbox', { role: 'inbox' }),
    mb('work', 'Work'),
    mb('w-b', 'Beta', { parentId: 'work' }),
    mb('w-a', 'Alpha', { parentId: 'work' }),
    mb('s1', 'Team', { isShared: true, accountId: 'shared-1', accountName: 'Team' }),
  ];

  it('finds the siblings of a subfolder in displayed order, never an account header', () => {
    const tree = buildMailboxTree(mailboxes);
    expect(siblingsOf(tree, 'w-b')?.map((n) => n.id)).toEqual(['w-a', 'w-b']);
    const top = siblingsOf(tree, 'work')?.map((n) => n.id);
    expect(top).toEqual(['inbox', 'work']);
    expect(top?.some((id) => id.startsWith(SHARED_ACCOUNT_NODE_PREFIX))).toBe(false);
  });

  it('returns null for a folder not in the tree', () => {
    expect(siblingsOf(buildMailboxTree(mailboxes), 'nope')).toBeNull();
  });

  it('renumbers the Scheduled folder with its siblings, as Settings shows it', () => {
    const withScheduled = [...mailboxes, mb('sched', 'Scheduled', { role: 'scheduled' })];
    const group = siblingsOf(buildMailboxTree(withScheduled), 'inbox')?.map((n) => n.id);
    expect(group).toContain('sched');
    expect(group).toHaveLength(3);
    const plan = planFolderMove(siblingsOf(buildMailboxTree(withScheduled), 'inbox')!, 'inbox', 'down');
    expect(plan.map((u) => u.id).sort()).toEqual(['inbox', 'sched', 'work']);
  });
});

describe('withUnlistedFolders', () => {
  it('lists a folder the tree drops as a duplicate of a role folder, at the top level', () => {
    const list = [
      mb('sent', 'Sent', { role: 'sent' }),
      mb('sent-dup', 'Sent'),
      mb('work', 'Work'),
    ];
    const rows = withUnlistedFolders(flattenAll(buildMailboxTree(list)), list);
    expect(rows.map((r) => r.id)).toEqual(['sent', 'work', 'sent-dup']);
    expect(rows[2]).toMatchObject({ id: 'sent-dup', depth: 0, children: [] });
  });

  it('returns the rows unchanged when the tree lists every folder', () => {
    const list = [mb('a', 'A'), mb('b', 'B', { parentId: 'a' })];
    const rows = flattenAll(buildMailboxTree(list));
    expect(withUnlistedFolders(rows, list)).toBe(rows);
  });
});

describe('withSortOrders', () => {
  it('withSortOrders patches only the named folders', () => {
    const list = [mb('a', 'A', { sortOrder: 5 }), mb('b', 'B'), mb('c', 'C', { sortOrder: 9 })];
    const out = withSortOrders(list, [{ id: 'b', sortOrder: 1 }, { id: 'a', sortOrder: 2 }]);
    expect(out.map((m) => [m.id, m.sortOrder])).toEqual([['a', 2], ['b', 1], ['c', 9]]);
    expect(out[2]).toBe(list[2]);
    expect(list[0].sortOrder).toBe(5);
  });

  it('returns the same list when there is nothing to patch', () => {
    const list = [mb('a', 'A')];
    expect(withSortOrders(list, [])).toBe(list);
  });
});
