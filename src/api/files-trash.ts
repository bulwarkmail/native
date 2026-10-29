import type { FileNode } from './types';
import { jmapClient } from './jmap-client';
import {
  createFolder, deleteFileNodes, destroyEmptyFolders, filesAccountId, getAllFileNodes, isCrossAccountId,
  isFolder, updateFileNodes,
} from './files';
import { JMAPSetError } from './jmap-result';
import { getUniqueName } from '../lib/filenode-name';
import {
  TRASH_FOLDER_NAME, findTrashFolder, restoreTarget, trashBatchName, trashPlaces, trashSubtreeIds, trashedItems,
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

/**
 * The drive a write went to: the login (server and user) and its files
 * account. Every write resolves the account when it is sent, and node ids
 * repeat across accounts and servers, so a write prepared for one drive
 * must not go out once another is signed in.
 */
export interface TrashDrive {
  server: string | null;
  username: string | null;
  accountId: string;
}

export function currentTrashDrive(): TrashDrive {
  return { server: jmapClient.serverUrl, username: jmapClient.username, accountId: filesAccountId() };
}

function isCurrentDrive(drive: TrashDrive): boolean {
  const now = currentTrashDrive();
  return now.server === drive.server && now.username === drive.username && now.accountId === drive.accountId;
}

/** Thrown before a write would go to another drive than the one it was prepared for. */
export class TrashDriveChangedError extends Error {
  constructor() {
    super('Another account is signed in');
    this.name = 'TrashDriveChangedError';
  }
}

function assertDrive(drive: TrashDrive | undefined): void {
  if (drive && !isCurrentDrive(drive)) throw new TrashDriveChangedError();
}

/** A delete into the trash, with the drive it went to (for its undo). */
export interface TrashMoveResult extends TrashWriteResult {
  drive: TrashDrive;
}

/**
 * The trash, or a delete's folder in it, can't be made: a file is named
 * `.Trash` at the root, the user may not create folders there, or the quota
 * is used up. Nothing was moved; the items can only be deleted for good.
 */
export class TrashUnavailableError extends Error {
  constructor(readonly reason: unknown) {
    super(reason instanceof Error ? reason.message : 'The trash cannot be used');
    this.name = 'TrashUnavailableError';
  }
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
    throw new TrashUnavailableError(err);
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
 * Stops once another account is signed in. Throws when nothing went.
 */
export async function moveToTrash(
  nodes: FileNode[],
  targets: FileNode[],
  deletedAt: number = Date.now(),
): Promise<TrashMoveResult> {
  const drive = currentTrashDrive();
  const result: TrashMoveResult = { done: [], refused: [], drive };
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
      assertDrive(drive);
      try {
        return await createFolder(name, trash.id);
      } catch (err) {
        throw new TrashUnavailableError(err);
      }
    }
  };

  for (const [parentId, group] of groups) {
    if (!isCurrentDrive(drive)) break;
    let batch: FileNode;
    try {
      batch = await createBatch(parentId);
    } catch (err) {
      // What went already stays in the trash; the rest is reported.
      if (!(err instanceof TrashUnavailableError) || result.done.length === 0) throw err;
      result.refused.push(new JMAPSetError('setError', err.message));
      break;
    }
    if (!isCurrentDrive(drive)) break;
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
    assertDrive(drive);
    throw result.refused[0] ?? new JMAPSetError('setError', 'Failed to move to the trash');
  }
  return result;
}

/**
 * Put items of the trash back into the folder each came from, or the root
 * when that folder is gone or in the trash itself (unless it comes back in
 * the same call). A name taken there by now gets " (1)" and so on. Their
 * trash folders go once they are empty.
 *
 * The drive is read again first, and that is what counts: the listing on
 * screen (for an undo, the one from before the delete) misses a folder
 * trashed since and a name taken since. Items no longer in the trash are left
 * where they are. Throws when nothing of what is still there went, and
 * TrashDriveChangedError, with nothing sent, once `drive` is no longer the
 * one signed in.
 */
export async function restoreFromTrash(items: TrashedItem[], drive?: TrashDrive): Promise<TrashWriteResult> {
  const result: TrashWriteResult = { done: [], refused: [] };
  if (items.length === 0) return result;
  assertDrive(drive);
  const nodes = await getAllFileNodes();
  assertDrive(drive);
  const trash = findTrashFolder(nodes);
  const places = trashPlaces(nodes);
  const { hidden } = places;
  // The items as the trash holds them now: their name and trash folder may
  // have changed on another device.
  const current = new Map(trashedItems(nodes, trash).map((item) => [item.node.id, item]));
  const pending = [...new Set(items.map((item) => item.node.id))].flatMap((id) => {
    const item = current.get(id);
    return item ? [item] : [];
  });
  if (pending.length === 0) return result;
  // Names taken in each folder, so a restored item never clashes. Folders of
  // the trash count too: one restored below may be the target.
  const taken = new Map<string | null, Set<string>>();
  const namesIn = (parentId: string | null): Set<string> => {
    let names = taken.get(parentId);
    if (!names) {
      names = new Set(nodes
        .filter((n) => (n.parentId ?? null) === parentId && !n.isShared)
        .map((n) => n.name));
      // Something named ".Trash" doesn't go back to the root under that name.
      if (parentId === null) names.add(TRASH_FOLDER_NAME);
      taken.set(parentId, names);
    }
    return names;
  };

  // An item may come from a folder that is among the items too, or inside
  // one of them (deleted from it before the folder itself went). Once that
  // item is back, so is the folder: the item waits for it instead of going
  // to the root.
  const restoring = new Set(pending.map((item) => item.node.id));
  const holder = (folderId: string | null): string | null => {
    const seen = new Set<string>();
    for (let cur = folderId ? places.byId.get(folderId) : undefined; cur && hidden.has(cur.id) && !seen.has(cur.id);
      cur = cur.parentId ? places.byId.get(cur.parentId) : undefined) {
      seen.add(cur.id);
      if (restoring.has(cur.id)) return cur.id;
    }
    return null;
  };
  const restored = new Set<string>();
  const tried = new Set<string>();
  const updates: Record<string, Partial<Pick<FileNode, 'name' | 'parentId'>>> = {};
  const targets = new Map<string, string | null>();
  for (let rest = pending; rest.length > 0;) {
    const waits = (item: TrashedItem) => {
      const h = holder(item.fromParentId);
      return h !== null && h !== item.node.id && !tried.has(h);
    };
    let round = rest.filter((item) => !waits(item));
    // Only a loop of folders (impossible in a tree) leaves none ready.
    if (round.length === 0) round = rest;
    rest = rest.filter((item) => !round.includes(item));

    const roundUpdates: typeof updates = {};
    for (const item of round) {
      const from = item.fromParentId;
      const h = holder(from);
      const origin = from ? places.byId.get(from) : undefined;
      const target = h !== null && restored.has(h) && origin && isFolder(origin) && !origin.isShared
        ? from
        : restoreTarget(item, places);
      const used = namesIn(target);
      const name = getUniqueName(item.node.name, used);
      used.add(name);
      // The name only goes along when it has to change: the listing shows a
      // WebDAV name decoded, and sending that back would rename the file.
      roundUpdates[item.node.id] = name === item.node.name ? { parentId: target } : { parentId: target, name };
      targets.set(item.node.id, target);
    }
    Object.assign(updates, roundUpdates);
    assertDrive(drive);
    const update = await updateFileNodes(roundUpdates);
    for (const id of Object.keys(roundUpdates)) tried.add(id);
    for (const id of update.updated) restored.add(id);
    result.refused.push(...Object.values(update.notUpdated));
  }
  if (restored.size === 0) {
    throw result.refused[0] ?? new JMAPSetError('setError', 'Failed to restore');
  }
  for (const item of pending.filter((i) => restored.has(i.node.id))) {
    const name = updates[item.node.id].name ?? item.node.name;
    result.done.push({ ...item, node: { ...item.node, name, parentId: targets.get(item.node.id) ?? null } });
  }
  if (!drive || isCurrentDrive(drive)) {
    await removeEmptyBatches(nodes, result.done.flatMap((i) => (i.batchId ? [i.batchId] : [])), restored);
  }
  return result;
}

/**
 * Undo of a delete into the trash (see restoreFromTrash). Null, and nothing
 * sent, once another account or server is signed in than the one the delete
 * went to: the same ids name other files there.
 */
export async function undoMoveToTrash(moved: Pick<TrashMoveResult, 'done' | 'drive'>): Promise<TrashWriteResult | null> {
  try {
    return await restoreFromTrash(moved.done, moved.drive);
  } catch (err) {
    if (err instanceof TrashDriveChangedError) return null;
    throw err;
  }
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
