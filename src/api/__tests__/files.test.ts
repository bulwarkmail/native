import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    hasCapability: vi.fn(),
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
  createFolder,
  deleteFileNodes,
  getAllFileNodesAcrossAccounts,
  getFileNodeDownloadUrl,
  getPrincipals,
  isCrossAccountId,
  isFolder,
  setFileNodeShare,
} from '../files';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;
const mockHasCapability = jmapClient.hasCapability as ReturnType<typeof vi.fn>;

function setSession(session: unknown) {
  (jmapClient as { currentSession: unknown }).currentSession = session;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockHasCapability.mockImplementation(
    (urn: string) => urn === CAPABILITIES.FILES || urn === CAPABILITIES.PRINCIPALS,
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
