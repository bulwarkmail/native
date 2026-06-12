import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { FileNode, FileNodeRights, Principal } from './types';
import { getDownloadUrl, uploadBlob } from './blob';

// A FileNode is a folder (container) only when it has no blob content — the
// server stores it with `file == null`. Sending a blobId/type/size on create
// (as older builds did: type 'd' + an empty blob) makes a 0-byte FILE that
// nothing can ever be parented under (#379). The webmail migrates those
// legacy flat-named nodes into the real parentId hierarchy on load; this app
// reads and writes only the real hierarchy.
export function isFolder(node: Pick<FileNode, 'blobId'>): boolean {
  return node.blobId == null;
}

// Stalwart omits shareWith/myRights from FileNode/get unless they are
// requested explicitly, so the share sheet and indicators must name them here.
const FILE_NODE_PROPERTIES = [
  'id', 'parentId', 'name', 'type', 'blobId', 'size', 'created', 'updated',
  'shareWith', 'myRights',
];

export function supportsSharing(): boolean {
  return jmapClient.hasCapability(CAPABILITIES.PRINCIPALS);
}

function filesAccountId(): string {
  return (
    jmapClient.currentSession?.primaryAccounts?.[CAPABILITIES.FILES] ??
    jmapClient.accountId
  );
}

function fileUsing(): string[] {
  const using: string[] = [CAPABILITIES.CORE];
  if (jmapClient.hasCapability(CAPABILITIES.FILES)) {
    using.push(CAPABILITIES.FILES);
  }
  // Required for shareWith/myRights on FileNode and for cross-account
  // (shared-with-me) FileNode/get.
  if (supportsSharing()) {
    using.push(CAPABILITIES.PRINCIPALS_OWNER);
  }
  return using;
}

// Nodes fetched from another principal's account are namespaced
// "accountId:nodeId" so they can't collide with the primary account's ids.
// JMAP ids never contain ':', so the separator unambiguously marks a shared
// (cross-account) node.
export function isCrossAccountId(id: string | null | undefined): boolean {
  return id != null && id.includes(':');
}

// Fetch every FileNode in the account, files AND folders, to build the
// hierarchy client-side from parentId links.
//
// IMPORTANT: this uses FileNode/get with ids:null (return-all), NOT
// FileNode/query — Stalwart's query only returns leaf files and omits folder
// nodes entirely, which would make every folder invisible.
export async function getAllFileNodes(): Promise<FileNode[]> {
  const accountId = filesAccountId();
  const res = await jmapClient.request(
    [['FileNode/get', { accountId, ids: null, properties: FILE_NODE_PROPERTIES }, '0']],
    fileUsing(),
  );
  const result = res.methodResponses[0];
  if (!result || result[0] === 'error') {
    throw new Error(result?.[1]?.description || 'FileNode list failed');
  }
  return (result[1].list ?? []) as FileNode[];
}

// Accounts (primary + shared/group) that can hold FileNodes: any non-primary
// account that advertises the filenode capability or is non-personal, since
// Stalwart doesn't always advertise capabilities on shared accounts.
function filesCapableAccountIds(): string[] {
  const primaryId = filesAccountId();
  const accounts = jmapClient.currentSession?.accounts ?? {};
  const rest = Object.entries(accounts)
    .filter(([id, info]) =>
      id !== primaryId &&
      (info.accountCapabilities?.[CAPABILITIES.FILES] != null || !info.isPersonal))
    .map(([id]) => id);
  return [primaryId, ...rest];
}

// Fetch every FileNode the logged-in user can see across all accessible
// accounts. Nodes owned by another principal (shared with the user) are
// tagged `isShared: true` with the owning accountId/accountName, and their
// ids/parentIds are namespaced "accountId:nodeId". Mirrors the webmail's
// listAllFileNodesAcrossAccounts.
export async function getAllFileNodesAcrossAccounts(): Promise<FileNode[]> {
  const primaryId = filesAccountId();
  const accounts = jmapClient.currentSession?.accounts ?? {};
  const all: FileNode[] = [];

  for (const accountId of filesCapableAccountIds()) {
    const isPrimary = accountId === primaryId;
    try {
      const res = await jmapClient.request(
        [['FileNode/get', { accountId, ids: null, properties: FILE_NODE_PROPERTIES }, '0']],
        fileUsing(),
      );
      const result = res.methodResponses[0];
      if (!result || result[0] === 'error') continue;
      for (const node of (result[1].list ?? []) as FileNode[]) {
        all.push({
          ...node,
          id: isPrimary ? node.id : `${accountId}:${node.id}`,
          parentId: node.parentId == null
            ? null
            : (isPrimary ? node.parentId : `${accountId}:${node.parentId}`),
          accountId,
          accountName: accounts[accountId]?.name || accountId,
          isShared: !isPrimary,
        });
      }
    } catch {
      // A single unreachable shared account shouldn't hide the user's own
      // files; skip it and keep aggregating.
    }
  }

  return all;
}

export async function createFolder(
  name: string,
  parentId: string | null,
): Promise<FileNode> {
  const accountId = filesAccountId();
  const props: Record<string, unknown> = { name };
  if (parentId !== null) props.parentId = parentId;

  const res = await jmapClient.request(
    [['FileNode/set', { accountId, create: { 'new-dir': props } }, '0']],
    fileUsing(),
  );
  const result = res.methodResponses[0][1];
  const created = result.created?.['new-dir'];
  if (!created) {
    const err = result.notCreated?.['new-dir'];
    throw new Error(err?.description || 'Create folder failed');
  }
  return { ...props, ...created } as FileNode;
}

export async function updateFileNode(
  id: string,
  updates: Partial<Pick<FileNode, 'name' | 'parentId'>>,
): Promise<void> {
  const accountId = filesAccountId();
  const res = await jmapClient.request(
    [['FileNode/set', { accountId, update: { [id]: updates } }, '0']],
    fileUsing(),
  );
  const notUpdated = res.methodResponses[0][1].notUpdated?.[id];
  if (notUpdated) throw new Error(notUpdated.description || 'Update failed');
}

export async function renameFileNode(id: string, newName: string): Promise<void> {
  await updateFileNode(id, { name: newName });
}

export async function deleteFileNodes(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const accountId = filesAccountId();
  const res = await jmapClient.request(
    [['FileNode/set', {
      accountId,
      destroy: ids,
      // The server removes descendant nodes of destroyed folders.
      onDestroyRemoveChildren: true,
    }, '0']],
    fileUsing(),
  );
  const notDestroyed = res.methodResponses[0][1].notDestroyed as
    | Record<string, { description?: string }>
    | undefined;
  const failedIds = Object.keys(notDestroyed ?? {});
  if (failedIds.length > 0) {
    throw new Error(
      notDestroyed![failedIds[0]]?.description || `Failed to delete ${failedIds.length} item(s)`,
    );
  }
}

export function getFileNodeDownloadUrl(node: FileNode): string {
  if (!node.blobId) throw new Error('Folders cannot be downloaded');
  return getDownloadUrl(node.blobId, node.name, node.type, node.accountId);
}

export async function uploadFileNode(
  uri: string,
  name: string,
  mimeType: string,
  parentId: string | null,
): Promise<FileNode> {
  const accountId = filesAccountId();
  const blob = await uploadBlob(uri, mimeType);
  const type = blob.type || mimeType || 'application/octet-stream';
  const props: Record<string, unknown> = {
    name,
    // Stalwart caps the stored MIME type; very long types fail the create.
    type: type.length > 30 ? 'application/octet-stream' : type,
    blobId: blob.blobId,
    size: blob.size,
  };
  if (parentId !== null) props.parentId = parentId;

  const res = await jmapClient.request(
    [['FileNode/set', { accountId, create: { 'new-file': props } }, '0']],
    fileUsing(),
  );
  const result = res.methodResponses[0][1];
  const created = result.created?.['new-file'];
  if (!created) {
    const err = result.notCreated?.['new-file'];
    throw new Error(err?.description || 'Upload failed');
  }
  return { ...props, ...created } as FileNode;
}

// ── Sharing (RFC 9670) ────────────────────────────────────

// Add, update, or remove a principal's rights on an owned FileNode (file or
// folder). Pass rights: null to revoke. Stalwart applies it via a
// `shareWith/{principalId}` patch on FileNode/set. Sharing a folder shares
// its whole subtree — which is why this app must store real parentId
// hierarchy rather than the legacy flat-name encoding.
export async function setFileNodeShare(
  fileNodeId: string,
  principalId: string,
  rights: FileNodeRights | null,
): Promise<void> {
  const accountId = filesAccountId();
  const res = await jmapClient.request(
    [['FileNode/set', {
      accountId,
      update: { [fileNodeId]: { [`shareWith/${principalId}`]: rights } },
    }, '0']],
    fileUsing(),
  );
  const result = res.methodResponses[0][1];
  if (result.notUpdated?.[fileNodeId]) {
    throw new Error(result.notUpdated[fileNodeId].description || 'Failed to update file share');
  }
  if (!result.updated || !(fileNodeId in result.updated)) {
    throw new Error('Server did not confirm the share update');
  }
}

// List all principals visible to the user. Stalwart returns the full
// directory regardless of `filter`, so callers filter client-side.
export async function getPrincipals(): Promise<Principal[]> {
  if (!supportsSharing()) return [];
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [
      ['Principal/query', { accountId }, '0'],
      ['Principal/get', {
        accountId,
        '#ids': { resultOf: '0', name: 'Principal/query', path: '/ids' },
      }, '1'],
    ],
    [CAPABILITIES.CORE, CAPABILITIES.PRINCIPALS],
  );
  const getResp = res.methodResponses.find((r) => r[0] === 'Principal/get');
  return (getResp?.[1].list ?? []) as Principal[];
}

// The principal id that represents the logged-in user (excluded from the
// share picker — sharing with yourself is a no-op the server may reject).
export function ownPrincipalId(): string {
  return filesAccountId();
}
