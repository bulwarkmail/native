import type { Mailbox } from '../api/types';
import type { MailboxNode } from './mailbox-tree';

/** One folder's new position, as `Mailbox/set` writes it. */
export interface SortOrderUpdate {
  id: string;
  sortOrder: number;
}

/**
 * The sibling group, in displayed order, that holds `id`. Account header
 * nodes are virtual, so they never join a group the server is asked to
 * renumber. Null when `id` is not in the tree.
 */
export function siblingsOf(tree: MailboxNode[], id: string): MailboxNode[] | null {
  const search = (nodes: MailboxNode[]): MailboxNode[] | null => {
    if (nodes.some((n) => n.id === id && !n.isAccountNode)) {
      return nodes.filter((n) => !n.isAccountNode);
    }
    for (const n of nodes) {
      const found = search(n.children);
      if (found) return found;
    }
    return null;
  };
  return search(tree);
}

/**
 * Move `id` one place within its group and number the whole group 1..n, as
 * the webmail does, so the saved order no longer depends on ties broken by
 * role or name. Only the folders whose number changes are returned; a move
 * past either edge returns nothing.
 */
export function planFolderMove(
  siblings: Pick<Mailbox, 'id' | 'sortOrder'>[],
  id: string,
  direction: 'up' | 'down',
): SortOrderUpdate[] {
  const from = siblings.findIndex((s) => s.id === id);
  if (from < 0) return [];
  const to = direction === 'up' ? from - 1 : from + 1;
  if (to < 0 || to >= siblings.length) return [];

  const ordered = [...siblings];
  [ordered[from], ordered[to]] = [ordered[to], ordered[from]];
  const out: SortOrderUpdate[] = [];
  ordered.forEach((s, i) => {
    if (s.sortOrder !== i + 1) out.push({ id: s.id, sortOrder: i + 1 });
  });
  return out;
}

/** `mailboxes` with the planned numbers laid over, shown while the write is in flight. */
export function withSortOrders(mailboxes: Mailbox[], updates: SortOrderUpdate[]): Mailbox[] {
  if (updates.length === 0) return mailboxes;
  const next = new Map(updates.map((u) => [u.id, u.sortOrder]));
  return mailboxes.map((m) => {
    const sortOrder = next.get(m.id);
    return sortOrder === undefined ? m : { ...m, sortOrder };
  });
}
