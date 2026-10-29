import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    hasCapability: vi.fn(),
    hasAccountCapability: vi.fn(() => false),
    getMaxSizeUpload: vi.fn(() => 0),
    getMaxObjectsInGet: vi.fn(() => 500),
    getMaxObjectsInSet: vi.fn(() => 500),
    getMaxCallsInRequest: vi.fn(() => 16),
    getAccountCapability: vi.fn(),
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
import { uploadBlob } from '../blob';
import { CAPABILITIES } from '../types';
import {
  accountSupportsFiles,
  copyFileNode,
  createFolder,
  deleteFileNodes,
  fileNodeKind,
  getAllFileNodes,
  getAllFileNodesAcrossAccounts,
  getFileNameRules,
  getFileNodeDownloadUrl,
  getPrincipals,
  isCrossAccountId,
  isFolder,
  isSymlink,
  listFolder,
  listPrincipals,
  moveFileNode,
  renameFileNode,
  setFileNodeShare,
  supportsSharing,
  uploadFileBatch,
} from '../files';
import { directoryNotice } from '../../lib/principal-directory';
import { fileErrorKind } from '../../lib/file-errors';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;
const mockHasCapability = jmapClient.hasCapability as ReturnType<typeof vi.fn>;
const mockMaxObjectsInGet = jmapClient.getMaxObjectsInGet as ReturnType<typeof vi.fn>;
const mockMaxCallsInRequest = jmapClient.getMaxCallsInRequest as ReturnType<typeof vi.fn>;
const mockMaxObjectsInSet = jmapClient.getMaxObjectsInSet as ReturnType<typeof vi.fn>;

function setSession(session: unknown) {
  (jmapClient as { currentSession: unknown }).currentSession = session;
}

beforeEach(() => {
  vi.clearAllMocks();
  // No naming rules unless a test publishes some.
  (jmapClient.getAccountCapability as ReturnType<typeof vi.fn>).mockReset();
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
  // Stalwart 1.0 refuses a return-all /get past the limit (#1385).
  refusesReturnAll?: boolean;
}): MethodCall[][] {
  mockMaxObjectsInGet.mockReturnValue(opts.maxObjectsInGet);
  if (opts.maxCallsInRequest) mockMaxCallsInRequest.mockReturnValue(opts.maxCallsInRequest);
  const sent: MethodCall[][] = [];
  mockRequest.mockImplementation(async (methodCalls: MethodCall[]) => {
    sent.push(methodCalls);
    const methodResponses = methodCalls.map(([method, args, callId]) => {
      if (method === 'FileNode/get') {
        const ids = args.ids as string[] | null;
        if (ids === null && opts.refusesReturnAll && nodes.length > opts.maxObjectsInGet) {
          return ['error', { type: 'requestTooLarge' }, callId];
        }
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

  // #1385: Stalwart 1.0 answers the return-all /get of a larger account with
  // requestTooLarge instead of a first page.
  it('lists every node when Stalwart 1.0 refuses the return-all /get', async () => {
    const all = [
      fakeFolder('d1'),
      ...Array.from({ length: 6 }, (_, i) => fakeFile(`f${i}`, 'd1')),
    ];
    fakeFilesServer(all, { maxObjectsInGet: 3, refusesReturnAll: true });

    const nodes = await getAllFileNodes();
    expect(sortedIds(nodes)).toEqual(sortedIds(all));
  });

  it('reports a failed listing of the own drive instead of an empty one', async () => {
    fakeFilesServer([fakeFile('f0'), fakeFile('f1'), fakeFile('f2')], {
      maxObjectsInGet: 2, refusesReturnAll: true, queryFails: true,
    });

    await expect(getAllFileNodesAcrossAccounts()).rejects.toThrow();
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

describe('listPrincipals', () => {
  // userc's view on the test servers (live-checked).
  const DIRECTORY = [
    { id: 'b', type: 'individual', name: 'admin@example.org', description: 'System administrator', email: 'admin@example.org' },
    { id: 'c', type: 'group', name: 'team@example.org', description: 'Team (test group)', email: 'team@example.org' },
    { id: 'd', type: 'individual', name: 'usera@example.org', description: 'User A', email: 'usera@example.org' },
    { id: 'e', type: 'individual', name: 'userb@example.org', description: 'User B', email: 'userb@example.org' },
    { id: 'f', type: 'individual', name: 'userc@example.org', description: 'User C', email: 'userc@example.org' },
  ];
  const OWN = [DIRECTORY[4]];
  const PROPERTIES = ['id', 'type', 'name', 'description', 'email'];
  // Stalwart 1.0 with allowDirectoryQueries off (the default).
  const QUERIES_OFF = [
    ['error', { type: 'forbidden', description: 'The administrator has disabled directory queries.' }, '0'],
    ['error', { type: 'invalidResultReference', description: 'Result reference to 0#Principal/query not found.' }, '1'],
  ];

  it('lists the whole directory on Stalwart 0.16, asking only for the properties it shows', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [
        ['Principal/query', { accountId: 'acc-1', queryState: 'n', canCalculateChanges: true, position: 0, ids: ['b', 'c', 'd', 'e', 'f'] }, '0'],
        ['Principal/get', { accountId: 'acc-1', state: 'n', list: DIRECTORY, notFound: [] }, '1'],
      ],
    });

    expect(await listPrincipals()).toEqual({ principals: DIRECTORY, status: 'ok' });
    expect(mockRequest).toHaveBeenCalledTimes(1);
    expect(mockRequest.mock.calls[0][0][1][1].properties).toEqual(PROPERTIES);
  });

  it('falls back to the principals the user knows when Stalwart 1.0 keeps its directory closed', async () => {
    mockRequest
      .mockResolvedValueOnce({ methodResponses: QUERIES_OFF })
      .mockResolvedValueOnce({
        methodResponses: [['Principal/get', { accountId: 'acc-1', state: 'n', list: OWN, notFound: [] }, '0']],
      });

    expect(await listPrincipals()).toEqual({ principals: OWN, status: 'restricted', directoryQueriesOff: true });
    const [calls, using] = mockRequest.mock.calls[1];
    expect(calls).toEqual([['Principal/get', { accountId: 'acc-1', ids: null, properties: PROPERTIES }, '0']]);
    expect(using).toEqual([CAPABILITIES.CORE, CAPABILITIES.PRINCIPALS]);
  });

  it('calls another forbidden answer restricted without claiming directory queries are off', async () => {
    mockRequest
      .mockResolvedValueOnce({
        methodResponses: [
          ['error', { type: 'forbidden', description: 'You do not have enough permissions to access this resource.' }, '0'],
          ['error', { type: 'invalidResultReference' }, '1'],
        ],
      })
      .mockResolvedValueOnce({ methodResponses: [['error', { type: 'forbidden' }, '0']] });

    expect(await listPrincipals()).toEqual({ principals: [], status: 'restricted', directoryQueriesOff: false });
  });

  it('reports a failed listing with what arrived', async () => {
    mockMaxObjectsInGet.mockReturnValue(2);
    mockRequest
      .mockResolvedValueOnce({
        methodResponses: [
          ['Principal/query', { ids: ['b', 'c'] }, '0'],
          ['Principal/get', { list: DIRECTORY.slice(0, 2) }, '1'],
        ],
      })
      .mockRejectedValueOnce(new Error('JMAP request failed: 503'));
    expect(await listPrincipals()).toEqual({ principals: DIRECTORY.slice(0, 2), status: 'error' });

    mockRequest.mockResolvedValueOnce({ methodResponses: [['error', { type: 'serverFail' }, '0']] });
    expect(await listPrincipals()).toEqual({ principals: [], status: 'error' });
  });
});

describe('directoryNotice', () => {
  it('uses the 1.0 wording only for Stalwart 1.0\'s own refusal', () => {
    expect(directoryNotice({ status: 'ok' })).toBeNull();
    expect(directoryNotice({ status: 'restricted', directoryQueriesOff: true })).toBe('restricted');
    expect(directoryNotice({ status: 'restricted', directoryQueriesOff: false })).toBe('not_browsable');
    expect(directoryNotice({ status: 'error' })).toBe('failed');
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
    // No `size`: the server takes it from the blob, and Stalwart 1.0 refuses
    // one that differs ("size does not match the size of the blob.").
    expect(args.create['new-file']).toEqual({
      name: 'report (1).pdf', type: 'application/pdf', blobId: 'blob-1', parentId: 'dir-1',
    });
    expect(copy.id).toBe('copy-1');
  });

  it('refuses to duplicate folders and symlinks', async () => {
    await expect(copyFileNode({ id: 'd', name: 'Docs', type: '', blobId: null }, null)).rejects.toThrow();
    await expect(copyFileNode({ id: 'l', name: 'latest', type: '', blobId: null, nodeType: 'symlink' }, null)).rejects.toThrow();
    expect(mockRequest).not.toHaveBeenCalled();
  });
});

describe('fileNodeKind', () => {
  it('takes nodeType as Stalwart 0.16.6+ returns it', () => {
    expect(fileNodeKind({ nodeType: 'file', blobId: 'b1' })).toBe('file');
    expect(fileNodeKind({ nodeType: 'directory', blobId: null })).toBe('directory');
  });

  // 1.0 symlinks: `blobId`, `size` and `type` are null, like a folder's.
  it('tells a symlink from a folder on Stalwart 1.0', () => {
    const link = { nodeType: 'symlink' as const, blobId: null };
    expect(fileNodeKind(link)).toBe('symlink');
    expect(isFolder(link)).toBe(false);
    expect(isSymlink(link)).toBe(true);
  });

  it('falls back to the blob rule without nodeType (#379)', () => {
    expect(fileNodeKind({ blobId: null })).toBe('directory');
    expect(fileNodeKind({ blobId: 'b1' })).toBe('file');
    // An unknown value from some other server doesn't count.
    expect(fileNodeKind({ nodeType: 'fifo' as never, blobId: 'b1' })).toBe('file');
  });

  it('asks for nodeType in listings and never sends it in FileNode/set', async () => {
    mockRequest.mockResolvedValue({ methodResponses: [['FileNode/get', { list: [] }, '0']] });
    await getAllFileNodes();
    expect(mockRequest.mock.calls[0][0][0][1].properties).toContain('nodeType');

    mockRequest.mockResolvedValue({
      methodResponses: [['FileNode/set', { created: { 'new-dir': { id: 'd2', nodeType: 'directory' }, 'new-file': { id: 'f2', nodeType: 'file' } } }, '0']],
    });
    await createFolder('Docs', null);
    await copyFileNode({ id: 'f1', name: 'a.txt', type: 'text/plain', blobId: 'b1', nodeType: 'file' }, null);
    const created = mockRequest.mock.calls.slice(1).map(([calls]) => Object.values(calls[0][1].create)[0]);
    for (const props of created) expect(props).not.toHaveProperty('nodeType');
  });
});

describe('Stalwart 1.0.0 (File Storage draft 18)', () => {
  // The filenode account capability of 1.0.0 lists `supportedNodeTypes`; 0.16.27's doesn't.
  const CAP_100 = { maxFileNodeDepth: 64, forbiddenNameChars: '/<>:"\\|?*', supportedNodeTypes: ['Directory', 'File', 'SymLink'] };
  const CAP_016 = { maxFileNodeDepth: null, forbiddenNameChars: '/<>:"\\|?*' };

  function session(own: object, shared?: object) {
    setSession({
      primaryAccounts: { [CAPABILITIES.FILES]: 'acc-1' },
      accounts: {
        'acc-1': { name: 'me@example.com', isPersonal: true, accountCapabilities: { [CAPABILITIES.FILES]: own } },
        ...(shared ? { 'acc-2': { name: 'Team', isPersonal: false, accountCapabilities: shared } } : {}),
      },
    });
  }

  const creates = () => mockRequest.mock.calls.map(([calls]) => Object.values(calls[0][1].create ?? {})[0]);

  // Seen live: 1.0.0 answers a create without `@type` with "@type is required
  // on creation." and one with `type` with "Invalid property.".
  it('creates folders and files with @type and mediaType', async () => {
    session(CAP_100);
    mockUploadBlobOnce('blob-up', 'text/plain');
    mockRequest
      .mockResolvedValueOnce({ methodResponses: [['FileNode/set', { created: { 'new-dir': { id: 'd1' } } }, '0']] })
      .mockResolvedValueOnce({ methodResponses: [['FileNode/set', { created: { 'new-file': { id: 'f1', size: 3 } } }, '0']] })
      .mockResolvedValueOnce({ methodResponses: [['FileNode/set', { created: { 'new-file': { id: 'f2', size: 3 } } }, '0']] });

    const dir = await createFolder('New', null);
    const { uploaded } = await uploadFileBatch([{ uri: 'file:///b', name: 'b.txt', mimeType: 'text/plain' }], 'd1', []);
    const copy = await copyFileNode(uploaded[0], null, 'b (1).txt');

    expect(creates()).toEqual([
      { '@type': 'Directory', name: 'New' },
      { '@type': 'File', name: 'b.txt', mediaType: 'text/plain', blobId: 'blob-up', parentId: 'd1' },
      { '@type': 'File', name: 'b (1).txt', mediaType: 'text/plain', blobId: 'blob-up' },
    ]);
    expect(dir).toMatchObject({ id: 'd1', name: 'New', nodeType: 'directory' });
    expect(copy).toMatchObject({ id: 'f2', type: 'text/plain', nodeType: 'file' });
  });

  it('keeps the 0.16 shape on Stalwart 0.16, which refuses @type', async () => {
    session(CAP_016);
    mockRequest.mockResolvedValue({ methodResponses: [['FileNode/set', { created: { 'new-dir': { id: 'd1' }, 'new-file': { id: 'f1' } } }, '0']] });

    await createFolder('New', null);
    await copyFileNode({ id: 'f0', name: 'a.txt', type: 'text/plain', blobId: 'b1' }, null);

    expect(creates()).toEqual([
      { name: 'New' },
      { name: 'a.txt', type: 'text/plain', blobId: 'b1' },
    ]);
  });

  it('reads the kind from @type and the media type from mediaType', async () => {
    session(CAP_100);
    mockRequest.mockResolvedValue({
      methodResponses: [['FileNode/get', {
        list: [
          { id: 'd1', name: 'Docs', parentId: null, '@type': 'Directory' },
          { id: 'l1', name: 'latest', parentId: 'd1', '@type': 'SymLink' },
          { id: 'f1', name: 'a.pdf', parentId: 'd1', '@type': 'File', mediaType: 'application/pdf', blobId: 'b1', size: 3 },
        ],
      }, '0']],
    });

    const nodes = await getAllFileNodes();

    expect(mockRequest.mock.calls[0][0][0][1].properties).toEqual(expect.arrayContaining(['@type', 'mediaType']));
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    expect(fileNodeKind(byId.d1)).toBe('directory');
    // Without @type the blob rule made this an empty folder.
    expect(isSymlink(byId.l1)).toBe(true);
    expect(isFolder(byId.l1)).toBe(false);
    expect(byId.f1).toMatchObject({ type: 'application/pdf', nodeType: 'file' });
  });
});

function mockUploadBlobOnce(blobId: string, type: string) {
  (uploadBlob as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ blobId, type, size: 3 });
}

describe('"Shared with me" placeholders', () => {
  const RIGHTS_NONE = { mayRead: false, mayAddChildren: false, mayRename: false, mayDelete: false, mayModifyContent: false, mayShare: false };
  const RIGHTS_READ = { ...RIGHTS_NONE, mayRead: true };
  const stamp = { created: '2026-09-25T17:34:22Z', modified: '2026-09-25T17:34:22Z' };

  function sharedSession() {
    setSession({
      primaryAccounts: { [CAPABILITIES.FILES]: 'acc-1' },
      accounts: {
        'acc-1': { name: 'me@example.com', isPersonal: true },
        'acc-2': { name: 'usera@example.org', isPersonal: false },
      },
    });
  }

  it('hides the owner\'s folders above a shared folder on Stalwart 1.0, but keeps them for paths', async () => {
    sharedSession();
    // What 1.0 returns to a sharee of Documents/Projects/Project X: the
    // ancestors come without dates and with every right false.
    const placeholder = { nodeType: 'directory', blobId: null, type: null, size: null, created: null, modified: null, shareWith: null, myRights: RIGHTS_NONE };
    mockRequest
      .mockResolvedValueOnce({ methodResponses: [['FileNode/get', { list: [{ id: 'own-1', name: 'mine.txt', parentId: null, blobId: 'b1', nodeType: 'file', ...stamp }] }, '0']] })
      .mockResolvedValueOnce({
        methodResponses: [['FileNode/get', {
          list: [
            { id: 'docs', name: 'Documents', parentId: null, ...placeholder },
            { id: 'proj', name: 'Projects', parentId: 'docs', ...placeholder },
            { id: 'px', name: 'Project X', parentId: 'proj', nodeType: 'directory', blobId: null, ...stamp, myRights: RIGHTS_READ },
            { id: 'plan', name: 'plan.pdf', parentId: 'px', nodeType: 'file', blobId: 'b2', type: 'application/pdf', ...stamp, myRights: RIGHTS_READ },
          ],
        }, '0']],
      });

    const nodes = await getAllFileNodesAcrossAccounts();

    expect(nodes.filter((n) => n.discoverableOnly).map((n) => n.id)).toEqual(['acc-2:docs', 'acc-2:proj']);
    expect(listFolder(nodes, null).map((n) => n.name)).toEqual(['mine.txt', 'Project X']);
    expect(listFolder(nodes, 'acc-2:px').map((n) => n.name)).toEqual(['plan.pdf']);
    // Not listed even if one is opened.
    expect(listFolder(nodes, 'acc-2:docs')).toEqual([]);
  });

  it('changes nothing on Stalwart 0.16, which always sends dates', async () => {
    sharedSession();
    // 0.16.23 computes myRights from a node's own ACL only, so a child of a
    // shared folder can report every right false; it still has its dates.
    mockRequest
      .mockResolvedValueOnce({ methodResponses: [['FileNode/get', { list: [] }, '0']] })
      .mockResolvedValueOnce({
        methodResponses: [['FileNode/get', {
          list: [
            { id: 'f', name: 'Shared', parentId: 'hidden-parent', nodeType: 'directory', blobId: null, ...stamp, myRights: RIGHTS_READ },
            { id: 'c', name: 'child.txt', parentId: 'f', nodeType: 'file', blobId: 'b3', ...stamp, myRights: RIGHTS_NONE },
          ],
        }, '0']],
      });

    const nodes = await getAllFileNodesAcrossAccounts();

    expect(nodes.some((n) => n.discoverableOnly)).toBe(false);
    expect(listFolder(nodes, null).map((n) => n.name)).toEqual(['Shared']);
    expect(listFolder(nodes, 'acc-2:f').map((n) => n.name)).toEqual(['child.txt']);
  });

  it('never marks the user\'s own nodes', async () => {
    mockRequest.mockResolvedValueOnce({
      methodResponses: [['FileNode/get', { list: [{ id: 'x', name: 'odd', parentId: null, blobId: null, created: null, modified: null, myRights: RIGHTS_NONE }] }, '0']],
    });
    const nodes = await getAllFileNodesAcrossAccounts();
    expect(nodes[0].discoverableOnly).toBeUndefined();
    expect(listFolder(nodes, null)).toHaveLength(1);
  });
});

describe('file names', () => {
  const RESERVED = [
    '.', '..', 'CON', 'PRN', 'AUX', 'NUL', 'COM0', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7',
    'COM8', 'COM9', 'LPT0', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
  ];
  // The filenode account capability of the test servers (live-checked).
  const CAPABILITY = {
    '1.0': { maxFileNodeDepth: 64, maxSizeFileNodeName: 255, forbiddenNameChars: '/<>:"\\|?*', forbiddenNodeNames: RESERVED },
    '0.16': { maxFileNodeDepth: null, maxSizeFileNodeName: 255, forbiddenNameChars: '/<>:"\\|?*', forbiddenNodeNames: RESERVED },
  };
  const mockCapability = jmapClient.getAccountCapability as ReturnType<typeof vi.fn>;

  it.each(['1.0', '0.16'] as const)('reads the naming rules from the files account on Stalwart %s', (version) => {
    mockCapability.mockImplementation((urn: string, accountId?: string) =>
      (urn === CAPABILITIES.FILES && accountId === 'acc-1' ? CAPABILITY[version] : undefined));
    expect(getFileNameRules()).toMatchObject({ forbiddenChars: '/<>:"\\|?*', maxNameBytes: 255 });
  });

  it.each(['1.0', '0.16'] as const)('stores a new file under a name Stalwart %s accepts', async (version) => {
    mockCapability.mockReturnValue(CAPABILITY[version]);
    mockRequest.mockResolvedValue({ methodResponses: [['FileNode/set', { created: { 'new-file': { id: 'n1' } } }, '0']] });

    await copyFileNode({ id: 'f1', name: 'x', type: 'text/plain', blobId: 'b1' }, null, 'con.txt');
    await copyFileNode({ id: 'f1', name: 'x', type: 'text/plain', blobId: 'b1' }, null, 'a:b?.txt');

    const names = mockRequest.mock.calls.map(([calls]) => calls[0][1].create['new-file'].name);
    // 0.16.23 would take "con.txt"; 1.0 refuses it, so both get "con_.txt".
    expect(names).toEqual(['con_.txt', 'a_b_.txt']);
  });

  it('leaves names alone where the server publishes no rules', async () => {
    mockCapability.mockReturnValue({});
    mockRequest.mockResolvedValue({ methodResponses: [['FileNode/set', { created: { 'new-dir': { id: 'd1' } } }, '0']] });
    await createFolder('con', null);
    expect(mockRequest.mock.calls[0][0][0][1].create['new-dir'].name).toBe('con');
  });
});

describe('media type of new files', () => {
  const create = async (type: string) => {
    mockRequest.mockResolvedValue({ methodResponses: [['FileNode/set', { created: { 'new-file': { id: 'n1' } } }, '0']] });
    await copyFileNode({ id: 'f1', name: 'doc', type, blobId: 'b1' }, null);
    return mockRequest.mock.calls.at(-1)![0][0][1].create['new-file'].type;
  };

  it('keeps Office types whole instead of storing them as application/octet-stream', async () => {
    expect(await create('application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
      .toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });

  it('sends the bare lowercase media type Stalwart 1.0 requires', async () => {
    // 1.0: "type is not a valid media type." for parameters; uppercase is taken but lowered.
    expect(await create('Text/Plain; charset=utf-8')).toBe('text/plain');
    expect(await create('')).toBe('application/octet-stream');
    expect(await create('d')).toBe('application/octet-stream');
  });
});

describe('file errors', () => {
  it('keeps the type and properties of a refused create, move, delete and copy', async () => {
    mockRequest.mockResolvedValueOnce({
      methodResponses: [['FileNode/set', {
        notCreated: { 'new-dir': { type: 'invalidProperties', description: 'Name is reserved and cannot be used.', properties: ['name'] } },
      }, '0']],
    });
    const created = await createFolder('con', null).catch((e: unknown) => e);
    expect(fileErrorKind(created)).toBe('invalidName');
    expect((created as Error).message).toBe('Name is reserved and cannot be used.');

    mockRequest.mockResolvedValueOnce({
      methodResponses: [['FileNode/set', {
        notUpdated: { f1: { type: 'invalidProperties', description: 'Maximum folder depth exceeded.', properties: ['parentId'] } },
      }, '0']],
    });
    expect(fileErrorKind(await moveFileNode('f1', 'deep').catch((e: unknown) => e))).toBe('tooDeep');

    mockRequest.mockResolvedValueOnce({
      methodResponses: [['FileNode/set', { notDestroyed: { f1: { type: 'forbidden', description: 'You are not allowed to delete this file node.' } } }, '0']],
    });
    expect(fileErrorKind(await deleteFileNodes(['f1']).catch((e: unknown) => e))).toBe('forbidden');

    mockRequest.mockResolvedValueOnce({
      methodResponses: [['FileNode/set', {
        notCreated: { 'new-file': { type: 'overQuota', description: 'There are too many files, please delete some before adding a new one.' } },
      }, '0']],
    });
    expect(fileErrorKind(await copyFileNode({ id: 'f', name: 'a', type: 'text/plain', blobId: 'b' }, null).catch((e: unknown) => e)))
      .toBe('overQuota');
  });
});

describe('uploadFileBatch', () => {
  const mockUploadBlob = uploadBlob as ReturnType<typeof vi.fn>;
  const assets = [
    { uri: 'file:///a', name: 'a.txt', mimeType: 'text/plain' },
    { uri: 'file:///b', name: 'b.txt', mimeType: 'text/plain' },
    { uri: 'file:///c', name: 'c.txt', mimeType: 'text/plain' },
  ];

  it('goes on after a file the server refuses and reports it', async () => {
    mockUploadBlob.mockImplementation(async (uri: string) => ({ blobId: `blob-${uri.slice(-1)}`, size: 1, type: 'text/plain' }));
    mockRequest.mockImplementation(async (calls: Array<[string, { create: Record<string, { name: string }> }, string]>) => {
      const props = calls[0][1].create['new-file'];
      if (props.name === 'b.txt') {
        return { methodResponses: [['FileNode/set', { notCreated: { 'new-file': { type: 'forbidden', description: 'You are not allowed to create file nodes in this folder.' } } }, '0']] };
      }
      return { methodResponses: [['FileNode/set', { created: { 'new-file': { id: `n-${props.name}` } } }, '0']] };
    });

    const result = await uploadFileBatch(assets, 'dir-1', []);

    expect(result.uploaded.map((n) => n.name)).toEqual(['a.txt', 'c.txt']);
    expect(result.failed.map((f) => f.name)).toEqual(['b.txt']);
    expect(fileErrorKind(result.failed[0].error)).toBe('forbidden');
  });

  it('stores device names the server would refuse under accepted, unique ones (Stalwart 1.0)', async () => {
    (jmapClient.getAccountCapability as ReturnType<typeof vi.fn>).mockReturnValue({
      maxSizeFileNodeName: 255, forbiddenNameChars: '/<>:"\\|?*', forbiddenNodeNames: ['CON', 'NUL'],
    });
    mockUploadBlob.mockResolvedValue({ blobId: 'blob', size: 1, type: 'text/plain' });
    mockRequest.mockResolvedValue({ methodResponses: [['FileNode/set', { created: { 'new-file': { id: 'n' } } }, '0']] });
    const started: string[] = [];

    await uploadFileBatch(
      [{ uri: 'file:///1', name: 'con.txt' }, { uri: 'file:///2', name: 'Icon\r' }, { uri: 'file:///3', name: 'a:b.txt' }],
      null,
      ['a_b.txt'],
      { onFile: (_i, name) => started.push(name) },
    );

    expect(started).toEqual(['con_.txt', 'Icon_', 'a_b (1).txt']);
    const sent = mockRequest.mock.calls.map(([calls]) => calls[0][1].create['new-file'].name);
    expect(sent).toEqual(started);
  });

  it('stops after the file in flight when cancelled', async () => {
    const controller = new AbortController();
    mockUploadBlob.mockImplementation(async () => {
      controller.abort();
      const err = new Error('Upload cancelled');
      err.name = 'AbortError';
      throw err;
    });
    const result = await uploadFileBatch(assets, null, [], { signal: controller.signal });
    expect(mockUploadBlob).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ uploaded: [], failed: [] });
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
