import { filesAccountId, getFileListing, isFolder, peekFileListing, supportsFiles } from '../../../api/files';
import type { FileNode } from '../../../api/types';
import { matchesTerms, type ParsedQuery } from '../query-parser';
import type { FileHit, SearchAccount, SearchProvider } from '../types';
import { isShownAndServed, searchShown, shownCacheAccount } from './shown';

// Files of the shown account only (no detached read path for files). They
// have no usable server search (FileNode/query matches `name` exactly), so
// both passes filter the account's full listing, which files.ts caches for a
// minute per account and drops on every file write.

/** The folder path a node lives in (`/` for the root): the inverse of the files screen's path lookup. */
export function pathOfNode(nodes: FileNode[], node: FileNode): string {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const segments: string[] = [];
  const seen = new Set<string>();
  let parentId = node.parentId;
  while (parentId != null && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    segments.unshift(parent.name);
    parentId = parent.parentId;
  }
  return `/${segments.join('/')}`;
}

/** Raw server id of a node (the listing namespaces shared ones as `${owner}:${id}`). */
export function rawFileNodeId(node: FileNode): string {
  if (node.isShared && node.accountId && node.id.startsWith(`${node.accountId}:`)) {
    return node.id.slice(node.accountId.length + 1);
  }
  return node.id;
}

function filterNodes(
  parsed: ParsedQuery,
  nodes: FileNode[],
  account: SearchAccount,
  limit: number,
  source: 'local' | 'remote',
): FileHit[] {
  const hits: FileHit[] = [];
  if (limit <= 0) return hits;
  const ownJmapId = filesAccountId();
  for (const node of nodes) {
    const folder = isFolder(node);
    if (!matchesTerms(parsed.terms, [node.name, folder ? 'folder' : node.type])) continue;
    const folderPath = pathOfNode(nodes, node);
    hits.push({
      kind: 'files',
      serverUrl: account.serverUrl,
      appAccountId: account.appAccountId,
      jmapAccountId: node.accountId ?? ownJmapId,
      id: rawFileNodeId(node),
      accountLabel: account.label,
      title: node.name,
      subtitle: [node.isShared && node.accountName ? node.accountName : '', folderPath].filter(Boolean).join(' · '),
      date: node.modified || node.created || null,
      source,
      node,
      folderPath,
      isFolder: folder,
    });
    if (hits.length >= limit) break;
  }
  return hits;
}

export const filesProvider: SearchProvider = {
  kind: 'files',

  supports: (account) => isShownAndServed(account.appAccountId) && supportsFiles(),

  local: (parsed, accounts, limit) => {
    const account = shownCacheAccount(accounts);
    const nodes = account ? peekFileListing(account.appAccountId) : null;
    return account && nodes ? filterNodes(parsed, nodes, account, limit, 'local') : [];
  },

  remote: (parsed, account, { limit, signal }) => searchShown(account, signal, async (at) => {
    const nodes = await getFileListing(account.appAccountId, at);
    const hits = filterNodes(parsed, nodes, account, limit + 1, 'remote');
    return { hits: hits.slice(0, limit), hasMore: hits.length > limit };
  }),
};
