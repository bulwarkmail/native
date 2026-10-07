import { beforeEach, describe, expect, it } from 'vitest';
import type { FileNode } from '../../api/types';
import { resolveFilesOpen, setPendingFilesOpen, usePendingFilesOpen } from '../pending-files-open';

function node(id: string, name: string, parentId: string | null, folder: boolean, extra: Partial<FileNode> = {}): FileNode {
  return { id, name, parentId, blobId: folder ? null : `blob-${id}`, type: folder ? 'folder' : 'text/plain', ...extra } as FileNode;
}

const nodes: FileNode[] = [
  node('d1', 'Docs', null, true),
  node('d2', 'Work', 'd1', true),
  node('f1', 'a.txt', 'd2', false),
  node('f2', 'top.txt', null, false),
  // A shared subtree: its root's parent isn't visible to us.
  node('own:s1', 'Shared', 'own:hidden', true, { isShared: true, accountId: 'own' }),
  node('own:s2', 'b.txt', 'own:s1', false, { isShared: true, accountId: 'own' }),
];

describe('resolveFilesOpen', () => {
  it("opens a file's folder stack and previews the file", () => {
    expect(resolveFilesOpen(nodes, { appAccountId: 'a', nodeId: 'f1', folderPath: '/Docs/Work', fileName: 'a.txt' })).toEqual({
      path: [{ id: 'd1', name: 'Docs' }, { id: 'd2', name: 'Work' }],
      file: nodes[2],
    });
  });

  it('opens a folder itself', () => {
    expect(resolveFilesOpen(nodes, { appAccountId: 'a', nodeId: 'd2', folderPath: '/Docs', fileName: null })).toEqual({
      path: [{ id: 'd1', name: 'Docs' }, { id: 'd2', name: 'Work' }],
      file: null,
    });
  });

  it('opens a root file at the root', () => {
    expect(resolveFilesOpen(nodes, { appAccountId: 'a', nodeId: 'f2', folderPath: '/', fileName: 'top.txt' }))
      .toEqual({ path: [], file: nodes[3] });
  });

  it('starts a shared file at its shared root', () => {
    expect(resolveFilesOpen(nodes, { appAccountId: 'a', nodeId: 'own:s2', folderPath: '/Shared', fileName: 'b.txt' }))
      .toEqual({ path: [{ id: 'own:s1', name: 'Shared' }], file: nodes[5] });
  });

  it('finds nothing for a node the listing no longer has', () => {
    expect(resolveFilesOpen(nodes, { appAccountId: 'a', nodeId: 'gone', folderPath: '/', fileName: 'x' })).toBeNull();
  });

  it('stops on a parent cycle', () => {
    const loop = [node('x', 'X', 'y', true), node('y', 'Y', 'x', true)];
    expect(resolveFilesOpen(loop, { appAccountId: 'a', nodeId: 'x', folderPath: '/', fileName: null })?.path.length).toBeLessThanOrEqual(2);
  });
});

describe('pending files open', () => {
  beforeEach(() => usePendingFilesOpen.setState({ target: null }));

  it('is consumed once', () => {
    setPendingFilesOpen({ appAccountId: 'a', nodeId: 'f1', folderPath: '/', fileName: 'a.txt' });
    expect(usePendingFilesOpen.getState().consume()?.nodeId).toBe('f1');
    expect(usePendingFilesOpen.getState().consume()).toBeNull();
  });
});
