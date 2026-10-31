// Starred folders and recent files of the Files tab, and the walks that open
// a folder by its path or a node where it is listed. Port of the webmail's
// file-store favorites/recentFiles (kept by path and by id, at most 20
// recent files, 8 of them shown) and navigateByPath/revealNode.
import type { FileNode } from '../api/types';
import { isFolder, listFolder } from '../api/files';

/** One folder of the stack the Files tab stands in. */
export interface FolderStep {
  id: string;
  name: string;
}

export interface RecentFile {
  id: string;
  name: string;
  timestamp: number;
}

export const RECENT_FILES_MAX = 20;
/** How many recent files the root of the Files tab lists (webmail RECENT_LIMIT). */
export const RECENT_FILES_SHOWN = 8;

/** `/A/B` for the stack A > B; `/` for the root. */
export function folderPathOf(stack: FolderStep[]): string {
  return `/${stack.map((s) => s.name).join('/')}`;
}

/** Whether `path` is `base` or lies below it. */
export function isUnderPath(path: string, base: string): boolean {
  if (base === '/') return true;
  return path === base || path.startsWith(`${base}/`);
}

/**
 * The folder stack a path names, walking the folders the Files tab lists
 * from the root down; at each level a folder of the user's own drive wins
 * over a shared one of the same name. Null when a part of it is missing.
 */
export function resolveFolderPath(nodes: FileNode[], path: string): FolderStep[] | null {
  const names = path.split('/').filter(Boolean);
  const stack: FolderStep[] = [];
  let parentId: string | null = null;
  for (const name of names) {
    const matches: FileNode[] = listFolder(nodes, parentId).filter((n) => isFolder(n) && n.name === name);
    const next: FileNode | undefined = matches.find((n) => !n.isShared) ?? matches[0];
    if (!next) return null;
    stack.push({ id: next.id, name: next.name });
    parentId = next.id;
  }
  return stack;
}

/**
 * Where a node is listed: the folder stack down to the folder that holds it
 * (empty at the root), the way the root listing reaches it. A node of a
 * shared drive is reached through the shared root above it. Null when the
 * node is gone or no listing reaches it.
 */
export function nodePlace(nodes: FileNode[], id: string): { stack: FolderStep[]; node: FileNode } | null {
  const node = nodes.find((n) => n.id === id);
  if (!node || node.discoverableOnly) return null;
  const rootIds = new Set(listFolder(nodes, null).map((n) => n.id));
  if (rootIds.has(node.id)) return { stack: [], node };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const stack: FolderStep[] = [];
  let parentId = node.parentId ?? null;
  for (let guard = 0; parentId !== null && guard < 1000; guard++) {
    const parent = byId.get(parentId);
    if (!parent || parent.discoverableOnly || !isFolder(parent)) return null;
    stack.unshift({ id: parent.id, name: parent.name });
    if (rootIds.has(parent.id)) return { stack, node };
    parentId = parent.parentId ?? null;
  }
  return null;
}

export function toggleFavorite(favorites: string[], path: string): string[] {
  return favorites.includes(path) ? favorites.filter((f) => f !== path) : [...favorites, path];
}

/** Stars follow a folder that was renamed or moved, and those below it. */
export function moveFavorites(favorites: string[], oldPath: string, newPath: string): string[] {
  if (oldPath === '/' || oldPath === newPath) return favorites;
  const next = favorites.map((f) => (isUnderPath(f, oldPath) ? newPath + f.slice(oldPath.length) : f));
  return next.some((f, i) => f !== favorites[i]) ? next : favorites;
}

/** Stars of a deleted folder, and of those below it, go. */
export function dropFavoritesUnder(favorites: string[], path: string): string[] {
  if (path === '/') return favorites;
  const next = favorites.filter((f) => !isUnderPath(f, path));
  return next.length === favorites.length ? favorites : next;
}

/** The file goes to the top of the list, once, which keeps the newest 20. */
export function addRecentFile(recent: RecentFile[], name: string, id: string, now = Date.now()): RecentFile[] {
  return [{ id, name, timestamp: now }, ...recent.filter((r) => r.id !== id)].slice(0, RECENT_FILES_MAX);
}

export function removeRecentFiles(recent: RecentFile[], ids: Iterable<string>): RecentFile[] {
  const gone = new Set(ids);
  const next = recent.filter((r) => !gone.has(r.id));
  return next.length === recent.length ? recent : next;
}

/** Recent files whose node is gone or in the trash drop off after a listing. */
export function pruneRecentFiles(recent: RecentFile[], existingIds: Set<string>): RecentFile[] {
  const next = recent.filter((r) => existingIds.has(r.id));
  return next.length === recent.length ? recent : next;
}
