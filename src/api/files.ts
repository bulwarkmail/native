import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { FileNode } from './types';
import { getDownloadUrl, uploadBlob } from './blob';

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
  return DIRECTORY_TYPES.has(node.type) || node.type.includes('directory');
}

// Stalwart's FileNode/get does not support a parentId filter — fetching with
// `ids: null` returns the whole tree, which the caller filters client-side.
// Mirrors the webmail file-store; keeping the API uniform avoids a divergence
// later when we add other JMAP servers.
export async function getAllFileNodes(): Promise<FileNode[]> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['FileNode/get', { accountId, ids: null }, '0']],
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
  name: string,
  parentId: string | null,
): Promise<FileNode> {
  return createFileNode({ name, parentId, type: 'd', blobId: null, size: 0 });
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

export async function deleteFileNodes(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const accountId = jmapClient.accountId;
  await jmapClient.request(
    [['FileNode/set', { accountId, destroy: ids }, '0']],
    USING,
  );
}

export function getFileNodeDownloadUrl(node: FileNode): string {
  if (!node.blobId) throw new Error('Folders cannot be downloaded');
  return getDownloadUrl(node.blobId, node.name, node.type);
}

export async function uploadFileNode(
  uri: string,
  name: string,
  mimeType: string,
  parentId: string | null,
): Promise<FileNode> {
  const blob = await uploadBlob(uri, mimeType);
  return createFileNode({
    name,
    parentId,
    type: blob.type || mimeType || 'application/octet-stream',
    blobId: blob.blobId,
    size: blob.size,
  });
}
