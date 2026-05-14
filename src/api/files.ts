import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { FileNode } from './types';
import { getDownloadUrl, uploadBlob, uploadBytes } from './blob';

const USING = [CAPABILITIES.CORE, CAPABILITIES.FILES];

// Stalwart and other JMAP servers use one of these strings on FileNode.type to
// mark a directory; everything else is a MIME type.
const DIRECTORY_TYPES = new Set([
  'd',
  'application/x-directory',
  'text/directory',
  'httpd/unix-directory',
  'inode/directory',
]);

export function isDirectory(node: Pick<FileNode, 'type'>): boolean {
  const t = node.type;
  if (!t) return false;
  return DIRECTORY_TYPES.has(t) || t.includes('directory');
}

// Stalwart rejects `/` in FileNode names, so the webmail (and now this app)
// uses U+2215 DIVISION SLASH as the path separator inside the flat `name`
// field. Hierarchy is encoded into the name — there is no `parentId` nesting.
// e.g. a file inside the `Documents` folder is stored with
// `name = "Documents∕report.pdf"`. The display name shown to the user
// strips the prefix.
export const PATH_SEP = '∕';

// Path is a list of folder display names from root. [] is root,
// ['Documents'] is inside Documents, ['Documents','sub'] is inside the
// `sub` folder under Documents.
export function pathToPrefix(path: readonly string[]): string {
  if (path.length === 0) return '';
  return path.join(PATH_SEP) + PATH_SEP;
}

// True when `node` is a direct child (not a descendant) of `prefix`.
export function isDirectChildOfPrefix(node: Pick<FileNode, 'name'>, prefix: string): boolean {
  if (!node.name) return false;
  if (prefix === '') return !node.name.includes(PATH_SEP);
  if (!node.name.startsWith(prefix)) return false;
  const rest = node.name.slice(prefix.length);
  return rest.length > 0 && !rest.includes(PATH_SEP);
}

export function nodeDisplayName(node: Pick<FileNode, 'name'>, prefix: string): string {
  return prefix && node.name.startsWith(prefix) ? node.name.slice(prefix.length) : node.name;
}

// Stalwart's FileNode/get does not support a parentId filter and some builds
// omit `type` from the default property set. We fetch the whole tree and
// filter client-side; properties are listed explicitly so `isDirectory()`
// always has a value to look at.
const FILE_NODE_PROPERTIES = ['id', 'parentId', 'name', 'type', 'blobId', 'size', 'created', 'updated'];

export async function getAllFileNodes(): Promise<FileNode[]> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['FileNode/get', { accountId, ids: null, properties: FILE_NODE_PROPERTIES }, '0']],
    USING,
  );
  return (res.methodResponses[0][1].list ?? []) as FileNode[];
}

export async function createFileNode(
  fileNode: Partial<FileNode>,
): Promise<FileNode> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['FileNode/set', {
      accountId,
      create: { 'new-file': fileNode },
    }, '0']],
    USING,
  );
  const created = res.methodResponses[0][1].created?.['new-file'];
  if (!created) {
    const err = res.methodResponses[0][1].notCreated?.['new-file'];
    throw new Error(err?.description || 'Create failed');
  }
  return created;
}

export async function createFolder(
  displayName: string,
  currentPath: readonly string[],
): Promise<FileNode> {
  // Stalwart's FileNode/set rejects directory creates without a blobId
  // ("Missing blob id"), so we upload an empty blob first and reference it.
  // Mirrors the webmail's createFileDirectory.
  const blob = await uploadBytes(new Uint8Array(0), 'application/x-directory');
  const fullName = pathToPrefix(currentPath) + displayName;
  return createFileNode({ name: fullName, type: 'd', blobId: blob.blobId, size: 0 });
}

export async function updateFileNode(
  id: string,
  updates: Partial<Pick<FileNode, 'name' | 'parentId'>>,
): Promise<void> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['FileNode/set', { accountId, update: { [id]: updates } }, '0']],
    USING,
  );
  const notUpdated = res.methodResponses[0][1].notUpdated?.[id];
  if (notUpdated) throw new Error(notUpdated.description || 'Update failed');
}

// Rename a node and, if it's a folder, cascade the rename to every descendant
// so the encoded path stays consistent. The webmail does this same dance.
export async function renameFileNode(
  node: FileNode,
  newDisplayName: string,
  currentPath: readonly string[],
  allNodes: readonly FileNode[],
): Promise<void> {
  const prefix = pathToPrefix(currentPath);
  const oldServerName = node.name;
  const newServerName = prefix + newDisplayName;
  if (oldServerName === newServerName) return;

  await updateFileNode(node.id, { name: newServerName });

  if (isDirectory(node)) {
    const oldFolderPrefix = oldServerName + PATH_SEP;
    const newFolderPrefix = newServerName + PATH_SEP;
    for (const n of allNodes) {
      if (n.id === node.id) continue;
      if (n.name.startsWith(oldFolderPrefix)) {
        await updateFileNode(n.id, { name: newFolderPrefix + n.name.slice(oldFolderPrefix.length) });
      }
    }
  }
}

export async function deleteFileNodes(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const accountId = jmapClient.accountId;
  await jmapClient.request(
    [['FileNode/set', { accountId, destroy: ids }, '0']],
    USING,
  );
}

// Delete `targets` and every descendant. Stalwart doesn't enforce parent
// references, so we collect descendants by name-prefix and destroy them all
// in one call. Without this, deleting a folder leaves its files orphaned and
// still discoverable at the old encoded path.
export async function deleteWithDescendants(
  targets: readonly FileNode[],
  allNodes: readonly FileNode[],
): Promise<void> {
  const ids = new Set<string>();
  for (const node of targets) {
    ids.add(node.id);
    if (isDirectory(node)) {
      const folderPrefix = node.name + PATH_SEP;
      for (const n of allNodes) {
        if (n.name.startsWith(folderPrefix)) ids.add(n.id);
      }
    }
  }
  await deleteFileNodes(Array.from(ids));
}

export function getFileNodeDownloadUrl(node: FileNode): string {
  if (!node.blobId) throw new Error('Folders cannot be downloaded');
  return getDownloadUrl(node.blobId, node.name, node.type);
}

export async function uploadFileNode(
  uri: string,
  displayName: string,
  mimeType: string,
  currentPath: readonly string[],
): Promise<FileNode> {
  const blob = await uploadBlob(uri, mimeType);
  const fullName = pathToPrefix(currentPath) + displayName;
  return createFileNode({
    name: fullName,
    type: blob.type || mimeType || 'application/octet-stream',
    blobId: blob.blobId,
    size: blob.size,
  });
}
