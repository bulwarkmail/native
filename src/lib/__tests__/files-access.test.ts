import { describe, it, expect } from 'vitest';
import type { FileNode, FileNodeRights } from '../../api/types';
import { fileNodeAccess, mayCreateIn } from '../files-access';

// What the Files screen offers inside folders other accounts shared with the
// user. It used to offer no write there at all, since every write went to
// the user's own account.

const NONE: FileNodeRights = {
  mayRead: true, mayAddChildren: false, mayRename: false, mayDelete: false, mayModifyContent: false, mayShare: false,
};
const WRITE: FileNodeRights = { ...NONE, mayAddChildren: true, mayRename: true, mayDelete: true, mayModifyContent: true };

const node = (id: string, parentId: string | null, extra: Partial<FileNode> = {}): FileNode =>
  ({ id, parentId, name: id, type: '', ...extra });

const own = [node('d1', null, { blobId: null }), node('f1', 'd1', { blobId: 'b1' })];
const shared = (rootRights: FileNodeRights, childRights: FileNodeRights) => [
  // Stalwart 1.0's placeholder above the shared folder.
  node('acc-2:top', null, { blobId: null, isShared: true, discoverableOnly: true, myRights: { ...NONE, mayRead: false } }),
  node('acc-2:s1', 'acc-2:top', { blobId: null, isShared: true, myRights: rootRights }),
  node('acc-2:f2', 'acc-2:s1', { blobId: 'b2', isShared: true, myRights: childRights }),
];

describe('fileNodeAccess', () => {
  it('lets the user do everything with their own nodes', () => {
    expect(fileNodeAccess(own[1], own)).toEqual({ rename: true, delete: true, move: true, duplicate: true });
  });

  it('follows the rights inside a folder shared with write access', () => {
    const nodes = [...own, ...shared(WRITE, WRITE)];
    expect(fileNodeAccess(nodes.at(-1)!, nodes)).toEqual({ rename: true, delete: true, move: false, duplicate: true });
  });

  it('takes the folder\'s rights for a file that names none (Stalwart 1.0)', () => {
    const writable = shared(WRITE, WRITE);
    const nodes = [...writable.slice(0, 2), { ...writable[2], myRights: undefined }];
    expect(fileNodeAccess(nodes.at(-1)!, nodes)).toEqual({ rename: true, delete: true, move: false, duplicate: true });
    const readOnly = shared(NONE, NONE);
    const ro = [...readOnly.slice(0, 2), { ...readOnly[2], myRights: undefined }];
    expect(fileNodeAccess(ro.at(-1)!, ro)).toEqual({ rename: false, delete: false, move: false, duplicate: false });
  });

  it('offers nothing inside a folder shared read-only', () => {
    const nodes = shared(NONE, NONE);
    expect(fileNodeAccess(nodes.at(-1)!, nodes)).toEqual({ rename: false, delete: false, move: false, duplicate: false });
  });

  it('never renames or deletes the shared root, even with the rights', () => {
    const nodes = shared(WRITE, WRITE);
    expect(fileNodeAccess(nodes[1], nodes)).toEqual({ rename: false, delete: false, move: false, duplicate: false });
  });
});

describe('mayCreateIn', () => {
  it('creates in the own drive and its folders', () => {
    expect(mayCreateIn(null, own)).toBe(true);
    expect(mayCreateIn('d1', own)).toBe(true);
  });

  it('creates in a shared folder only with mayAddChildren', () => {
    expect(mayCreateIn('acc-2:s1', shared(WRITE, NONE))).toBe(true);
    expect(mayCreateIn('acc-2:s1', shared(NONE, NONE))).toBe(false);
    // A placeholder folder is never a place to write.
    expect(mayCreateIn('acc-2:top', shared(WRITE, NONE))).toBe(false);
    expect(mayCreateIn('gone', own)).toBe(false);
  });
});
