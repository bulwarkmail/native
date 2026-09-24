import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { FileNode, FileNodeRights, JMAPAccountInfo, JMAPMethodCall, Principal } from './types';
import { getDownloadUrl, uploadBlob, type UploadBlobOptions } from './blob';
import { batched, requireMethodResult } from './jmap-result';
import { decodeFileNodeName } from '../lib/filenode-name';

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
// The modification timestamp is `modified` (RFC draft-ietf-jmap-filenode);
// asking for a property the server doesn't know silently yields undefined,
// which is how "updated" left every date blank (#700).
const FILE_NODE_PROPERTIES = [
  'id', 'parentId', 'name', 'type', 'blobId', 'size', 'created', 'modified',
  'shareWith', 'myRights',
];

// RFC 9670 sharing is only usable when the server advertises the exact
// `principals:owner` capability, either in the session or on the account
// (Stalwart places it in accountCapabilities).
export function supportsSharing(): boolean {
  return (
    jmapClient.hasCapability(CAPABILITIES.PRINCIPALS_OWNER) ||
    jmapClient.hasAccountCapability(CAPABILITIES.PRINCIPALS_OWNER, filesAccountId())
  );
}

export function filesAccountId(): string {
  return (
    jmapClient.currentSession?.primaryAccounts?.[CAPABILITIES.FILES] ??
    jmapClient.accountId
  );
}

// Gate on the ACCOUNT capability, not only the server-wide session
// capability. A server can advertise urn:ietf:params:jmap:filenode while a
// specific account has its jmap-file-node-* permissions revoked, in which case
// the capability is absent from that account's accountCapabilities and every
// FileNode action fails with an authorization error (#563). Non-personal
// (shared/group) accounts don't always advertise per-account, so treat those
// as capable. Mirrors the webmail's `supportsFiles`.
export function accountSupportsFiles(
  account: JMAPAccountInfo | undefined,
  sessionCapabilities: Record<string, unknown> | undefined,
): boolean {
  if (!sessionCapabilities || !(CAPABILITIES.FILES in sessionCapabilities)) return false;
  if (!account) return false;
  return account.accountCapabilities?.[CAPABILITIES.FILES] != null || !account.isPersonal;
}

export function supportsFiles(): boolean {
  const session = jmapClient.currentSession;
  if (!session) return false;
  return accountSupportsFiles(session.accounts?.[filesAccountId()], session.capabilities);
}

/** Server-advertised upload ceiling in bytes (0 = unknown / unlimited). */
export function getMaxSizeUpload(): number {
  return jmapClient.getMaxSizeUpload();
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

/** Ids asked for per FileNode/query page; Stalwart clamps it to queryMaxResults (5000 by default). */
const FILE_NODE_QUERY_PAGE = 5000;
/** Safety bound on how many FileNode ids one listing pages through. */
const FILE_NODE_MAX_IDS = 200_000;

// Every raw FileNode of one account, files AND folders, to build the
// hierarchy client-side from parentId links. Mirrors the webmail's
// fetchAllFileNodes.
//
// This starts from FileNode/get with ids:null (return-all), NOT
// FileNode/query: before Stalwart 0.16.6 the query returns leaf files only
// and omits folder nodes, which made every folder invisible. But ids:null
// stops at maxObjectsInGet (500 by default) and Stalwart gives no sign that
// the list was cut, so larger accounts silently lost files and folders
// (#1069). A full first page therefore counts as truncated: the remaining ids
// come from paging FileNode/query and are fetched in /get-sized batches, and
// parents that are still unknown afterwards (folders, on older Stalwart) are
// fetched by id.
async function fetchAllFileNodes(accountId: string): Promise<FileNode[]> {
  const using = fileUsing();
  const res = await jmapClient.request(
    [['FileNode/get', { accountId, ids: null, properties: FILE_NODE_PROPERTIES }, '0']],
    using,
  );
  const result = res.methodResponses[0];
  if (!result || result[0] === 'error') {
    throw new Error(result?.[1]?.description || 'FileNode list failed');
  }
  const firstPage = (result[1].list ?? []) as FileNode[];
  const maxObjects = jmapClient.getMaxObjectsInGet();
  if (firstPage.length < maxObjects) return firstPage;

  const known = new Map(firstPage.map((node) => [node.id, node]));
  // Several /get calls share one request, so a large account costs a few
  // round trips rather than one per batch.
  const fetchByIds = async (ids: string[]) => {
    const calls = batched(ids, maxObjects).map((batch, i): JMAPMethodCall =>
      ['FileNode/get', { accountId, ids: batch, properties: FILE_NODE_PROPERTIES }, String(i)]);
    for (const group of batched(calls, jmapClient.getMaxCallsInRequest())) {
      const batchRes = await jmapClient.request(group, using);
      for (const r of batchRes.methodResponses ?? []) {
        if (r[0] !== 'FileNode/get') {
          throw new Error(r[1]?.description || 'FileNode/get failed');
        }
        for (const node of (r[1].list ?? []) as FileNode[]) known.set(node.id, node);
      }
    }
  };

  try {
    const missing = new Set<string>();
    for (let position = 0; position < FILE_NODE_MAX_IDS;) {
      const queryRes = await jmapClient.request(
        [['FileNode/query', {
          accountId, filter: {}, position, limit: FILE_NODE_QUERY_PAGE, calculateTotal: true,
        }, '0']],
        using,
      );
      const queryResult = queryRes.methodResponses?.[0];
      if (!queryResult || queryResult[0] !== 'FileNode/query') {
        throw new Error(queryResult?.[1]?.description || 'FileNode/query failed');
      }
      // The server may clamp `limit`, so only an empty page or a reached
      // total ends the listing, never a page shorter than the one asked for.
      const pageIds = (queryResult[1].ids ?? []) as string[];
      if (pageIds.length === 0) break;
      for (const id of pageIds) {
        if (!known.has(id)) missing.add(id);
      }
      position += pageIds.length;
      const total = queryResult[1].total;
      if (typeof total === 'number' && position >= total) break;
    }
    await fetchByIds([...missing]);

    const asked = new Set<string>();
    for (;;) {
      const parents = new Set<string>();
      for (const node of known.values()) {
        if (node.parentId && !known.has(node.parentId) && !asked.has(node.parentId)) {
          parents.add(node.parentId);
        }
      }
      if (parents.size === 0) break;
      for (const id of parents) asked.add(id);
      await fetchByIds([...parents]);
    }
  } catch (err) {
    // A partial tree beats none: keep what was read, as before #1069.
    console.warn(`[files] listing for account ${accountId} is incomplete past ${maxObjects} nodes`, err);
  }

  return [...known.values()];
}

// Fetch every FileNode in the files account (see fetchAllFileNodes).
export async function getAllFileNodes(): Promise<FileNode[]> {
  const nodes = await fetchAllFileNodes(filesAccountId());
  return nodes.map((node) => ({ ...node, name: decodeFileNodeName(node.name) }));
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
      const nodes = await fetchAllFileNodes(accountId);
      for (const node of nodes) {
        all.push({
          ...node,
          name: decodeFileNodeName(node.name),
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
  const result = requireMethodResult(res, '0', 'FileNode/set');
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
  // A method-level error (e.g. forbidden) has no notUpdated entry, so without
  // this check a refused rename or move reported success.
  const notUpdated = requireMethodResult(res, '0', 'FileNode/set').notUpdated?.[id];
  if (notUpdated) throw new Error(notUpdated.description || 'Update failed');
}

export async function renameFileNode(id: string, newName: string): Promise<void> {
  await updateFileNode(id, { name: newName });
}

// Re-parent a node. `null` moves it to the drive root (the property must be
// sent explicitly as null, omitting it would leave the node where it is).
export async function moveFileNode(id: string, parentId: string | null): Promise<void> {
  await updateFileNode(id, { parentId });
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
  const notDestroyed = requireMethodResult(res, '0', 'FileNode/set').notDestroyed as
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

// Stalwart caps the stored MIME type; very long types fail the create.
function safeMimeType(type: string | undefined, fallback: string): string {
  const t = type || fallback || 'application/octet-stream';
  return t.length > 30 ? 'application/octet-stream' : t;
}

async function createFileNodeFromBlob(
  name: string,
  blobId: string,
  type: string,
  size: number | undefined,
  parentId: string | null,
): Promise<FileNode> {
  const accountId = filesAccountId();
  const props: Record<string, unknown> = { name, type, blobId };
  if (size != null) props.size = size;
  if (parentId !== null) props.parentId = parentId;

  const res = await jmapClient.request(
    [['FileNode/set', { accountId, create: { 'new-file': props } }, '0']],
    fileUsing(),
  );
  const result = requireMethodResult(res, '0', 'FileNode/set');
  const created = result.created?.['new-file'];
  if (!created) {
    const err = result.notCreated?.['new-file'];
    throw new Error(err?.description || 'Upload failed');
  }
  return { ...props, ...created } as FileNode;
}

export async function uploadFileNode(
  uri: string,
  name: string,
  mimeType: string,
  parentId: string | null,
  options: UploadBlobOptions = {},
): Promise<FileNode> {
  const blob = await uploadBlob(uri, mimeType, options);
  return createFileNodeFromBlob(
    name,
    blob.blobId,
    safeMimeType(blob.type, mimeType),
    blob.size,
    parentId,
  );
}

// Copy a file by creating a new node that references the same blob — no
// bytes are re-uploaded (webmail `copyFileNode`). Folders have no blob and
// cannot be duplicated this way.
export async function copyFileNode(
  node: FileNode,
  parentId: string | null,
  newName: string = node.name,
): Promise<FileNode> {
  if (!node.blobId) throw new Error('Folders cannot be duplicated');
  return createFileNodeFromBlob(
    newName,
    node.blobId,
    safeMimeType(node.type, 'application/octet-stream'),
    node.size,
    parentId,
  );
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
  const result = requireMethodResult(res, '0', 'FileNode/set');
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
