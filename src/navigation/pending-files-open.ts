import { create } from 'zustand';
import type { FileNode } from '../api/types';

/**
 * A file or folder to show in the Files tab, from a global search hit. The
 * hit is opened in its account first; the Files tab then consumes this once
 * its listing for that account is loaded (it may not be mounted yet, or show
 * another folder). Node ids repeat across accounts, so the target names its
 * account and is never applied to another one's listing.
 */
export interface FilesIdTarget {
  /** The signed-in account the node belongs to. */
  appAccountId: string;
  by?: 'id';
  /** The node's id in the Files listing (namespaced `${owner}:${id}` in a shared subtree). */
  nodeId: string;
  /** Folder path the node lives in (`/` for the root), for display and diagnostics. */
  folderPath: string;
  /** The file to preview; null when the target is a folder to open. */
  fileName: string | null;
}

/** A Files link: folder names from the root, and the file to preview in that folder. */
export interface FilesPathTarget {
  appAccountId: string;
  by: 'path';
  segments: string[];
  preview: string | null;
}

export type FilesOpenTarget = FilesIdTarget | FilesPathTarget;

interface PendingFilesOpenState {
  target: FilesOpenTarget | null;
  set: (target: FilesOpenTarget | null) => void;
  consume: () => FilesOpenTarget | null;
}

export const usePendingFilesOpen = create<PendingFilesOpenState>((set, get) => ({
  target: null,
  set: (target) => set({ target }),
  consume: () => {
    const target = get().target;
    if (target) set({ target: null });
    return target;
  },
}));

export function setPendingFilesOpen(target: FilesOpenTarget | null): void {
  usePendingFilesOpen.getState().set(target);
}

export interface ResolvedFilesOpen {
  /** The Files tab's folder stack, root first. */
  path: { id: string; name: string }[];
  /** The file to preview, or null to just show the folder. */
  file: FileNode | null;
}

/**
 * Where `target` is in `nodes` (one account's listing): the folder stack down
 * to it (the folder itself for a folder, its parent for a file) and the file
 * to preview. A shared subtree starts at its visible root, like the Files
 * tab's own root. Null when the listing no longer has the node.
 */
export function resolveFilesOpen(nodes: FileNode[], target: FilesIdTarget): ResolvedFilesOpen | null {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const found = byId.get(target.nodeId);
  if (!found) return null;
  // A folder has no blob (files.ts `isFolder`, not imported: this stays free of the client).
  const folder = found.blobId == null;
  const path: { id: string; name: string }[] = [];
  const seen = new Set<string>();
  let current: FileNode | undefined = folder ? found : (found.parentId != null ? byId.get(found.parentId) : undefined);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift({ id: current.id, name: current.name });
    current = current.parentId != null ? byId.get(current.parentId) : undefined;
  }
  return { path, file: folder ? null : found };
}

/**
 * Where a Files link points in `nodes` (one account's listing). Walks our own
 * nodes only, from the root, matching folder names; a file with a folder's
 * name is no folder. 'folder_missing' when a segment is not found; otherwise
 * the folder stack and the file named `preview` in the last folder (null when
 * there is none, so the folder still opens).
 */
export function resolveFilesPath(
  nodes: FileNode[],
  segments: string[],
  preview: string | null,
): ResolvedFilesOpen | 'folder_missing' {
  const own = nodes.filter((n) => !n.isShared);
  const childrenOf = (parentId: string | null) => own.filter((n) => (n.parentId ?? null) === parentId);
  const path: { id: string; name: string }[] = [];
  let parent: string | null = null;
  for (const name of segments) {
    const next: FileNode | undefined = childrenOf(parent).find((n) => n.blobId == null && n.name === name);
    if (!next) return 'folder_missing';
    path.push({ id: next.id, name: next.name });
    parent = next.id;
  }
  const file = preview ? (childrenOf(parent).find((n) => n.blobId != null && n.name === preview) ?? null) : null;
  return { path, file };
}
