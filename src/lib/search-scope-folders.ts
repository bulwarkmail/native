import type { Mailbox } from '../api/types';
import { buildMailboxTree, flattenVisible, type MailboxNode } from './mailbox-tree';

/**
 * The folders the search panel's Folder picker offers: every folder (it was
 * cut at twelve), in sidebar order with each subfolder right after its parent
 * and its `depth` for indenting (webmail lib/search-scope-folders.ts). The
 * open folder is left out: "This folder" picks it. A shared account's
 * grouping row is no folder and is left out too.
 */
export function searchScopeFolders(mailboxes: Mailbox[], currentMailboxId: string | null): MailboxNode[] {
  const tree = buildMailboxTree(mailboxes);
  const all = new Set<string>();
  const collect = (nodes: MailboxNode[]) => {
    for (const n of nodes) {
      all.add(n.id);
      collect(n.children);
    }
  };
  collect(tree);
  return flattenVisible(tree, all).filter((n) => !n.isAccountNode && n.id !== currentMailboxId);
}
