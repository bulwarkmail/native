import type { FileNode } from './types';
import {
  createFolder, deleteFileNodes, destroyEmptyFolders, getAllFileNodes, isCrossAccountId, updateFileNodes,
} from './files';
import { JMAPSetError } from './jmap-result';
import { getUniqueName } from '../lib/filenode-name';
import {
  TRASH_FOLDER_NAME, findTrashFolder, restoreTarget, trashBatchName, trashSubtreeIds, trashedItems,
  type TrashedItem,
} from '../lib/files-trash';

/*
 * The writes of the Files trash (lib/files-trash has the convention). All of
 * them act on the user's own drive. `nodes` is the drive as last listed; the
 * server has the last word wherever another client may have changed it since.
 */

export interface TrashWriteResult {
  /** What went through: for a delete, the items as they now sit in the trash. */
  done: TrashedItem[];
  /** The server's refusals of the rest. */
  refused: JMAPSetError[];
}

/** The trash folder, created on the first delete. */
async function ensureTrashFolder(nodes: FileNode[]): Promise<FileNode> {
  const known = findTrashFolder(nodes);
  if (known) return known;
  try {
    return await createFolder(TRASH_FOLDER_NAME, null);
  } catch (err) {
    // Another client may have made it since the drive was listed.
    const fresh = findTrashFolder(await getAllFileNodes());
    if (fresh) return fresh;
    throw err;
  }
}

/** Remove the trash folders of `batchIds` that hold nothing once `leaving` are out of them. */
async function removeEmptyBatches(nodes: FileNode[], batchIds: Iterable<string>, leaving: Set<string>): Promise<void> {
  const empty = [...new Set(batchIds)].filter((id) => !nodes.some((n) => n.parentId === id && !leaving.has(n.id)));
  if (empty.length === 0) return;
  await destroyEmptyFolders(empty).catch(() => undefined);
}

/**
 * Move nodes of the user's own drive into the trash: one trash folder per
 * folder they came from, named after the time and that folder, like the
 * webmail does. A node of a shared drive can't go there; delete it instead.
 * Throws when nothing went.
 */
export async function moveToTrash(
  nodes: FileNode[],
  targets: FileNode[],
  deletedAt: number = Date.now(),
): Promise<TrashWriteResult> {
  const result: TrashWriteResult = { done: [], refused: [] };
  if (targets.length === 0) return result;
  if (targets.some((n) => n.isShared || isCrossAccountId(n.id))) {
    throw new JMAPSetError('forbidden', 'Files of a shared drive cannot be moved to the trash');
  }
  const groups = new Map<string | null, FileNode[]>();
  for (const node of targets) {
    const parentId = node.parentId ?? null;
    groups.set(parentId, [...(groups.get(parentId) ?? []), node]);
  }

  let trash = await ensureTrashFolder(nodes);
  const createBatch = async (parentId: string | null): Promise<FileNode> => {
    const name = trashBatchName(parentId, deletedAt);
    try {
      return await createFolder(name, trash.id);
    } catch {
      // The trash on screen may be gone (emptied on another device): read
      // the drive again and try once more.
      trash = await ensureTrashFolder(await getAllFileNodes());
      return createFolder(name, trash.id);
    }
  };

  for (const [parentId, group] of groups) {
    const batch = await createBatch(parentId);
    const update = await updateFileNodes(Object.fromEntries(group.map((n) => [n.id, { parentId: batch.id }])));
    const moved = new Set(update.updated);
    result.refused.push(...Object.values(update.notUpdated));
    if (moved.size === 0) {
      await destroyEmptyFolders([batch.id]).catch(() => undefined);
      continue;
    }
    for (const node of group.filter((n) => moved.has(n.id))) {
      result.done.push({ node: { ...node, parentId: batch.id }, batchId: batch.id, deletedAt, fromParentId: parentId });
    }
  }
  if (result.done.length === 0) {
    throw result.refused[0] ?? new JMAPSetError('setError', 'Failed to move to the trash');
  }
  return result;
}

/**
 * Put items of the trash back into the folder each came from, or the root
 * when that folder is gone or in the trash itself. A name taken there by now
 * gets " (1)" and so on. Their trash folders go once they are empty. Throws
 * when nothing went.
 */
export async function restoreFromTrash(nodes: FileNode[], items: TrashedItem[]): Promise<TrashWriteResult> {
  const result: TrashWriteResult = { done: [], refused: [] };
  if (items.length === 0) return result;
  const hidden = trashSubtreeIds(nodes, findTrashFolder(nodes)?.id);
  const restoring = new Set(items.map((item) => item.node.id));
  // Names taken in each folder, so a restored item never clashes; the items
  // themselves don't count (after an undo the listing may still show them
  // where they were).
  const taken = new Map<string | null, Set<string>>();
  const namesIn = (parentId: string | null): Set<string> => {
    let names = taken.get(parentId);
    if (!names) {
      names = new Set(nodes
        .filter((n) => (n.parentId ?? null) === parentId && !n.isShared && !hidden.has(n.id) && !restoring.has(n.id))
        .map((n) => n.name));
      taken.set(parentId, names);
    }
    return names;
  };

  const updates: Record<string, Partial<Pick<FileNode, 'name' | 'parentId'>>> = {};
  const targets = new Map<string, string | null>();
  for (const item of items) {
    const target = restoreTarget(item, nodes);
    const used = namesIn(target);
    const name = getUniqueName(item.node.name, used);
    used.add(name);
    // The name only goes along when it has to change: the listing shows a
    // WebDAV name decoded, and sending that back would rename the file.
    updates[item.node.id] = name === item.node.name ? { parentId: target } : { parentId: target, name };
    targets.set(item.node.id, target);
  }
  const update = await updateFileNodes(updates);
  result.refused.push(...Object.values(update.notUpdated));
  const restored = new Set(update.updated);
  if (restored.size === 0) {
    throw result.refused[0] ?? new JMAPSetError('setError', 'Failed to restore');
  }
  for (const item of items.filter((i) => restored.has(i.node.id))) {
    const name = updates[item.node.id].name ?? item.node.name;
    result.done.push({ ...item, node: { ...item.node, name, parentId: targets.get(item.node.id) ?? null } });
  }
  await removeEmptyBatches(nodes, result.done.flatMap((i) => (i.batchId ? [i.batchId] : [])), restored);
  return result;
}

/**
 * Delete items of the trash for good, with what is inside a deleted folder.
 * The drive is read again first and only what is still in the trash goes: a
 * row on screen may have been restored or moved out on another device since,
 * and the destroy takes a folder's whole content wherever it sits. Returns
 * how many items went.
 */
export async function purgeFromTrash(items: TrashedItem[]): Promise<number> {
  if (items.length === 0) return 0;
  const nodes = await getAllFileNodes();
  const trash = findTrashFolder(nodes);
  const inTrash = trashSubtreeIds(nodes, trash?.id);
  const ids = new Set(items.map((item) => item.node.id).filter((id) => id !== trash?.id && inTrash.has(id)));
  if (ids.size === 0) return 0;
  // The trash folders the items sit in now, which need not be the ones on screen.
  const batchIds = trashedItems(nodes, trash).flatMap((i) => (i.batchId && ids.has(i.node.id) ? [i.batchId] : []));
  try {
    await deleteFileNodes([...ids]);
  } finally {
    // Also after a partial refusal: the server keeps a trash folder that still holds anything.
    await removeEmptyBatches(nodes, batchIds, ids);
  }
  return ids.size;
}

/** Delete everything in the trash for good. The next delete makes a new trash folder. */
export async function emptyTrash(): Promise<void> {
  // Read again rather than trust the listing on screen: another client may
  // have made the trash since, or put another folder in its place.
  const trash = findTrashFolder(await getAllFileNodes());
  if (trash) await deleteFileNodes([trash.id]);
}
