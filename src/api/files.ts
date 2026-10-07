import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { FileNode, FileNodeRights, JMAPAccountInfo, JMAPMethodCall } from './types';
import { getDownloadUrl, uploadBlob, type UploadBlobOptions } from './blob';
import { batched, requireMethodResult } from './jmap-result';
import { decodeFileNodeName, numberedFileName } from '../lib/filenode-name';
import { fileNameRulesFrom, type FileNameRules } from '../lib/file-name-rules';
import { isStaleLoad } from '../lib/network-error';
import { opScope, type AccountRef } from './op-scope';

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

type LegacyFileNodeRights = { mayRead?: boolean; mayWrite?: boolean; mayShare?: boolean };

// Stalwart before 0.16.6 implements an older File Storage draft whose rights
// are only mayRead / mayWrite / mayShare, and its capability lacks
// `forbiddenNameChars`. Detected by that shape, like the webmail.
export function isLegacyFileNodeServer(accountId: string): boolean {
  const cap = jmapClient.getAccountCapability(CAPABILITIES.FILES, accountId);
  return !!cap && !('forbiddenNameChars' in (cap as Record<string, unknown>));
}

// The server's published naming rules, or null when it publishes none.
export function getFileNameRules(accountId?: string): FileNameRules | null {
  return fileNameRulesFrom(jmapClient.getAccountCapability(CAPABILITIES.FILES, accountId ?? filesAccountId()));
}

export function toLegacyRights(rights: FileNodeRights): LegacyFileNodeRights {
  return {
    mayRead: rights.mayRead,
    mayWrite: rights.mayAddChildren || rights.mayRename || rights.mayDelete || rights.mayModifyContent,
    mayShare: rights.mayShare,
  };
}

// Spread the old mayWrite over the finer rights the UI checks.
export function fromLegacyRights(
  rights: FileNodeRights | LegacyFileNodeRights | undefined,
): FileNodeRights | undefined {
  if (!rights || !('mayWrite' in rights)) return rights as FileNodeRights | undefined;
  const write = !!rights.mayWrite;
  return {
    mayRead: !!rights.mayRead,
    mayAddChildren: write,
    mayRename: write,
    mayDelete: write,
    mayModifyContent: write,
    mayShare: !!rights.mayShare,
  };
}

// A FileNode as the server sent it: name decoded, rights in the finer form.
function fromWireFileNode(node: FileNode): FileNode {
  const name = decodeFileNodeName(node.name);
  if (!node.myRights && !node.shareWith) return name === node.name ? node : { ...node, name };
  return {
    ...node,
    name,
    myRights: fromLegacyRights(node.myRights),
    shareWith: node.shareWith
      ? Object.fromEntries(
        Object.entries(node.shareWith).map(([p, r]) => [p, fromLegacyRights(r) as FileNodeRights]),
      )
      : node.shareWith,
  };
}

// Sharing with other users (RFC 9670) needs the principal directory to pick
// people from, so it is offered whenever the server advertises
// `urn:ietf:params:jmap:principals`, like the webmail's supportsPrincipals().
// It used to require `principals:owner`, which Stalwart advertises nowhere,
// so "Sharing & access" and the calendar share picker never had anyone to
// offer.
export function supportsSharing(): boolean {
  return jmapClient.hasCapability(CAPABILITIES.PRINCIPALS);
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
  // Only name principals:owner where the server advertises it: an unknown
  // capability in `using` fails the whole request. Stalwart returns
  // shareWith/myRights without it.
  if (
    jmapClient.hasCapability(CAPABILITIES.PRINCIPALS_OWNER) ||
    jmapClient.hasAccountCapability(CAPABILITIES.PRINCIPALS_OWNER, filesAccountId())
  ) {
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
async function fetchAllFileNodes(accountId: string, gen?: number): Promise<FileNode[]> {
  const using = fileUsing();
  const opts = gen === undefined ? undefined : { gen };
  const res = await jmapClient.request(
    [['FileNode/get', { accountId, ids: null, properties: FILE_NODE_PROPERTIES }, '0']],
    using,
    opts,
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
      const batchRes = await jmapClient.request(group, using, opts);
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
        opts,
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
    // A replaced connection is not a partial tree: nothing it read is kept.
    if (isStaleLoad(err)) throw err;
    // A partial tree beats none: keep what was read, as before #1069.
    console.warn(`[files] listing for account ${accountId} is incomplete past ${maxObjects} nodes`, err);
  }

  return [...known.values()];
}

// Fetch every FileNode in the files account (see fetchAllFileNodes).
export async function getAllFileNodes(): Promise<FileNode[]> {
  const nodes = await fetchAllFileNodes(filesAccountId());
  return nodes.map(fromWireFileNode);
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
// listAllFileNodesAcrossAccounts. `gen` binds every request to the caller's
// connection (see `OpScope`); `strict` throws when the user's own account
// fails instead of listing only the shared ones.
async function listAcrossAccounts(gen: number | undefined, strict: boolean): Promise<FileNode[]> {
  const primaryId = filesAccountId();
  const accounts = jmapClient.currentSession?.accounts ?? {};
  const all: FileNode[] = [];

  for (const accountId of filesCapableAccountIds()) {
    const isPrimary = accountId === primaryId;
    try {
      const nodes = await fetchAllFileNodes(accountId, gen);
      for (const wire of nodes) {
        const node = fromWireFileNode(wire);
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
    } catch (err) {
      if (isStaleLoad(err) || (strict && isPrimary)) throw err;
      // A single unreachable shared account shouldn't hide the user's own
      // files; skip it and keep aggregating.
    }
  }

  return all;
}

export async function getAllFileNodesAcrossAccounts(at?: AccountRef): Promise<FileNode[]> {
  return listAcrossAccounts(at === undefined ? undefined : opScope(at).gen, false);
}

// ── Listing cache for global search ───────────────────────

/** How long global search reuses an account's listing (webmail FILE_LISTING_TTL_MS). */
export const FILE_LISTING_TTL_MS = 60_000;

interface CachedListing {
  gen: number;
  fetchedAt: number;
  promise: Promise<FileNode[]>;
  nodes: FileNode[] | null;
}

// Per app account (account-store id): FileNode ids repeat across accounts,
// so a listing is only ever served to the account it was read for, and only
// on the connection it was read on.
const listings = new Map<string, CachedListing>();

/** Forget the cached listing of `appAccountId`, or of every account. */
export function invalidateFileListing(appAccountId?: string): void {
  if (appAccountId) listings.delete(appAccountId);
  else listings.clear();
}

/**
 * Every node app account `appAccountId` can see (getAllFileNodesAcrossAccounts),
 * read on `at`'s connection and reused for FILE_LISTING_TTL_MS. File search
 * has no usable server query (FileNode/query matches `name` exactly), so
 * global search filters this listing. A failed read is not cached.
 */
export function getFileListing(appAccountId: string, at: AccountRef): Promise<FileNode[]> {
  const { gen } = opScope(at);
  const cached = listings.get(appAccountId);
  const now = Date.now();
  if (cached && cached.gen === gen && now - cached.fetchedAt < FILE_LISTING_TTL_MS) return cached.promise;
  const entry: CachedListing = {
    gen,
    fetchedAt: now,
    nodes: null,
    promise: listAcrossAccounts(gen, true).then((nodes) => {
      entry.nodes = nodes;
      return nodes;
    }, (error) => {
      if (listings.get(appAccountId) === entry) listings.delete(appAccountId);
      throw error;
    }),
  };
  listings.set(appAccountId, entry);
  return entry.promise;
}

/** The cached listing of `appAccountId` when it is in memory, fresh and from the live connection. */
export function peekFileListing(appAccountId: string): FileNode[] | null {
  const cached = listings.get(appAccountId);
  if (!cached || cached.gen !== jmapClient.connectionGen) return null;
  if (Date.now() - cached.fetchedAt >= FILE_LISTING_TTL_MS) return null;
  return cached.nodes;
}

/**
 * `write`, after which the search listing is dropped whatever its outcome: a
 * refused or failed write may still have changed some nodes.
 */
function afterWrite<T>(write: Promise<T>): Promise<T> {
  return write.finally(() => invalidateFileListing());
}

// FileNode/set `create` of one node. `onExists: "rename"` (Stalwart 0.16.6+)
// turns a name clash into "name (2)"; older servers ignore it and refuse the
// clash, so retry with numbered names ourselves.
async function createFileNode(
  accountId: string,
  props: Record<string, unknown>,
): Promise<FileNode> {
  return afterWrite(createFileNodeOnce(accountId, props));
}

async function createFileNodeOnce(
  accountId: string,
  props: Record<string, unknown>,
): Promise<FileNode> {
  const baseName = String(props.name ?? '');
  const key = props.blobId ? 'new-file' : 'new-dir';
  for (let attempt = 1; ; attempt++) {
    const name = attempt === 1 ? baseName : numberedFileName(baseName, attempt);
    const res = await jmapClient.request(
      [['FileNode/set', { accountId, onExists: 'rename', create: { [key]: { ...props, name } } }, '0']],
      fileUsing(),
    );
    const result = requireMethodResult(res, '0', 'FileNode/set');
    const created = result.created?.[key];
    // The server's name wins: after a rename it differs from the one sent.
    if (created) return fromWireFileNode({ ...props, name, ...created } as FileNode);
    const err = result.notCreated?.[key];
    if (attempt < 20 && /already exists/i.test(err?.description ?? '')) continue;
    throw new Error(err?.description || 'Create failed');
  }
}

export async function createFolder(
  name: string,
  parentId: string | null,
): Promise<FileNode> {
  const props: Record<string, unknown> = { name };
  if (parentId !== null) props.parentId = parentId;
  return createFileNode(filesAccountId(), props);
}

export async function updateFileNode(
  id: string,
  updates: Partial<Pick<FileNode, 'name' | 'parentId'>>,
): Promise<void> {
  const accountId = filesAccountId();
  const res = await afterWrite(jmapClient.request(
    [['FileNode/set', { accountId, update: { [id]: updates } }, '0']],
    fileUsing(),
  ));
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
  // One FileNode/set per `maxObjectsInSet` ids: a request over the limit
  // fails whole (RFC 8620 §3.6.1), so a large selection deleted nothing.
  // Every batch runs; refusals are reported once all of them are done.
  const refused: Array<{ description?: string }> = [];
  for (const slice of batched(ids, jmapClient.getMaxObjectsInSet())) {
    const res = await afterWrite(jmapClient.request(
      [['FileNode/set', {
        accountId,
        destroy: slice,
        // The server removes descendant nodes of destroyed folders.
        onDestroyRemoveChildren: true,
      }, '0']],
      fileUsing(),
    ));
    const notDestroyed = requireMethodResult(res, '0', 'FileNode/set').notDestroyed as
      | Record<string, { type?: string; description?: string }>
      | undefined;
    // A node inside a folder an earlier batch removed is already gone.
    refused.push(...Object.values(notDestroyed ?? {}).filter((err) => err?.type !== 'notFound'));
  }
  if (refused.length > 0) {
    throw new Error(refused[0]?.description || `Failed to delete ${refused.length} item(s)`);
  }
}

export function getFileNodeDownloadUrl(node: FileNode): string {
  if (!node.blobId) throw new Error('Folders cannot be downloaded');
  return getDownloadUrl(node.blobId, node.name, node.type, node.accountId);
}

// Servers before 0.16.6 refuse MIME types over 30 characters (most OOXML
// types); later ones take up to 255.
function safeMimeType(type: string | undefined, fallback: string, accountId: string): string {
  const t = type || fallback || 'application/octet-stream';
  const max = isLegacyFileNodeServer(accountId) ? 30 : 255;
  return t.length > max ? 'application/octet-stream' : t;
}

async function createFileNodeFromBlob(
  name: string,
  blobId: string,
  type: string,
  size: number | undefined,
  parentId: string | null,
): Promise<FileNode> {
  const props: Record<string, unknown> = { name, type, blobId };
  if (size != null) props.size = size;
  if (parentId !== null) props.parentId = parentId;
  return createFileNode(filesAccountId(), props);
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
    safeMimeType(blob.type, mimeType, filesAccountId()),
    blob.size,
    parentId,
  );
}

// Copy a node. A file creates a new node that references the same blob, so no
// bytes are re-uploaded; a folder is created, then each child is copied into
// it (webmail `copyFileNode`). Children come from `tree`, or from one fetch
// of the whole tree taken before any create, so a folder copied into itself
// or a descendant never re-visits the nodes it just made.
export async function copyFileNode(
  node: FileNode,
  parentId: string | null,
  newName: string = node.name,
  tree?: FileNode[],
): Promise<FileNode> {
  const accountId = filesAccountId();
  if (node.blobId) {
    return createFileNodeFromBlob(
      newName,
      node.blobId,
      safeMimeType(node.type, 'application/octet-stream', accountId),
      node.size,
      parentId,
    );
  }
  const snapshot = tree ?? await getAllFileNodes();
  const copyInto = async (src: FileNode, name: string, parent: string | null): Promise<FileNode> => {
    if (src.blobId) return copyFileNode(src, parent, name, snapshot);
    // Read the children before creating anything under the new folder.
    const children = snapshot.filter((n) => n.parentId === src.id);
    const props: Record<string, unknown> = { name };
    if (parent !== null) props.parentId = parent;
    const created = await createFileNode(accountId, props);
    for (const child of children) await copyInto(child, child.name, created.id);
    return created;
  };
  return copyInto(node, newName, parentId);
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
  const wireRights = rights && isLegacyFileNodeServer(accountId) ? toLegacyRights(rights) : rights;
  const res = await afterWrite(jmapClient.request(
    [['FileNode/set', {
      accountId,
      update: { [fileNodeId]: { [`shareWith/${principalId}`]: wireRights } },
    }, '0']],
    fileUsing(),
  ));
  const result = requireMethodResult(res, '0', 'FileNode/set');
  if (result.notUpdated?.[fileNodeId]) {
    throw new Error(result.notUpdated[fileNodeId].description || 'Failed to update file share');
  }
  if (!result.updated || !(fileNodeId in result.updated)) {
    throw new Error('Server did not confirm the share update');
  }
}

// The principal directory loader lives in ./principals (the composer's
// recipient suggestions use it too); re-exported for the share pickers.
export { getPrincipals } from './principals';

// The principal id that represents the logged-in user (excluded from the
// share picker — sharing with yourself is a no-op the server may reject).
export function ownPrincipalId(): string {
  return filesAccountId();
}
