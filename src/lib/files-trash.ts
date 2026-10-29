import type { FileNode } from '../api/types';
import { isFolder } from '../api/files';

/*
 * The Files trash, the webmail's convention (lib/files-trash.ts there), so
 * both clients see and restore the same trash. Neither Stalwart 0.16 nor 1.0
 * keeps deleted FileNodes: a destroy removes a node and everything below it
 * for good. So the trash is a folder the clients manage: `.Trash` at the root
 * of the user's own drive, hidden from every listing. Each delete puts its
 * items into a folder of its own inside it, named after when it happened and
 * which folder the items came from (empty for the root):
 *
 *   /.Trash/1730112000000~<parentId>/report.pdf
 *
 * The name is the whole record; nothing else is stored. A drive someone
 * shared has no trash of the user's: what is deleted there is gone.
 */

export const TRASH_FOLDER_NAME = '.Trash';

/** The trash folder of the user's own drive, if there is one yet. */
export function findTrashFolder(nodes: FileNode[]): FileNode | undefined {
  return nodes.find((n) =>
    (n.parentId ?? null) === null
    && n.name === TRASH_FOLDER_NAME
    && !n.isShared
    && !n.id.includes(':')
    && isFolder(n));
}

/**
 * Whether naming a node `name` in `parentId` (create, rename, move or upload)
 * would put it in the trash's place, `.Trash` at the root of the user's own
 * drive: a folder there becomes the trash, and a file there keeps the trash
 * from being made. `nodeId` is the node renamed or moved, if any; one of a
 * shared drive stays in that drive.
 */
export function takesTrashName(name: string, parentId: string | null, nodeId?: string): boolean {
  return name === TRASH_FOLDER_NAME && parentId === null && !(nodeId?.includes(':'));
}

/** The name of the folder one delete's items go into. */
export function trashBatchName(parentId: string | null, deletedAt: number = Date.now()): string {
  return `${deletedAt}~${parentId ?? ''}`;
}

/** When a batch was deleted and from which folder (null: the root); null for any other name. */
export function parseTrashBatchName(name: string): { deletedAt: number; parentId: string | null } | null {
  const match = /^(\d{10,})~([A-Za-z0-9_-]*)$/.exec(name);
  if (!match) return null;
  return { deletedAt: Number(match[1]), parentId: match[2] || null };
}

/** The trash folder and everything in it. */
export function trashSubtreeIds(nodes: FileNode[], trashId: string | undefined): Set<string> {
  const ids = new Set<string>();
  if (!trashId) return ids;
  // One pass over the drive, then down the tree: a pass per level was slow
  // for a deep trash in a large drive.
  const children = new Map<string, string[]>();
  for (const n of nodes) {
    if (!n.parentId) continue;
    const list = children.get(n.parentId);
    if (list) list.push(n.id);
    else children.set(n.parentId, [n.id]);
  }
  const queue = [trashId];
  ids.add(trashId);
  for (let i = 0; i < queue.length; i++) {
    for (const child of children.get(queue[i]) ?? []) {
      if (!ids.has(child)) {
        ids.add(child);
        queue.push(child);
      }
    }
  }
  return ids;
}

/** The nodes without the trash and what is in it: what every listing but the trash's own shows. */
export function withoutTrash(nodes: FileNode[]): FileNode[] {
  const hidden = trashSubtreeIds(nodes, findTrashFolder(nodes)?.id);
  return hidden.size === 0 ? nodes : nodes.filter((n) => !hidden.has(n.id));
}

export interface TrashedItem {
  node: FileNode;
  /** The delete's folder in the trash; null for something put into the trash directly. */
  batchId: string | null;
  /** When it was deleted (ms); null when unknown. */
  deletedAt: number | null;
  /** The folder it came from; null for the root or when unknown. */
  fromParentId: string | null;
}

/** What the trash holds, one entry per deleted item. */
export function trashedItems(nodes: FileNode[], trash: FileNode | undefined = findTrashFolder(nodes)): TrashedItem[] {
  if (!trash) return [];
  const items: TrashedItem[] = [];
  for (const child of nodes.filter((n) => n.parentId === trash.id)) {
    const batch = isFolder(child) ? parseTrashBatchName(child.name) : null;
    if (!batch) {
      items.push({ node: child, batchId: null, deletedAt: null, fromParentId: null });
      continue;
    }
    for (const node of nodes.filter((n) => n.parentId === child.id)) {
      items.push({ node, batchId: child.id, deletedAt: batch.deletedAt, fromParentId: batch.parentId });
    }
  }
  return items;
}

/**
 * What restoreTarget and trashOriginPath look up in a listing, worked out
 * once for it: every row of the trash asks, and each time anew it cost a
 * walk of the whole drive per row.
 */
export interface TrashPlaces {
  byId: Map<string, FileNode>;
  /** The trash and everything in it. */
  hidden: Set<string>;
}

export function trashPlaces(nodes: FileNode[]): TrashPlaces {
  return { byId: new Map(nodes.map((n) => [n.id, n])), hidden: trashSubtreeIds(nodes, findTrashFolder(nodes)?.id) };
}

function placesOf(from: FileNode[] | TrashPlaces): TrashPlaces {
  return Array.isArray(from) ? trashPlaces(from) : from;
}

/**
 * Where a restored item goes: the folder it came from while that is still a
 * folder of the user's own drive outside the trash, the root otherwise.
 */
export function restoreTarget(item: Pick<TrashedItem, 'fromParentId'>, from: FileNode[] | TrashPlaces): string | null {
  const parentId = item.fromParentId;
  if (parentId === null) return null;
  const { byId, hidden } = placesOf(from);
  const folder = byId.get(parentId);
  return folder && isFolder(folder) && !folder.isShared && !hidden.has(folder.id) ? parentId : null;
}

/**
 * The path of the folder a deleted item came from ("/Documents/Taxes", "/"
 * for the root); null when that folder is gone.
 */
export function trashOriginPath(item: Pick<TrashedItem, 'fromParentId'>, from: FileNode[] | TrashPlaces): string | null {
  if (item.fromParentId === null) return '/';
  const places = placesOf(from);
  if (restoreTarget(item, places) === null) return null;
  const { byId } = places;
  const names: string[] = [];
  const seen = new Set<string>();
  for (let cur = byId.get(item.fromParentId); cur && !seen.has(cur.id); cur = cur.parentId ? byId.get(cur.parentId) : undefined) {
    seen.add(cur.id);
    names.unshift(cur.name);
  }
  return `/${names.join('/')}`;
}
