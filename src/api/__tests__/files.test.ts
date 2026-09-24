import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    hasCapability: vi.fn(),
    hasAccountCapability: vi.fn(() => false),
    getMaxSizeUpload: vi.fn(() => 0),
    getMaxObjectsInGet: vi.fn(() => 500),
    getMaxCallsInRequest: vi.fn(() => 16),
    currentSession: null as unknown,
  },
}));

vi.mock('../blob', () => ({
  getDownloadUrl: vi.fn(
    (blobId: string, _name?: string, _type?: string, accountId?: string) =>
      `https://dl/${accountId ?? 'own'}/${blobId}`,
  ),
  uploadBlob: vi.fn(),
  uploadBytes: vi.fn(),
}));

import { jmapClient } from '../jmap-client';
import { CAPABILITIES } from '../types';
import {
  accountSupportsFiles,
  copyFileNode,
  createFolder,
  deleteFileNodes,
  getAllFileNodes,
  getAllFileNodesAcrossAccounts,
  getFileNodeDownloadUrl,
  getPrincipals,
  isCrossAccountId,
  isFolder,
  moveFileNode,
  renameFileNode,
  setFileNodeShare,
  supportsSharing,
} from '../files';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;
const mockHasCapability = jmapClient.hasCapability as ReturnType<typeof vi.fn>;
const mockMaxObjectsInGet = jmapClient.getMaxObjectsInGet as ReturnType<typeof vi.fn>;
const mockMaxCallsInRequest = jmapClient.getMaxCallsInRequest as ReturnType<typeof vi.fn>;

function setSession(session: unknown) {
  (jmapClient as { currentSession: unknown }).currentSession = session;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockMaxObjectsInGet.mockReturnValue(500);
  mockMaxCallsInRequest.mockReturnValue(16);
  mockHasCapability.mockImplementation(
    (urn: string) =>
      urn === CAPABILITIES.FILES ||
      urn === CAPABILITIES.PRINCIPALS ||
      urn === CAPABILITIES.PRINCIPALS_OWNER,
  );
  setSession({
    primaryAccounts: { [CAPABILITIES.FILES]: 'acc-1' },
    accounts: {
      'acc-1': { name: 'me@example.com', isPersonal: true },
    },
  });
});

describe('isFolder', () => {
  it('treats blob-less nodes as folders and anything with a blob as a file', () => {
    // #379: a blob-marked node — even the legacy type:'d' dir markers — is a
    // 0-byte file that nothing can be parented under.
    expect(isFolder({ blobId: null })).toBe(true);
    expect(isFolder({ blobId: undefined })).toBe(true);
    expect(isFolder({ blobId: 'blob-1' })).toBe(false);
  });
});

describe('createFolder', () => {
  it('creates a real container node: no blobId/type/size, parentId set', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['FileNode/set', { created: { 'new-dir': { id: 'f1' } } }, '0']],
    });

    await createFolder('Docs', 'parent-1');

    const [method, args] = mockRequest.mock.calls[0][0][0];
    expect(method).toBe('FileNode/set');
    expect(args.create['new-dir']).toEqual({ name: 'Docs', parentId: 'parent-1' });
  });

  it('omits parentId at the root', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['FileNode/set', { created: { 'new-dir': { id: 'f1' } } }, '0']],
    });

    await createFolder('Docs', null);

    const args = mockRequest.mock.calls[0][0][0][1];
    expect(args.create['new-dir']).toEqual({ name: 'Docs' });
  });
});

describe('deleteFileNodes', () => {
  it('lets the server cascade into folder children', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['FileNode/set', { destroyed: ['f1'] }, '0']],
    });

    await deleteFileNodes(['f1']);

    const args = mockRequest.mock.calls[0][0][0][1];
    expect(args.destroy).toEqual(['f1']);
    expect(args.onDestroyRemoveChildren).toBe(true);
  });

  it('throws when the server refuses a destroy', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [
        ['FileNode/set', { notDestroyed: { f1: { description: 'forbidden' } } }, '0'],
      ],
    });

    await expect(deleteFileNodes(['f1'])).rejects.toThrow('forbidden');
  });
});

describe('setFileNodeShare', () => {
  it('patches shareWith/{principalId} and requests the principals:owner capability', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['FileNode/set', { updated: { 'node-1': null } }, '0']],
    });
    const rights = {
      mayRead: true, mayAddChildren: false, mayRename: false,
      mayDelete: false, mayModifyContent: false, mayShare: false,
    };

    await setFileNodeShare('node-1', 'principal-2', rights);

    const [calls, using] = mockRequest.mock.calls[0];
    expect(calls[0][1].update['node-1']).toEqual({ 'shareWith/principal-2': rights });
    expect(using).toContain(CAPABILITIES.PRINCIPALS_OWNER);
  });

  it('sends null rights to revoke access', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['FileNode/set', { updated: { 'node-1': null } }, '0']],
    });

    await setFileNodeShare('node-1', 'principal-2', null);

    const args = mockRequest.mock.calls[0][0][0][1];
    expect(args.update['node-1']).toEqual({ 'shareWith/principal-2': null });
  });

  it('throws when the server rejects or does not confirm the update', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [
        ['FileNode/set', { notUpdated: { 'node-1': { description: 'no mayShare right' } } }, '0'],
      ],
    });
    await expect(setFileNodeShare('node-1', 'p2', null)).rejects.toThrow('no mayShare right');

    mockRequest.mockResolvedValue({ methodResponses: [['FileNode/set', {}, '0']] });
    await expect(setFileNodeShare('node-1', 'p2', null)).rejects.toThrow(
      'Server did not confirm the share update',
    );
  });
});

describe('getAllFileNodesAcrossAccounts', () => {
  it('namespaces ids of nodes from other principals and tags them isShared', async () => {
    setSession({
      primaryAccounts: { [CAPABILITIES.FILES]: 'acc-1' },
      accounts: {
        'acc-1': { name: 'me@example.com', isPersonal: true },
        'acc-2': { name: 'Team', isPersonal: false },
      },
    });
    mockRequest
      .mockResolvedValueOnce({
        methodResponses: [
          ['FileNode/get', { list: [{ id: 'own-1', name: 'mine.txt', parentId: null, blobId: 'b1' }] }, '0'],
        ],
      })
      .mockResolvedValueOnce({
        methodResponses: [
          ['FileNode/get', {
            list: [
              { id: 's1', name: 'Shared Folder', parentId: null, blobId: null },
              { id: 's2', name: 'inside.txt', parentId: 's1', blobId: 'b2' },
            ],
          }, '0'],
        ],
      });

    const nodes = await getAllFileNodesAcrossAccounts();

    expect(nodes).toHaveLength(3);
    const own = nodes.find((n) => n.id === 'own-1')!;
    expect(own.isShared).toBe(false);
    expect(isCrossAccountId(own.id)).toBe(false);

    const folder = nodes.find((n) => n.name === 'Shared Folder')!;
    expect(folder.id).toBe('acc-2:s1');
    expect(folder.isShared).toBe(true);
    expect(folder.accountId).toBe('acc-2');
    expect(folder.accountName).toBe('Team');

    // parentId is namespaced the same way so child lookups keep working.
    const child = nodes.find((n) => n.name === 'inside.txt')!;
    expect(child.parentId).toBe('acc-2:s1');
  });

  it('skips personal accounts without the filenode capability', async () => {
    setSession({
      primaryAccounts: { [CAPABILITIES.FILES]: 'acc-1' },
      accounts: {
        'acc-1': { name: 'me@example.com', isPersonal: true },
        'acc-3': { name: 'other personal', isPersonal: true },
      },
    });
    mockRequest.mockResolvedValue({
      methodResponses: [['FileNode/get', { list: [] }, '0']],
    });

    await getAllFileNodesAcrossAccounts();

    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest.mock.calls[0][0][0][1].accountId).toBe('acc-1');
  });
});

type MethodCall = [string, Record<string, unknown>, string];
interface FakeNode { id: string; parentId: string | null; name: string; blobId: string | null }

const fakeFile = (id: string, parentId: string | null = null): FakeNode =>
  ({ id, parentId, name: `${id}.txt`, blobId: `blob-${id}` });
const fakeFolder = (id: string, parentId: string | null = null): FakeNode =>
  ({ id, parentId, name: id, blobId: null });
const sortedIds = (nodes: { id: string }[]) => nodes.map((n) => n.id).sort();

// Answers like Stalwart: FileNode/get with ids:null silently stops at
// maxObjectsInGet, an over-long id list is refused, and FileNode/query clamps
// `limit` to the server's own maximum.
function fakeFilesServer(nodes: FakeNode[], opts: {
  maxObjectsInGet: number;
  maxCallsInRequest?: number;
  queryMaxResults?: number;
  // Stalwart before 0.16.6 returns leaf files only.
  queryOmitsFolders?: boolean;
  queryFails?: boolean;
}): MethodCall[][] {
  mockMaxObjectsInGet.mockReturnValue(opts.maxObjectsInGet);
  if (opts.maxCallsInRequest) mockMaxCallsInRequest.mockReturnValue(opts.maxCallsInRequest);
  const sent: MethodCall[][] = [];
  mockRequest.mockImplementation(async (methodCalls: MethodCall[]) => {
    sent.push(methodCalls);
    const methodResponses = methodCalls.map(([method, args, callId]) => {
      if (method === 'FileNode/get') {
        const ids = args.ids as string[] | null;
        if (ids === null) return [method, { list: nodes.slice(0, opts.maxObjectsInGet) }, callId];
        if (ids.length > opts.maxObjectsInGet) return ['error', { type: 'requestTooLarge' }, callId];
        return [method, {
          list: nodes.filter((n) => ids.includes(n.id)),
          notFound: ids.filter((id) => !nodes.some((n) => n.id === id)),
        }, callId];
      }
      if (method === 'FileNode/query') {
        if (opts.queryFails) return ['error', { type: 'unknownMethod' }, callId];
        const matching = opts.queryOmitsFolders ? nodes.filter((n) => n.blobId !== null) : nodes;
        const position = (args.position as number) ?? 0;
        const limit = Math.min((args.limit as number) ?? Infinity, opts.queryMaxResults ?? Infinity);
        return [method, {
          ids: matching.slice(position, position + limit).map((n) => n.id),
          position,
          total: matching.length,
        }, callId];
      }
      return ['error', { type: 'unknownMethod' }, callId];
    });
    return { methodResponses };
  });
  return sent;
}

describe('listing past maxObjectsInGet (#1069)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('lists files and folders created after the first 500 nodes', async () => {
    // The audit repro: 510 root files created before two folders.
    const all = [
      ...Array.from({ length: 510 }, (_, i) => fakeFile(`file-${String(i).padStart(4, '0')}`)),
      fakeFolder('Documents'),
      fakeFolder('Photos'),
      fakeFile('cv', 'Documents'),
      fakeFile('beach', 'Photos'),
    ];
    const sent = fakeFilesServer(all, { maxObjectsInGet: 500 });

    const nodes = await getAllFileNodes();

    expect(nodes).toHaveLength(all.length);
    expect(sortedIds(nodes)).toEqual(sortedIds(all));
    // Only the 14 nodes the first /get cut off are fetched again.
    const idGets = sent.flat().filter(([m, a]) => m === 'FileNode/get' && a.ids !== null);
    expect(idGets.flatMap(([, a]) => a.ids as string[]).sort()).toEqual(sortedIds(all.slice(500)));
  });

  it('stays a single request while the account fits in one /get', async () => {
    const sent = fakeFilesServer(
      [fakeFolder('d1'), fakeFile('a', 'd1'), fakeFile('b')],
      { maxObjectsInGet: 5 },
    );

    const nodes = await getAllFileNodes();
    expect(sortedIds(nodes)).toEqual(['a', 'b', 'd1']);
    expect(sent).toHaveLength(1);
    expect(sent[0][0][1].ids).toBeNull();
  });

  it('pages the query and batches the /gets within the server limits', async () => {
    const all = [
      fakeFolder('d1'),
      ...Array.from({ length: 10 }, (_, i) => fakeFile(`f${i}`, 'd1')),
      fakeFolder('d2'),
    ];
    // The server hands out fewer ids per page than the client asks for.
    const sent = fakeFilesServer(all, { maxObjectsInGet: 3, maxCallsInRequest: 2, queryMaxResults: 5 });

    const nodes = await getAllFileNodes();
    expect(sortedIds(nodes)).toEqual(sortedIds(all));

    const calls = sent.flat();
    expect(calls.filter(([m]) => m === 'FileNode/query').map(([, a]) => a.position)).toEqual([0, 5, 10]);
    const idGets = calls.filter(([m, a]) => m === 'FileNode/get' && a.ids !== null);
    expect(idGets.flatMap(([, a]) => a.ids as string[]).sort()).toEqual(sortedIds(all.slice(3)));
    for (const [, args] of idGets) expect((args.ids as string[]).length).toBeLessThanOrEqual(3);
    for (const request of sent) expect(request.length).toBeLessThanOrEqual(2);
  });

  it('recovers folders when the query returns files only (Stalwart < 0.16.6)', async () => {
    // Both folders sit past the first /get, and only `deep` has files in it.
    const all = [
      fakeFile('f0'), fakeFile('f1'), fakeFile('f2', 'deep'),
      fakeFolder('top'), fakeFolder('deep', 'top'),
    ];
    fakeFilesServer(all, { maxObjectsInGet: 2, queryOmitsFolders: true });

    const nodes = await getAllFileNodes();
    expect(sortedIds(nodes)).toEqual(sortedIds(all));
  });

  it('asks for an unreadable parent once and moves on', async () => {
    // A node shared out of a folder the user cannot read.
    const all = [fakeFile('f0'), fakeFile('f1'), fakeFile('f2', 'hidden')];
    const sent = fakeFilesServer(all, { maxObjectsInGet: 2 });

    const nodes = await getAllFileNodes();
    expect(sortedIds(nodes)).toEqual(['f0', 'f1', 'f2']);
    const askedForHidden = sent.flat().filter(
      ([m, a]) => m === 'FileNode/get' && (a.ids as string[] | null)?.includes('hidden'),
    );
    expect(askedForHidden).toHaveLength(1);
  });

  it('keeps the first page when the query is refused', async () => {
    fakeFilesServer([fakeFile('f0'), fakeFile('f1'), fakeFile('f2')], { maxObjectsInGet: 2, queryFails: true });

    const nodes = await getAllFileNodes();
    expect(sortedIds(nodes)).toEqual(['f0', 'f1']);
  });

  it('lists shared accounts past the limit too', async () => {
    setSession({
      primaryAccounts: { [CAPABILITIES.FILES]: 'acc-1' },
      accounts: {
        'acc-1': { name: 'me@example.com', isPersonal: true },
        'acc-2': { name: 'Team', isPersonal: false },
      },
    });
    const all = [fakeFile('f0'), fakeFile('f1'), fakeFile('f2'), fakeFile('f3')];
    fakeFilesServer(all, { maxObjectsInGet: 2 });

    const nodes = await getAllFileNodesAcrossAccounts();
    expect(sortedIds(nodes.filter((n) => !n.isShared))).toEqual(['f0', 'f1', 'f2', 'f3']);
    expect(sortedIds(nodes.filter((n) => n.isShared)))
      .toEqual(['acc-2:f0', 'acc-2:f1', 'acc-2:f2', 'acc-2:f3']);
  });
});

describe('getFileNodeDownloadUrl', () => {
  it('routes shared blobs to the owning account', () => {
    const url = getFileNodeDownloadUrl({
      id: 'acc-2:s2', name: 'inside.txt', type: 'text/plain',
      blobId: 'b2', accountId: 'acc-2',
    });
    expect(url).toBe('https://dl/acc-2/b2');
  });
});

describe('getPrincipals', () => {
  it('queries then gets via back-reference', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [
        ['Principal/query', { ids: ['p1'] }, '0'],
        ['Principal/get', { list: [{ id: 'p1', name: 'other', type: 'individual' }] }, '1'],
      ],
    });

    const principals = await getPrincipals();

    expect(principals).toEqual([{ id: 'p1', name: 'other', type: 'individual' }]);
    const calls = mockRequest.mock.calls[0][0];
    expect(calls[0][0]).toBe('Principal/query');
    expect(calls[1][0]).toBe('Principal/get');
    expect(calls[1][1]['#ids']).toEqual({ resultOf: '0', name: 'Principal/query', path: '/ids' });
  });

  it('returns empty when the server lacks the principals capability', async () => {
    mockHasCapability.mockReturnValue(false);
    expect(await getPrincipals()).toEqual([]);
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe('decodeFileNodeName at the API boundary (#869)', () => {
  it('decodes percent-encoded names from getAllFileNodes and the cross-account list', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['FileNode/get', {
        list: [
          { id: 'n1', name: 'Spares%20Catalog', blobId: null },
          { id: 'n2', name: '100% done.txt', blobId: 'b2' },
        ],
      }, '0']],
    });

    const own = await getAllFileNodes();
    expect(own.map((n) => n.name)).toEqual(['Spares Catalog', '100% done.txt']);

    const all = await getAllFileNodesAcrossAccounts();
    expect(all.map((n) => n.name)).toEqual(['Spares Catalog', '100% done.txt']);
  });

  it('requests the real "modified" property, not "updated" (#700)', async () => {
    mockRequest.mockResolvedValue({ methodResponses: [['FileNode/get', { list: [] }, '0']] });
    await getAllFileNodes();
    const [, args] = mockRequest.mock.calls[0][0][0];
    expect(args.properties).toContain('modified');
    expect(args.properties).not.toContain('updated');
  });
});

describe('copyFileNode', () => {
  it('creates a new node that reuses the blob instead of re-uploading', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['FileNode/set', { created: { 'new-file': { id: 'copy-1' } } }, '0']],
    });

    const copy = await copyFileNode(
      { id: 'f1', name: 'report.pdf', type: 'application/pdf', blobId: 'blob-1', size: 10, parentId: 'dir-1' },
      'dir-1',
      'report (1).pdf',
    );

    const [method, args] = mockRequest.mock.calls[0][0][0];
    expect(method).toBe('FileNode/set');
    expect(args.create['new-file']).toEqual({
      name: 'report (1).pdf', type: 'application/pdf', blobId: 'blob-1', size: 10, parentId: 'dir-1',
    });
    expect(copy.id).toBe('copy-1');
  });

  it('refuses to duplicate folders', async () => {
    await expect(copyFileNode({ id: 'd', name: 'Docs', type: '', blobId: null }, null)).rejects.toThrow();
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe('moveFileNode', () => {
  it('sends an explicit null parentId when moving to the root', async () => {
    mockRequest.mockResolvedValue({ methodResponses: [['FileNode/set', { updated: { f1: null } }, '0']] });
    await moveFileNode('f1', null);
    const [, args] = mockRequest.mock.calls[0][0][0];
    expect(args.update.f1).toEqual({ parentId: null });
  });
});

describe('FileNode/set refused by the server', () => {
  const methodError = {
    methodResponses: [['error', { type: 'forbidden', description: 'No write access' }, '0']],
  };

  it('fails a rename, move or delete answered with a method error', async () => {
    mockRequest.mockResolvedValue(methodError);

    await expect(renameFileNode('f1', 'new.txt')).rejects.toThrow('No write access');
    await expect(moveFileNode('f1', 'dir-1')).rejects.toThrow('No write access');
    await expect(deleteFileNodes(['f1'])).rejects.toThrow('No write access');
  });

  it('fails a create or share answered with a method error', async () => {
    mockRequest.mockResolvedValue(methodError);

    await expect(createFolder('Docs', null)).rejects.toThrow('No write access');
    await expect(
      copyFileNode({ id: 'f1', name: 'a.txt', type: 'text/plain', blobId: 'b1' }, null),
    ).rejects.toThrow('No write access');
    await expect(setFileNodeShare('f1', 'p2', null)).rejects.toThrow('No write access');
  });

  it('fails a rename the server lists under notUpdated', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['FileNode/set', { notUpdated: { f1: { type: 'forbidden', description: 'read-only' } } }, '0']],
    });

    await expect(renameFileNode('f1', 'new.txt')).rejects.toThrow('read-only');
  });
});

describe('accountSupportsFiles (#563)', () => {
  const caps = { [CAPABILITIES.FILES]: {} };
  it('requires the account capability on personal accounts', () => {
    expect(accountSupportsFiles({ name: 'me', isPersonal: true, isReadOnly: false }, caps)).toBe(false);
    expect(accountSupportsFiles(
      { name: 'me', isPersonal: true, isReadOnly: false, accountCapabilities: { [CAPABILITIES.FILES]: {} } },
      caps,
    )).toBe(true);
  });

  it('treats non-personal accounts as capable and needs the session capability', () => {
    expect(accountSupportsFiles({ name: 'grp', isPersonal: false, isReadOnly: false }, caps)).toBe(true);
    expect(accountSupportsFiles({ name: 'grp', isPersonal: false, isReadOnly: false }, {})).toBe(false);
    expect(accountSupportsFiles(undefined, caps)).toBe(false);
  });
});

describe('supportsSharing', () => {
  it('accepts principals:owner from the session or the account capabilities', () => {
    const mockHasAccountCapability = jmapClient.hasAccountCapability as ReturnType<typeof vi.fn>;
    mockHasCapability.mockImplementation((urn: string) => urn === CAPABILITIES.FILES);
    mockHasAccountCapability.mockReturnValue(false);
    expect(supportsSharing()).toBe(false);

    mockHasAccountCapability.mockImplementation((urn: string) => urn === CAPABILITIES.PRINCIPALS_OWNER);
    expect(supportsSharing()).toBe(true);

    mockHasAccountCapability.mockReturnValue(false);
    mockHasCapability.mockImplementation(
      (urn: string) => urn === CAPABILITIES.FILES || urn === CAPABILITIES.PRINCIPALS_OWNER,
    );
    expect(supportsSharing()).toBe(true);
  });
});
