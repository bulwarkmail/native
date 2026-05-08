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

// Stalwart's FileNode/get does not support a parentId filter — fetching with
// `ids: null` returns the whole tree, which the caller filters client-side.
// Mirrors the webmail file-store; keeping the API uniform avoids a divergence
// later when we add other JMAP servers.
//
// Properties are listed explicitly: some Stalwart builds omit `type` from the
// default property set, which makes `isDirectory()` impossible to compute.
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
  name: string,
  parentId: string | null,
): Promise<FileNode> {
  // Stalwart's FileNode/set rejects directory creates without a blobId
  // ("Missing blob id"), so we upload an empty blob first and reference it.
  // Mirrors the webmail's createFileDirectory.
  const blob = await uploadBytes(new Uint8Array(0), 'application/x-directory');
  const props: Partial<FileNode> = { name, type: 'd', blobId: blob.blobId, size: 0 };
  if (parentId !== null) props.parentId = parentId;
  return createFileNode(props);
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
