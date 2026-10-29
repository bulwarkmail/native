import type { FileNode } from '../api/types';

/**
 * What the Files screen offers for a node another account shared with the
 * user (or a node of a shared drive). The writes go to that account
 * (api/files resolveFileNodeId); what the server allows there is the node's
 * `myRights`. Own nodes may do everything, as before.
 *
 * A shared root (the node the user was given, at the top of "Shared with
 * me") is never renamed, deleted or moved from here: it sits in the owner's
 * tree, under folders the user can't see. Moving any shared node is left
 * out, like in the webmail: a node can only move within its own account,
 * and the picker lists the user's own folders.
 */
export interface FileNodeAccess {
  rename: boolean;
  delete: boolean;
  move: boolean;
  /** A copy next to the original: needs the right to add to its folder. */
  duplicate: boolean;
}

const ALL: FileNodeAccess = { rename: true, delete: true, move: true, duplicate: true };

function sharedParent(node: FileNode, nodes: FileNode[]): FileNode | undefined {
  if (node.parentId == null) return undefined;
  return nodes.find((n) => n.id === node.parentId && !n.discoverableOnly);
}

export function fileNodeAccess(node: FileNode, nodes: FileNode[]): FileNodeAccess {
  if (!node.isShared) return ALL;
  const parent = sharedParent(node, nodes);
  if (!parent) return { rename: false, delete: false, move: false, duplicate: false };
  const rights = node.myRights;
  return {
    rename: !!rights?.mayRename,
    delete: !!rights?.mayDelete,
    move: false,
    duplicate: !!parent.myRights?.mayAddChildren,
  };
}

/**
 * Whether new folders and uploads may go into the folder `folderId` (null:
 * the user's own drive root). Inside a shared folder only with its
 * `mayAddChildren`; Stalwart 0.16 reports a child of a shared folder with
 * every right false, so there it is offered in the shared folder itself.
 */
export function mayCreateIn(folderId: string | null, nodes: FileNode[]): boolean {
  if (folderId === null) return true;
  const folder = nodes.find((n) => n.id === folderId);
  if (!folder) return false;
  if (!folder.isShared) return true;
  return !folder.discoverableOnly && !!folder.myRights?.mayAddChildren;
}
