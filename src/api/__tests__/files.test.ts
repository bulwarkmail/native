import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    hasCapability: vi.fn(),
    hasAccountCapability: vi.fn(() => false),
    // A current server (0.16.6+) advertises forbiddenNameChars.
    getAccountCapability: vi.fn((): unknown => ({ forbiddenNameChars: '/' })),
    getMaxSizeUpload: vi.fn(() => 0),
    getMaxObjectsInGet: vi.fn(() => 500),
    getMaxObjectsInSet: vi.fn(() => 500),
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
  fileNodeAttachment,
  planFileNodePick,
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
const mockGetAccountCapability = jmapClient.getAccountCapability as ReturnType<typeof vi.fn>;
const mockHasCapability = jmapClient.hasCapability as ReturnType<typeof vi.fn>;
const mockMaxObjectsInGet = jmapClient.getMaxObjectsInGet as ReturnType<typeof vi.fn>;
const mockMaxCallsInRequest = jmapClient.getMaxCallsInRequest as ReturnType<typeof vi.fn>;
const mockMaxObjectsInSet = jmapClient.getMaxObjectsInSet as ReturnType<typeof vi.fn>;

function setSession(session: unknown) {
  (jmapClient as { currentSession: unknown }).currentSession = session;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAccountCapability.mockReturnValue({ forbiddenNameChars: '/' });
  mockMaxObjectsInGet.mockReturnValue(500);
  mockMaxObjectsInSet.mockReturnValue(500);
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

  it('sends onExists rename', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['FileNode/set', { created: { 'new-dir': { id: 'f1' } } }, '0']],
    });

    await createFolder('Docs', null);

    expect(mockRequest.mock.calls[0][0][0][1].onExists).toBe('rename');
  });

  it("takes the server's renamed name", async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [
        ['FileNode/set', { created: { 'new-dir': { id: 'f1', name: 'Docs (2)' } } }, '0'],
      ],
    });

    const node = await createFolder('Docs', null);

    expect(node.name).toBe('Docs (2)');
  });

  it('retries with a numbered name on a server that ignores onExists', async () => {
    const taken = { notCreated: { 'new-dir': { type: 'invalidProperties', description: 'Name already exists' } } };
    mockRequest
      .mockResolvedValueOnce({ methodResponses: [['FileNode/set', taken, '0']] })
      .mockResolvedValueOnce({ methodResponses: [['FileNode/set', taken, '0']] })
      .mockResolvedValueOnce({
        methodResponses: [['FileNode/set', { created: { 'new-dir': { id: 'f1' } } }, '0']],
      });

    const node = await createFolder('Docs', null);

    const names = mockRequest.mock.calls.map((c) => c[0][0][1].create['new-dir'].name);
    expect(names).toEqual(['Docs', 'Docs (2)', 'Docs (3)']);
    expect(node.name).toBe('Docs (3)');
  });

  it('gives up after 20 attempts', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [
        ['FileNode/set', { notCreated: { 'new-dir': { description: 'Name already exists' } } }, '0'],
      ],
    });

    await expect(createFolder('Docs', null)).rejects.toThrow('already exists');
    expect(mockRequest).toHaveBeenCalledTimes(20);
  });

  it('does not retry other refusals', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [
        ['FileNode/set', { notCreated: { 'new-dir': { description: 'forbidden' } } }, '0'],
      ],
    });

    await expect(createFolder('Docs', null)).rejects.toThrow('forbidden');
    expect(mockRequest).toHaveBeenCalledTimes(1);
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

  it("splits a large selection into batches of the server's maxObjectsInSet", async () => {
    mockMaxObjectsInSet.mockReturnValue(2);
    const destroyed = (ids: string[]) => ({ methodResponses: [['FileNode/set', { destroyed: ids }, '0']] });
    mockRequest
      .mockResolvedValueOnce(destroyed(['a', 'b']))
      .mockResolvedValueOnce(destroyed(['c', 'd']))
      .mockResolvedValueOnce(destroyed(['e']));

    await deleteFileNodes(['a', 'b', 'c', 'd', 'e']);

    expect(mockRequest.mock.calls.map((c) => c[0][0][1].destroy)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(mockRequest.mock.calls.every((c) => c[0][0][1].onDestroyRemoveChildren === true)).toBe(true);
  });

  it('accepts a node that an earlier batch already removed with its folder', async () => {
    mockMaxObjectsInSet.mockReturnValue(1);
    mockRequest
      .mockResolvedValueOnce({ methodResponses: [['FileNode/set', { destroyed: ['folder'] }, '0']] })
      .mockResolvedValueOnce({
        methodResponses: [['FileNode/set', { notDestroyed: { child: { type: 'notFound' } } }, '0']],
      });

    await expect(deleteFileNodes(['folder', 'child'])).resolves.toBeUndefined();
  });

  it('still deletes the other batches when one item is refused', async () => {
    mockMaxObjectsInSet.mockReturnValue(1);
    mockRequest
      .mockResolvedValueOnce({
        methodResponses: [['FileNode/set', { notDestroyed: { a: { type: 'forbidden', description: 'forbidden' } } }, '0']],
      })
      .mockResolvedValueOnce({ methodResponses: [['FileNode/set', { destroyed: ['b'] }, '0']] });

    await expect(deleteFileNodes(['a', 'b'])).rejects.toThrow('forbidden');
    expect(mockRequest).toHaveBeenCalledTimes(2);
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

  it('pages through a directory larger than maxObjectsInGet', async () => {
    const directory = Array.from({ length: 1203 }, (_, i) => ({ id: `p${i}`, name: `user${i}`, type: 'individual' }));
    mockRequest.mockImplementation(async (calls: [string, Record<string, unknown>, string][]) => {
      const { position, limit } = calls[0][1] as { position: number; limit: number };
      const page = directory.slice(position, position + limit);
      return {
        methodResponses: [
          ['Principal/query', { ids: page.map((p) => p.id), position }, '0'],
          ['Principal/get', { list: page }, '1'],
        ],
      };
    });

    const principals = await getPrincipals();

    expect(principals).toHaveLength(1203);
    expect(mockRequest.mock.calls.map(([calls]) => calls[0][1].position)).toEqual([0, 500, 1000]);
    for (const [calls] of mockRequest.mock.calls) expect(calls[0][1].limit).toBe(500);
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

  // Answers each FileNode/set create with the next id: copy-1, copy-2, ...
  function mockCreates() {
    let n = 0;
    mockRequest.mockImplementation(async (calls: any[]) => {
      const [, args] = calls[0];
      const key = Object.keys(args.create)[0];
      return { methodResponses: [['FileNode/set', { created: { [key]: { id: `copy-${++n}` } } }, '0']] };
    });
  }
  const creates = () => mockRequest.mock.calls.map((c) => c[0][0][1].create).filter(Boolean).map((c) => Object.values(c)[0] as any);

  it('copies a folder with its whole subtree', async () => {
    mockCreates();
    const tree = [
      { id: 'root', name: 'Docs', type: '', blobId: null, parentId: null },
      { id: 'f1', name: 'a.txt', type: 'text/plain', blobId: 'b1', size: 1, parentId: 'root' },
      { id: 'sub', name: 'Sub', type: '', blobId: null, parentId: 'root' },
      { id: 'f2', name: 'b.txt', type: 'text/plain', blobId: 'b2', size: 2, parentId: 'sub' },
      { id: 'other', name: 'Other', type: '', blobId: null, parentId: null },
    ];

    const copy = await copyFileNode(tree[0], null, 'Docs (1)', tree);

    expect(copy.id).toBe('copy-1');
    const sent = creates();
    expect(sent).toHaveLength(4);
    expect(sent[0]).toEqual({ name: 'Docs (1)' });
    expect(sent[1]).toMatchObject({ name: 'a.txt', blobId: 'b1', parentId: 'copy-1' });
    expect(sent[2]).toEqual({ name: 'Sub', parentId: 'copy-1' });
    expect(sent[3]).toMatchObject({ name: 'b.txt', blobId: 'b2', parentId: 'copy-3' });
  });

  it('copies an empty folder', async () => {
    mockCreates();
    const tree = [{ id: 'd', name: 'Empty', type: '', blobId: null, parentId: 'p' }];
    await copyFileNode(tree[0], 'p', 'Empty (1)', tree);
    expect(creates()).toEqual([{ name: 'Empty (1)', parentId: 'p' }]);
  });

  it('fetches the tree itself when none is given', async () => {
    mockRequest.mockResolvedValueOnce({
      methodResponses: [['FileNode/get', { list: [
        { id: 'd', name: 'Docs', parentId: null },
        { id: 'f1', name: 'a.txt', type: 'text/plain', blobId: 'b1', size: 1, parentId: 'd' },
      ] }, '0']],
    });
    mockCreates();
    await copyFileNode({ id: 'd', name: 'Docs', type: '', blobId: null }, null, 'Docs (1)');
    const sent = creates();
    expect(sent.some((c) => c.name === 'a.txt' && c.parentId === 'copy-1')).toBe(true);
  });

  it('does not revisit the copies when a folder is copied into itself', async () => {
    mockCreates();
    const tree = [
      { id: 'd', name: 'Docs', type: '', blobId: null, parentId: null },
      { id: 'f1', name: 'a.txt', type: 'text/plain', blobId: 'b1', size: 1, parentId: 'd' },
    ];
    await copyFileNode(tree[0], 'd', 'Docs', tree);
    const sent = creates();
    expect(sent).toHaveLength(2);
    expect(sent[0]).toEqual({ name: 'Docs', parentId: 'd' });
    expect(sent[1]).toMatchObject({ name: 'a.txt', parentId: 'copy-1' });
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
  // What Stalwart advertises: principals and principals:availability, never
  // principals:owner.
  const stalwartCapabilities = (urn: string) =>
    urn === CAPABILITIES.FILES ||
    urn === CAPABILITIES.PRINCIPALS ||
    urn === 'urn:ietf:params:jmap:principals:availability';

  it('offers sharing when the server advertises principals', () => {
    mockHasCapability.mockImplementation(stalwartCapabilities);
    expect(supportsSharing()).toBe(true);

    mockHasCapability.mockImplementation((urn: string) => urn === CAPABILITIES.FILES);
    expect(supportsSharing()).toBe(false);
  });

  it('still lists principals and leaves principals:owner out of FileNode requests on Stalwart', async () => {
    mockHasCapability.mockImplementation(stalwartCapabilities);
    mockRequest.mockResolvedValue({
      methodResponses: [
        ['Principal/query', { ids: ['p1'] }, '0'],
        ['Principal/get', { list: [{ id: 'p1', name: 'other', type: 'individual' }] }, '1'],
      ],
    });
    expect(await getPrincipals()).toHaveLength(1);

    mockRequest.mockResolvedValue({ methodResponses: [['FileNode/set', { updated: { f1: null } }, '0']] });
    await setFileNodeShare('f1', 'p1', null);
    const [, using] = mockRequest.mock.calls[1];
    expect(using).toEqual([CAPABILITIES.CORE, CAPABILITIES.FILES]);
  });
});

const OFFICE_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('servers before Stalwart 0.16.6', () => {
  const legacy = () => mockGetAccountCapability.mockReturnValue({ maxFileNodeDepth: 8 });
  const ack = () => mockRequest.mockResolvedValue({
    methodResponses: [['FileNode/set', { created: { 'new-file': { id: 'c1' } }, updated: { n1: null } }, '0']],
  });

  it('shares with the mayWrite rights of servers before 0.16.6', async () => {
    legacy();
    ack();
    await setFileNodeShare('n1', 'p1', {
      mayRead: true, mayAddChildren: true, mayRename: false, mayDelete: false, mayModifyContent: false, mayShare: false,
    });
    expect(mockRequest.mock.calls[0][0][0][1].update.n1).toEqual({
      'shareWith/p1': { mayRead: true, mayWrite: true, mayShare: false },
    });
  });

  it('shares with the finer rights on a current server', async () => {
    ack();
    const rights = {
      mayRead: true, mayAddChildren: true, mayRename: false, mayDelete: false, mayModifyContent: false, mayShare: false,
    };
    await setFileNodeShare('n1', 'p1', rights);
    expect(mockRequest.mock.calls[0][0][0][1].update.n1).toEqual({ 'shareWith/p1': rights });
  });

  it('reads old mayWrite rights as the finer rights', async () => {
    legacy();
    mockRequest.mockResolvedValue({
      methodResponses: [['FileNode/get', {
        list: [{
          id: 'd1', name: 'Docs', blobId: null,
          myRights: { mayRead: true, mayWrite: true, mayShare: false },
          shareWith: { p1: { mayRead: true, mayWrite: false, mayShare: false } },
        }],
      }, '0']],
    });
    const [node] = await getAllFileNodes();
    expect(node.myRights).toEqual({
      mayRead: true, mayAddChildren: true, mayRename: true, mayDelete: true, mayModifyContent: true, mayShare: false,
    });
    expect(node.shareWith?.p1).toEqual({
      mayRead: true, mayAddChildren: false, mayRename: false, mayDelete: false, mayModifyContent: false, mayShare: false,
    });
  });

  it('falls back to octet-stream for a long type on a legacy server', async () => {
    legacy();
    ack();
    await copyFileNode({ id: 'f1', name: 'a.docx', type: OFFICE_TYPE, blobId: 'b1', size: 1 }, null);
    expect(mockRequest.mock.calls[0][0][0][1].create['new-file'].type).toBe('application/octet-stream');
  });
});

describe('MIME types on a current server', () => {
  it('keeps a 40-character office MIME type on a current server', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['FileNode/set', { created: { 'new-file': { id: 'c1' } } }, '0']],
    });
    await copyFileNode({ id: 'f1', name: 'a.docx', type: OFFICE_TYPE, blobId: 'b1', size: 1 }, null);
    expect(mockRequest.mock.calls[0][0][0][1].create['new-file'].type).toBe(OFFICE_TYPE);
  });
});

describe('createFolder name decoding (#869)', () => {
  it('returns a created node with its percent-encoded name decoded', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['FileNode/set', { created: { 'new-dir': { id: 'f1', name: 'Spares%20Catalog' } } }, '0']],
    });
    const node = await createFolder('Spares Catalog', null);
    expect(node.name).toBe('Spares Catalog');
  });
});

describe('fileNodeAttachment (#1179)', () => {
  const own = {
    id: 'f1', name: 'report.pdf', parentId: null, type: 'application/pdf',
    blobId: 'b1', size: 1000, accountId: 'c', isShared: false,
  };

  it('turns a file in the owner\'s account into an attachment of its blob', () => {
    expect(fileNodeAttachment(own, 'c', 0)).toEqual({
      ok: true,
      attachment: { blobId: 'b1', name: 'report.pdf', type: 'application/pdf', size: 1000 },
    });
  });

  it('falls back to octet-stream when the node has no type', () => {
    const result = fileNodeAttachment({ ...own, type: '' }, 'c', 0);
    expect(result.ok && result.attachment.type).toBe('application/octet-stream');
  });

  it('refuses a node shared from another account: its blob id names a blob there', () => {
    const shared = { ...own, id: 'e:f1', accountId: 'e', accountName: 'userb@example.org', isShared: true };
    expect(fileNodeAttachment(shared, 'c', 0)).toEqual({ ok: false, reason: 'other_account' });
  });

  it('refuses a node of a listing read for another account, whose ids collide with ours', () => {
    expect(fileNodeAttachment(own, 'd', 0)).toEqual({ ok: false, reason: 'other_account' });
    expect(fileNodeAttachment({ ...own, accountId: undefined }, 'c', 0)).toEqual({ ok: false, reason: 'other_account' });
    expect(fileNodeAttachment(own, '', 0)).toEqual({ ok: false, reason: 'other_account' });
  });

  it('refuses a folder', () => {
    expect(fileNodeAttachment({ ...own, type: 'd', blobId: null, size: 0 }, 'c', 0))
      .toEqual({ ok: false, reason: 'folder' });
  });

  it('refuses a file over the per-file limit, and takes one at the limit', () => {
    expect(fileNodeAttachment(own, 'c', 999)).toEqual({ ok: false, reason: 'too_large' });
    expect(fileNodeAttachment(own, 'c', 1000).ok).toBe(true);
  });
});

describe('planFileNodePick', () => {
  const file = (id: string, name: string, blobId: string, size = 100) => ({
    id, name, parentId: null, type: 'text/plain', blobId, size, accountId: 'c', isShared: false,
  });
  const fitsAll = () => true;

  it('attaches two identical files with different names, each once', () => {
    // Same content, so the same blob: deduping by blob dropped the second name.
    const plan = planFileNodePick([file('f1', 'a.txt', 'b1'), file('f2', 'copy of a.txt', 'b1')], {
      accountId: 'c', maxSizeUpload: 0, attachedNodeIds: [], fitsTotal: fitsAll,
    });
    expect(plan.attach.map((a) => [a.nodeId, a.name, a.blobId])).toEqual([['f1', 'a.txt', 'b1'], ['f2', 'copy of a.txt', 'b1']]);
    expect(plan.alreadyAttached).toEqual([]);
  });

  it('skips a node already on the message, or picked twice, and names it', () => {
    const plan = planFileNodePick([file('f1', 'a.txt', 'b1'), file('f2', 'b.txt', 'b2'), file('f2', 'b.txt', 'b2')], {
      accountId: 'c', maxSizeUpload: 0, attachedNodeIds: ['f1'], fitsTotal: fitsAll,
    });
    expect(plan.attach.map((a) => a.nodeId)).toEqual(['f2']);
    expect(plan.alreadyAttached).toEqual(['a.txt']);
  });

  it('names files over the per-file limit and stops at the total limit', () => {
    const plan = planFileNodePick([file('f1', 'big.bin', 'b1', 5000), file('f2', 'a.txt', 'b2', 60), file('f3', 'b.txt', 'b3', 60)], {
      accountId: 'c', maxSizeUpload: 1000, attachedNodeIds: [], fitsTotal: (size, adding) => size + adding <= 100,
    });
    expect(plan.attach.map((a) => a.nodeId)).toEqual(['f2']);
    expect(plan.tooLarge).toEqual(['big.bin']);
    expect(plan.overTotal).toBe(true);
  });

  it('leaves out folders and other accounts\' files without a word', () => {
    const plan = planFileNodePick([
      { ...file('d1', 'Docs', ''), blobId: null, type: 'd' },
      { ...file('e:f1', 'theirs.txt', 'b9'), accountId: 'e', isShared: true },
    ], { accountId: 'c', maxSizeUpload: 0, attachedNodeIds: [], fitsTotal: fitsAll });
    expect(plan).toEqual({ attach: [], tooLarge: [], alreadyAttached: [], overTotal: false });
  });
});
