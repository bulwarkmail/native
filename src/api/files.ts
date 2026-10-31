import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { FileNode, FileNodeRights, FileNodeType, JMAPAccountInfo, JMAPMethodCall, Principal } from './types';
import { getDownloadUrl, uploadBlob, type UploadBlobOptions } from './blob';
import { batched, JMAPSetError, requireMethodResult } from './jmap-result';
import { decodeFileNodeName, getUniqueName } from '../lib/filenode-name';
import { acceptedFileName, fileNameRulesFrom, type FileNameRules } from '../lib/file-name-rules';
import { mediaTypeEssence } from '../lib/media-type';
import { accountSupports } from '../lib/account-capability';

/**
 * What a FileNode is: a file, a folder or a symlink.
 *
 * `nodeType` says so on Stalwart 0.16.6 and later. Without it, a node is a
 * folder exactly when it has no content blob — the server stores a container
 * with `file == null`; sending a blobId/type/size on create (as older builds
 * did: type 'd' + an empty blob) makes a 0-byte FILE that nothing can ever be
 * parented under (#379). Stalwart 1.0 adds symlinks, which have no blob
 * either but can't hold anything, so the blob rule alone would show them as
 * empty folders.
 */
export function fileNodeKind(node: Pick<FileNode, 'nodeType' | 'blobId'>): FileNodeType {
  switch (node.nodeType) {
    case 'file':
    case 'directory':
    case 'symlink':
      return node.nodeType;
    default:
      return node.blobId == null ? 'directory' : 'file';
  }
}

// The webmail migrates legacy flat-named nodes into the real parentId
// hierarchy on load; this app reads and writes only the real hierarchy.
export function isFolder(node: Pick<FileNode, 'nodeType' | 'blobId'>): boolean {
  return fileNodeKind(node) === 'directory';
}

/** A symbolic link (Stalwart 1.0): no content and no children, so it can't be opened. */
export function isSymlink(node: Pick<FileNode, 'nodeType' | 'blobId'>): boolean {
  return fileNodeKind(node) === 'symlink';
}

/**
 * Stalwart 1.0.0 implements File Storage draft 18, which names the kind
 * `@type` ("File", "Directory", "SymLink") and the media type `mediaType`.
 * 0.16 calls them `nodeType` and `type`. Each server leaves the other's names
 * out of FileNode/get and refuses them in a create ("@type is required on
 * creation." on 1.0.0, "Invalid property." for `@type` on 0.16.27).
 */
const DRAFT_NODE_TYPES: Record<string, FileNodeType> = { File: 'file', Directory: 'directory', SymLink: 'symlink' };

type DraftFileNode = { '@type'?: unknown; mediaType?: unknown };

/** A node of either draft, with the kind in `nodeType` and the media type in `type`. */
export function fromDraftFileNode<T extends Partial<FileNode>>(node: T & DraftFileNode): T {
  const kind = typeof node['@type'] === 'string' ? DRAFT_NODE_TYPES[node['@type']] : undefined;
  const mediaType = typeof node.mediaType === 'string' ? node.mediaType : undefined;
  if (!kind && mediaType === undefined) return node;
  return {
    ...node,
    ...(kind && !node.nodeType ? { nodeType: kind } : {}),
    ...(mediaType !== undefined && node.type == null ? { type: mediaType } : {}),
  };
}

/** The properties of a draft-18 FileNode/set create, from 0.16 ones (no blob: a folder). */
function toDraftFileNodeCreate(props: Record<string, unknown>): Record<string, unknown> {
  const { type, ...rest } = props;
  return rest.blobId == null
    ? { '@type': 'Directory', ...rest }
    : { '@type': 'File', ...rest, mediaType: type };
}

// Stalwart omits shareWith/myRights from FileNode/get unless they are
// requested explicitly, so the share sheet and indicators must name them here.
// The modification timestamp is `modified` (RFC draft-ietf-jmap-filenode);
// asking for a property the server doesn't know silently yields undefined,
// which is how "updated" left every date blank (#700).
const FILE_NODE_PROPERTIES = [
  'id', 'parentId', 'name', 'type', 'blobId', 'size', 'created', 'modified',
  // Tells 1.0's symlinks from folders (see fileNodeKind); servers before
  // 0.16.6 skip it.
  'nodeType',
  // `nodeType` and `type` as Stalwart 1.0.0 names them (see fromDraftFileNode).
  '@type', 'mediaType',
  'shareWith', 'myRights',
];

/**
 * A folder Stalwart 1.0 lists only as the way down to something shared with
 * the user: the ancestors of a shared node come back with a name and parent
 * but no dates and every right false. A node the user may read always has
 * both dates, and 0.16 never leaves `modified` out.
 */
function isDiscoverableOnly(node: FileNode): boolean {
  const rights = node.myRights;
  return node.modified == null && node.created == null
    && !!rights && Object.values(rights).every((granted) => !granted);
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
// FileNode action fails with an authorization error (#563). A shared account
// that lists no capabilities at all falls back to the server-wide one; one
// that lists them without FileNode is not capable (lib/account-capability,
// webmail #1239). Mirrors the webmail's `supportsFiles`.
export function accountSupportsFiles(
  account: JMAPAccountInfo | undefined,
  sessionCapabilities: Record<string, unknown> | undefined,
): boolean {
  return accountSupports(account, sessionCapabilities, CAPABILITIES.FILES);
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

/**
 * The account and bare id behind a FileNode id as the listings name it. A
 * write must go to the account that holds the node, with the id that
 * account knows: sent to the user's own account, "acc:node" is an unknown
 * id at best and, stripped, could name an unrelated node of the user's own.
 * `null` is the user's own drive root.
 */
export function resolveFileNodeId(id: string | null): { accountId: string; id: string | null } {
  const primary = filesAccountId();
  if (id === null) return { accountId: primary, id: null };
  const sep = id.indexOf(':');
  if (sep > 0) {
    const accountId = id.slice(0, sep);
    if (accountId !== primary && filesCapableAccountIds().includes(accountId)) {
      return { accountId, id: id.slice(sep + 1) };
    }
  }
  return { accountId: primary, id };
}

/** A node created or listed in `accountId`, with ids namespaced as the listings do. */
function namespaceFileNode(node: FileNode, accountId: string): FileNode {
  if (accountId === filesAccountId()) return node;
  return {
    ...node,
    id: `${accountId}:${node.id}`,
    parentId: node.parentId == null ? null : `${accountId}:${node.parentId}`,
    accountId,
    isShared: true,
  };
}

/**
 * The bare id of `parentId` in `accountId`. Folders hold nodes of their own
 * account only, so a parent elsewhere is refused before anything is sent.
 */
function parentInAccount(parentId: string | null, accountId: string): string | null {
  const parent = resolveFileNodeId(parentId);
  if (parent.accountId !== accountId) {
    throw new JMAPSetError('invalidProperties', 'Files cannot be moved between accounts', ['parentId']);
  }
  return parent.id;
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
  // Stalwart 1.0 refuses the return-all /get instead of cutting it short
  // (#1385); then every node comes from the query below.
  const tooMany = result?.[0] === 'error' && result[1]?.type === 'requestTooLarge';
  if (!result || (result[0] === 'error' && !tooMany)) {
    throw new Error(result?.[1]?.description || 'FileNode list failed');
  }
  const firstPage = tooMany ? [] : ((result[1].list ?? []) as FileNode[]).map(fromDraftFileNode);
  const maxObjects = jmapClient.getMaxObjectsInGet();
  if (!tooMany && firstPage.length < maxObjects) return firstPage;

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
        for (const node of (r[1].list ?? []) as FileNode[]) known.set(node.id, fromDraftFileNode(node));
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
    // With nothing read there is no tree to show, so say why.
    if (known.size === 0) throw err;
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
// account the user may use FileNode with (accountSupportsFiles).
export function filesCapableAccountIds(): string[] {
  const primaryId = filesAccountId();
  const session = jmapClient.currentSession;
  const accounts = session?.accounts ?? {};
  const rest = Object.entries(accounts)
    .filter(([id, info]) => id !== primaryId && accountSupportsFiles(info, session?.capabilities))
    .map(([id]) => id);
  return [primaryId, ...rest];
}

// Fetch every FileNode the logged-in user can see across all accessible
// accounts. Nodes owned by another principal (shared with the user) are
// tagged `isShared: true` with the owning accountId/accountName, and their
// ids/parentIds are namespaced "accountId:nodeId". Folders listed only as the
// way down to a shared node are marked `discoverableOnly`. Mirrors the
// webmail's listAllFileNodesAcrossAccounts.
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
          ...(!isPrimary && isDiscoverableOnly(node) ? { discoverableOnly: true } : {}),
        });
      }
    } catch (err) {
      // A failed listing of the user's own drive is an error to show, not
      // an empty drive (#1385 looked like "No files yet").
      if (isPrimary) throw err;
      // A single unreachable shared account shouldn't hide the user's own
      // files; skip it and keep aggregating.
    }
  }

  return all;
}

/**
 * The naming rules the server publishes for FileNodes (Stalwart 0.16.6+),
 * with Stalwart 1.0's stricter ones on top; null when it publishes none.
 */
export function getFileNameRules(): FileNameRules | null {
  return fileNameRulesFrom(jmapClient.getAccountCapability(CAPABILITIES.FILES, filesAccountId()));
}

type SetError = { type?: string; description?: string; properties?: string[] };

/** A refused FileNode/set entry as an error that keeps its type and properties. */
function fileSetError(err: SetError | undefined, fallback: string): JMAPSetError {
  return new JMAPSetError(err?.type ?? 'setError', err?.description || fallback, err?.properties);
}

/**
 * The nodes a Files folder lists. At the root: the user's own top-level
 * nodes plus the roots of every shared-with-me subtree, a shared node whose
 * parent isn't among the nodes shown. Inside a folder: its children.
 *
 * Stalwart 1.0's placeholder folders above a shared node (discoverableOnly)
 * are left out of both: left in, the owner's top folder became the shared
 * root, and the folder actually shared sat somewhere below it, under folders
 * where rename, delete and move could only fail. They stay in `nodes`, where
 * they still link a shared node to the path above it.
 */
export function listFolder(nodes: FileNode[], parentId: string | null): FileNode[] {
  if (parentId === null) {
    const shown = new Set(nodes.filter((n) => !n.discoverableOnly).map((n) => n.id));
    return nodes.filter((n) => !n.discoverableOnly && (
      n.isShared
        ? n.parentId == null || !shown.has(n.parentId)
        : (n.parentId ?? null) === null
    ));
  }
  return nodes.filter((n) => !n.discoverableOnly && (n.parentId ?? null) === parentId);
}

/**
 * Stalwart 1.0.0 (File Storage draft 18) wants `@type` and `mediaType` in a
 * create (see toDraftFileNodeCreate). Of the drafts Stalwart has shipped,
 * only that one lists `supportedNodeTypes`. A shared account may come
 * without the capability; the user's own files account stands in, as
 * Stalwart publishes the same one for every account.
 */
function usesDraftFileNodeCreate(accountId: string): boolean {
  // Read the accounts' own capabilities: the session-wide one is empty on
  // both versions.
  const accounts = jmapClient.currentSession?.accounts;
  const cap = accounts?.[accountId]?.accountCapabilities?.[CAPABILITIES.FILES]
    ?? accounts?.[filesAccountId()]?.accountCapabilities?.[CAPABILITIES.FILES];
  return !!cap && typeof cap === 'object' && 'supportedNodeTypes' in cap;
}

/**
 * Whether a FileNode made from a message part's blobId holds that part.
 * Stalwart 1.0.0 stores the part; 0.16 stores the whole raw message the part
 * is in under the part's name (seen on 0.16.27), so there the part's bytes
 * have to be uploaded as a blob of their own first. Told apart as for the
 * create shape: only 1.0.0 implements File Storage draft 18.
 */
export function fileNodeTakesPartBlobs(accountId: string = filesAccountId()): boolean {
  return usesDraftFileNodeCreate(accountId);
}

/** One FileNode/set create in `accountId`, in the shape that server takes. */
async function createFileNodeIn(
  accountId: string,
  props: Record<string, unknown>,
  key: string,
  fallback: string,
): Promise<FileNode> {
  const wire = usesDraftFileNodeCreate(accountId) ? toDraftFileNodeCreate(props) : props;
  const res = await jmapClient.request(
    [['FileNode/set', { accountId, create: { [key]: wire } }, '0']],
    fileUsing(),
  );
  const result = requireMethodResult(res, '0', 'FileNode/set');
  const created = result.created?.[key];
  if (!created) {
    throw fileSetError(result.notCreated?.[key], fallback);
  }
  // The create response carries only server-set properties; keep the ones
  // sent so callers can rely on name, parentId and type.
  return fromDraftFileNode({ ...wire, ...created } as FileNode);
}

/** A new folder in `parentId`, which may be a folder of a shared account. */
export async function createFolder(
  name: string,
  parentId: string | null,
): Promise<FileNode> {
  const parent = resolveFileNodeId(parentId);
  const props: Record<string, unknown> = { name: acceptedFileName(name, getFileNameRules()) };
  if (parent.id !== null) props.parentId = parent.id;
  const created = await createFileNodeIn(parent.accountId, props, 'new-dir', 'Create folder failed');
  return namespaceFileNode(created, parent.accountId);
}

export async function updateFileNode(
  id: string,
  updates: Partial<Pick<FileNode, 'name' | 'parentId'>>,
): Promise<void> {
  const node = resolveFileNodeId(id);
  const nodeId = node.id as string;
  const patch: Record<string, unknown> = { ...updates };
  if ('parentId' in updates) patch.parentId = parentInAccount(updates.parentId ?? null, node.accountId);
  const res = await jmapClient.request(
    [['FileNode/set', { accountId: node.accountId, update: { [nodeId]: patch } }, '0']],
    fileUsing(),
  );
  // A method-level error (e.g. forbidden) has no notUpdated entry, so without
  // this check a refused rename or move reported success.
  const notUpdated = requireMethodResult(res, '0', 'FileNode/set').notUpdated?.[nodeId];
  if (notUpdated) throw fileSetError(notUpdated, 'Update failed');
}

export interface FileNodeUpdateResult {
  updated: string[];
  notUpdated: Record<string, JMAPSetError>;
}

/**
 * Several renames or moves in one account, in FileNode/set calls of at most
 * `maxObjectsInSet` each. Every id must name a node of the same account (all
 * the user's own, or all of one shared account), and so must new parents.
 * Refusals come back per id instead of being thrown.
 */
export async function updateFileNodes(
  updates: Record<string, Partial<Pick<FileNode, 'name' | 'parentId'>>>,
): Promise<FileNodeUpdateResult> {
  const result: FileNodeUpdateResult = { updated: [], notUpdated: {} };
  const ids = Object.keys(updates);
  if (ids.length === 0) return result;
  const accountId = resolveFileNodeId(ids[0]).accountId;
  const listedIds = new Map<string, string>();
  const patches: Record<string, Record<string, unknown>> = {};
  for (const id of ids) {
    const node = resolveFileNodeId(id);
    if (node.accountId !== accountId) {
      throw new JMAPSetError('invalidProperties', 'Files of different accounts cannot be changed together');
    }
    const patch: Record<string, unknown> = { ...updates[id] };
    if ('parentId' in updates[id]) patch.parentId = parentInAccount(updates[id].parentId ?? null, accountId);
    listedIds.set(node.id as string, id);
    patches[node.id as string] = patch;
  }
  for (const slice of batched(Object.keys(patches), jmapClient.getMaxObjectsInSet())) {
    const res = await jmapClient.request(
      [['FileNode/set', { accountId, update: Object.fromEntries(slice.map((id) => [id, patches[id]])) }, '0']],
      fileUsing(),
    );
    const set = requireMethodResult(res, '0', 'FileNode/set');
    const refused = (set.notUpdated ?? {}) as Record<string, SetError>;
    for (const id of slice) {
      const listed = listedIds.get(id)!;
      if (refused[id]) result.notUpdated[listed] = fileSetError(refused[id], 'Update failed');
      else if (set.updated && id in set.updated) result.updated.push(listed);
    }
  }
  return result;
}

/**
 * Remove folders that hold nothing, without onDestroyRemoveChildren: the
 * server refuses one that still holds anything (`nodeHasChildren`), so what
 * another client has just put there stays. Refusals are not errors here;
 * returns the ids that went.
 */
export async function destroyEmptyFolders(ids: string[]): Promise<string[]> {
  const gone: string[] = [];
  const byAccount = new Map<string, Map<string, string>>();
  for (const id of ids) {
    const node = resolveFileNodeId(id);
    const listed = byAccount.get(node.accountId) ?? new Map<string, string>();
    listed.set(node.id as string, id);
    byAccount.set(node.accountId, listed);
  }
  for (const [accountId, listed] of byAccount) {
    for (const slice of batched([...listed.keys()], jmapClient.getMaxObjectsInSet())) {
      const res = await jmapClient.request(
        [['FileNode/set', { accountId, destroy: slice }, '0']],
        fileUsing(),
      );
      const destroyed = (requireMethodResult(res, '0', 'FileNode/set').destroyed ?? []) as string[];
      gone.push(...destroyed.map((id) => listed.get(id) ?? id));
    }
  }
  return gone;
}

export async function renameFileNode(id: string, newName: string): Promise<void> {
  await updateFileNode(id, { name: newName });
}

// Re-parent a node. `null` moves it to the drive root (the property must be
// sent explicitly as null, omitting it would leave the node where it is).
// The new parent must be in the node's own account.
export async function moveFileNode(id: string, parentId: string | null): Promise<void> {
  await updateFileNode(id, { parentId });
}

export async function deleteFileNodes(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  // Each account gets its own FileNode/set with the ids it knows.
  const byAccount = new Map<string, string[]>();
  for (const id of ids) {
    const node = resolveFileNodeId(id);
    const list = byAccount.get(node.accountId) ?? [];
    list.push(node.id as string);
    byAccount.set(node.accountId, list);
  }
  // One FileNode/set per `maxObjectsInSet` ids: a request over the limit
  // fails whole (RFC 8620 §3.6.1), so a large selection deleted nothing.
  // Every batch runs; refusals are reported once all of them are done.
  const refused: SetError[] = [];
  for (const [accountId, accountIds] of byAccount) {
    for (const slice of batched(accountIds, jmapClient.getMaxObjectsInSet())) {
      const res = await jmapClient.request(
        [['FileNode/set', {
          accountId,
          destroy: slice,
          // The server removes descendant nodes of destroyed folders.
          onDestroyRemoveChildren: true,
        }, '0']],
        fileUsing(),
      );
      const notDestroyed = requireMethodResult(res, '0', 'FileNode/set').notDestroyed as
        | Record<string, SetError>
        | undefined;
      // A node inside a folder an earlier batch removed is already gone.
      refused.push(...Object.values(notDestroyed ?? {}).filter((err) => err?.type !== 'notFound'));
    }
  }
  if (refused.length > 0) {
    throw fileSetError(refused[0], `Failed to delete ${refused.length} item(s)`);
  }
}

export function getFileNodeDownloadUrl(node: FileNode): string {
  if (!node.blobId) throw new Error('Folders cannot be downloaded');
  return getDownloadUrl(node.blobId, node.name, node.type, node.accountId);
}

// The `type` is the bare media type (`top/sub`, lowercase, no parameters):
// Stalwart 1.0 refuses anything else, and the floor, 0.16.6, takes up to 256
// characters. The old cap at 30 characters stored every Office document as
// application/octet-stream. No `size` either: every server takes it from the
// blob, and 1.0 refuses one that differs.
async function createFileNodeFromBlob(
  name: string,
  blobId: string,
  type: string | undefined,
  parentId: string | null,
): Promise<FileNode> {
  // The blob may come from the user's own account (an upload) or another
  // one (a copy): Stalwart takes any blob the user may read.
  const parent = resolveFileNodeId(parentId);
  const props: Record<string, unknown> = {
    name: acceptedFileName(name, getFileNameRules()),
    type: mediaTypeEssence(type),
    blobId,
  };
  if (parent.id !== null) props.parentId = parent.id;
  const created = await createFileNodeIn(parent.accountId, props, 'new-file', 'Upload failed');
  return namespaceFileNode(created, parent.accountId);
}

export async function uploadFileNode(
  uri: string,
  name: string,
  mimeType: string,
  parentId: string | null,
  options: UploadBlobOptions = {},
): Promise<FileNode> {
  const blob = await uploadBlob(uri, mimeType, options);
  return createFileNodeFromBlob(name, blob.blobId, blob.type || mimeType, parentId);
}

/** A file picked for upload. */
export interface UploadAsset {
  uri: string;
  name: string;
  mimeType?: string | null;
}

export interface UploadBatchResult {
  uploaded: FileNode[];
  /** The files the server refused, by their name on the device, in upload order. */
  failed: Array<{ name: string; error: unknown }>;
}

/**
 * Upload picked files into `parentId`, one after another. A name from the
 * device may hold characters every server refuses (`<>:"\|?*`) or, on
 * Stalwart 1.0, a control character or a reserved stem (`con.txt`): each is
 * stored under a variant the server accepts, made unique among
 * `existingNames`. A file the server refuses no longer stops the rest; it
 * comes back in `failed`. Cancelling through `signal` stops after the file in
 * flight.
 */
export async function uploadFileBatch(
  assets: UploadAsset[],
  parentId: string | null,
  existingNames: Iterable<string>,
  options: {
    signal?: AbortSignal;
    /** A file starts uploading, under the name it will have. */
    onFile?: (index: number, name: string) => void;
    onProgress?: (sent: number, total: number) => void;
  } = {},
): Promise<UploadBatchResult> {
  const { signal, onFile, onProgress } = options;
  const rules = getFileNameRules();
  // Duplicate names get " (1)", " (2)", ... so two nodes never share a name.
  const existing = new Set(existingNames);
  const result: UploadBatchResult = { uploaded: [], failed: [] };
  for (let i = 0; i < assets.length; i++) {
    if (signal?.aborted) break;
    const asset = assets[i];
    const name = getUniqueName(acceptedFileName(asset.name, rules), existing);
    existing.add(name);
    onFile?.(i, name);
    try {
      result.uploaded.push(await uploadFileNode(
        asset.uri,
        name,
        asset.mimeType || 'application/octet-stream',
        parentId,
        { signal, onProgress },
      ));
    } catch (err) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) break;
      result.failed.push({ name: asset.name, error: err });
    }
  }
  return result;
}

// Copy a file by creating a new node that references the same blob — no
// bytes are re-uploaded (webmail `copyFileNode`). Folders and symlinks have
// no blob and cannot be duplicated this way.
export async function copyFileNode(
  node: FileNode,
  parentId: string | null,
  newName: string = node.name,
): Promise<FileNode> {
  if (!node.blobId || fileNodeKind(node) !== 'file') throw new Error('Folders cannot be duplicated');
  return createFileNodeFromBlob(newName, node.blobId, node.type, parentId);
}

/**
 * Copy a file, or a folder with everything in it, into `parentId` (webmail
 * copyFileNode). A folder node carries no content, so the subtree is made
 * again level by level from `tree`, the listing the ids of `node` and
 * `parentId` come from; the files in it point at the same blobs. A copy that
 * fails part-way is taken back, the deepest level first, without
 * onDestroyRemoveChildren: whatever someone else put into its folders
 * meanwhile stays.
 */
export async function copyFileTree(
  node: FileNode,
  tree: FileNode[],
  parentId: string | null,
  newName: string = node.name,
): Promise<FileNode> {
  const kind = fileNodeKind(node);
  if (kind === 'symlink') throw new Error('Symbolic links cannot be copied');
  if (kind === 'file') return copyFileNode(node, parentId, newName);

  const childrenOf = new Map<string, FileNode[]>();
  for (const entry of tree) {
    if (entry.parentId == null) continue;
    const siblings = childrenOf.get(entry.parentId);
    if (siblings) siblings.push(entry);
    else childrenOf.set(entry.parentId, [entry]);
  }
  // The ids this copy creates, by level below the copy (0 is the copy itself).
  const made: string[][] = [];
  const seen = new Set<string>([node.id]);
  const create = async (source: FileNode, name: string, parent: string | null, level: number): Promise<FileNode> => {
    const created = fileNodeKind(source) === 'directory'
      ? await createFolder(name, parent)
      : await createFileNodeFromBlob(name, source.blobId!, source.type, parent);
    (made[level] ??= []).push(created.id);
    return created;
  };
  const copyChildren = async (folderId: string, copyId: string, level: number): Promise<void> => {
    for (const child of childrenOf.get(folderId) ?? []) {
      // Symlinks have nothing to copy; a copy inside the source is not copied again.
      if (seen.has(child.id) || fileNodeKind(child) === 'symlink') continue;
      if (fileNodeKind(child) === 'file' && !child.blobId) continue;
      seen.add(child.id);
      const created = await create(child, child.name, copyId, level);
      if (fileNodeKind(child) === 'directory') await copyChildren(child.id, created.id, level + 1);
    }
  };

  const root = await create(node, newName, parentId, 0);
  seen.add(root.id);
  try {
    await copyChildren(node.id, root.id, 1);
  } catch (err) {
    for (let level = made.length - 1; level >= 0; level--) {
      await destroyEmptyFolders(made[level] ?? []).catch(() => []);
    }
    throw err;
  }
  return root;
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
  const node = resolveFileNodeId(fileNodeId);
  const nodeId = node.id as string;
  const res = await jmapClient.request(
    [['FileNode/set', {
      accountId: node.accountId,
      update: { [nodeId]: { [`shareWith/${principalId}`]: rights } },
    }, '0']],
    fileUsing(),
  );
  const result = requireMethodResult(res, '0', 'FileNode/set');
  if (result.notUpdated?.[nodeId]) {
    throw fileSetError(result.notUpdated[nodeId], 'Failed to update file share');
  }
  if (!result.updated || !(nodeId in result.updated)) {
    throw new Error('Server did not confirm the share update');
  }
}

/** Safety bound on how many principals the share picker pages through. */
const MAX_PRINCIPALS = 20_000;

// The Principal properties the share sheets read. 0.16's default list is the
// same; 1.0's adds `capabilities` for every principal and `accounts`, a whole
// account object with every account capability.
const PRINCIPAL_PROPERTIES = ['id', 'type', 'name', 'description', 'email'];

// Stalwart 1.0's answer to Principal/query while the administrator keeps
// directory queries off (the default).
const DIRECTORY_QUERIES_OFF = 'The administrator has disabled directory queries.';

/**
 * How complete a principal listing is:
 * - `ok`: the whole directory;
 * - `restricted`: the server refused to list its directory (`forbidden`:
 *   Stalwart 1.0 with directory queries off, or a role without the
 *   permission). The principals are what Principal/get without ids still
 *   returns, on 1.0 the user's own account, their groups and the accounts
 *   that shared something with them;
 * - `error`: the listing failed part-way; the principals are what arrived.
 */
export type PrincipalDirectoryStatus = 'ok' | 'restricted' | 'error';

export interface PrincipalListing {
  principals: Principal[];
  status: PrincipalDirectoryStatus;
  /**
   * The refusal was Stalwart 1.0's own: an administrator can allow directory
   * queries in its sharing settings.
   */
  directoryQueriesOff?: boolean;
}

function principalsUsing(): string[] {
  return [CAPABILITIES.CORE, CAPABILITIES.PRINCIPALS];
}

// List all principals visible to the user, and how complete the list is.
// Stalwart returns the full directory regardless of `filter`, so callers
// filter client-side. Paged by maxObjectsInGet: an unbounded query hands every
// id to the chained Principal/get, which the server refuses with
// `requestTooLarge` once the directory holds more than that (500), leaving the
// picker empty.
export async function listPrincipals(): Promise<PrincipalListing> {
  if (!supportsSharing()) return { principals: [], status: 'ok' };
  const accountId = jmapClient.accountId;
  const pageSize = jmapClient.getMaxObjectsInGet();
  const all: Principal[] = [];
  try {
    for (let position = 0; position < MAX_PRINCIPALS;) {
      const res = await jmapClient.request(
        [
          ['Principal/query', { accountId, position, limit: pageSize }, '0'],
          ['Principal/get', {
            accountId,
            '#ids': { resultOf: '0', name: 'Principal/query', path: '/ids' },
            properties: PRINCIPAL_PROPERTIES,
          }, '1'],
        ],
        principalsUsing(),
      );
      const responses = res.methodResponses ?? [];
      const queryResp = responses.find((r) => r[0] === 'Principal/query');
      const getResp = responses.find((r) => r[0] === 'Principal/get');
      if (!queryResp || !getResp) {
        // A refused query makes the chained get fail with
        // invalidResultReference; only the query's own error says why.
        const error = (responses.find((r) => r[0] === 'error' && r[2] === '0')
          ?? responses.find((r) => r[0] === 'error'))?.[1] as { type?: string; description?: string } | undefined;
        if (error?.type === 'forbidden') {
          return {
            principals: await getKnownPrincipals(accountId),
            status: 'restricted',
            directoryQueriesOff: error.description === DIRECTORY_QUERIES_OFF,
          };
        }
        console.warn('[files] listing principals failed', error);
        return { principals: all, status: 'error' };
      }
      const ids = (queryResp[1].ids ?? []) as string[];
      all.push(...((getResp[1].list ?? []) as Principal[]));
      if (ids.length < pageSize) break;
      position += ids.length;
    }
    return { principals: all, status: 'ok' };
  } catch (err) {
    console.warn('[files] listing principals failed', err);
    return { principals: all, status: 'error' };
  }
}

/**
 * Principal/get without ids. When the directory can't be listed, Stalwart 1.0
 * still returns the principals the user already knows: their own account,
 * their groups and the accounts that shared something with them. Empty when
 * that is refused too.
 */
async function getKnownPrincipals(accountId: string): Promise<Principal[]> {
  try {
    const res = await jmapClient.request(
      [['Principal/get', { accountId, ids: null, properties: PRINCIPAL_PROPERTIES }, '0']],
      principalsUsing(),
    );
    const [method, result] = res.methodResponses?.[0] ?? [];
    if (method !== 'Principal/get') return [];
    return (result.list ?? []) as Principal[];
  } catch (err) {
    console.warn('[files] reading known principals failed', err);
    return [];
  }
}

/** The principals of {@link listPrincipals}, without the status. */
export async function getPrincipals(): Promise<Principal[]> {
  return (await listPrincipals()).principals;
}

// The principal id that represents the logged-in user (excluded from the
// share picker — sharing with yourself is a no-op the server may reject).
export function ownPrincipalId(): string {
  return filesAccountId();
}
