import { describe, it, expect } from 'vitest';
import type { FileNode } from '../../api/types';
import {
  findTrashFolder, parseTrashBatchName, restoreTarget, takesTrashName, trashBatchName, trashOriginPath,
  trashPlaces, trashSubtreeIds, trashedItems, withoutTrash,
} from '../files-trash';

// The webmail's trash convention (its lib/files-trash.ts), read the same way here.

const dir = (id: string, parentId: string | null, name = id, extra: Partial<FileNode> = {}): FileNode =>
  ({ id, parentId, name, type: '', blobId: null, ...extra });
const file = (id: string, parentId: string | null, name = id, extra: Partial<FileNode> = {}): FileNode =>
  ({ id, parentId, name, type: 'text/plain', blobId: `b-${id}`, size: 1, ...extra });

const drive: FileNode[] = [
  dir('docs', null, 'Documents'),
  dir('tax', 'docs', 'Taxes'),
  file('keep', 'docs', 'keep.txt'),
  dir('t', null, '.Trash'),
  dir('b1', 't', '1730112000000~tax'),
  file('r1', 'b1', 'report.pdf'),
  dir('old', 'b1', 'Old stuff'),
  file('deep', 'old', 'deep.txt'),
  dir('b2', 't', '1730115600000~'),
  file('r2', 'b2', 'notes.txt'),
  // Put into the trash by hand (WebDAV), not by a delete.
  file('loose', 't', 'loose.txt'),
  // A shared account's own trash is not the user's.
  dir('acc-2:t', null, '.Trash', { isShared: true, accountId: 'acc-2' }),
];

describe('trash batch names', () => {
  it('names a delete after its time and folder, the root as empty', () => {
    expect(trashBatchName('tax', 1730112000000)).toBe('1730112000000~tax');
    expect(trashBatchName(null, 1730112000000)).toBe('1730112000000~');
  });

  it('reads both back, and nothing else', () => {
    expect(parseTrashBatchName('1730112000000~tax')).toEqual({ deletedAt: 1730112000000, parentId: 'tax' });
    expect(parseTrashBatchName('1730112000000~')).toEqual({ deletedAt: 1730112000000, parentId: null });
    expect(parseTrashBatchName('Holiday photos')).toBeNull();
    expect(parseTrashBatchName('12~tax')).toBeNull();
    expect(parseTrashBatchName('1730112000000~acc-2:x')).toBeNull();
  });
});

describe('findTrashFolder', () => {
  it('finds the own drive\'s .Trash folder at the root only', () => {
    expect(findTrashFolder(drive)?.id).toBe('t');
    expect(findTrashFolder([dir('x', 'docs', '.Trash')])).toBeUndefined();
    expect(findTrashFolder([file('x', null, '.Trash')])).toBeUndefined();
    expect(findTrashFolder([dir('acc-2:t', null, '.Trash', { isShared: true })])).toBeUndefined();
  });
});

describe('trashedItems', () => {
  it('lists each deleted item once, with when and where it came from', () => {
    const items = trashedItems(drive);
    expect(items.map((i) => [i.node.id, i.batchId, i.deletedAt, i.fromParentId])).toEqual([
      ['r1', 'b1', 1730112000000, 'tax'],
      ['old', 'b1', 1730112000000, 'tax'],
      ['r2', 'b2', 1730115600000, null],
      ['loose', null, null, null],
    ]);
  });

  it('is empty without a trash folder', () => {
    expect(trashedItems(drive.filter((n) => n.id !== 't'))).toEqual([]);
  });
});

describe('withoutTrash', () => {
  it('leaves the trash and everything in it out', () => {
    expect([...trashSubtreeIds(drive, 't')].sort()).toEqual(['b1', 'b2', 'deep', 'loose', 'old', 'r1', 'r2', 't']);
    expect(withoutTrash(drive).map((n) => n.id)).toEqual(['docs', 'tax', 'keep', 'acc-2:t']);
  });
});

describe('takesTrashName', () => {
  it('refuses .Trash at the root of the own drive only', () => {
    expect(takesTrashName('.Trash', null)).toBe(true);
    expect(takesTrashName('.Trash', null, 'docs')).toBe(true);
    expect(takesTrashName('.Trash', 'docs')).toBe(false);
    expect(takesTrashName('.trash', null)).toBe(false);
    expect(takesTrashName('.Trash (1)', null)).toBe(false);
    // A node of a shared drive stays there.
    expect(takesTrashName('.Trash', null, 'acc-2:x')).toBe(false);
  });
});

describe('restoreTarget', () => {
  it('puts an item back into its folder while that is still there', () => {
    expect(restoreTarget({ fromParentId: 'tax' }, drive)).toBe('tax');
    expect(restoreTarget({ fromParentId: null }, drive)).toBeNull();
  });

  it('falls back to the root for a folder that is gone, in the trash or not a folder', () => {
    expect(restoreTarget({ fromParentId: 'missing' }, drive)).toBeNull();
    expect(restoreTarget({ fromParentId: 'old' }, drive)).toBeNull();
    expect(restoreTarget({ fromParentId: 'keep' }, drive)).toBeNull();
  });
});

describe('trashOriginPath', () => {
  it('names the folder an item came from by its path', () => {
    expect(trashOriginPath({ fromParentId: 'tax' }, drive)).toBe('/Documents/Taxes');
    expect(trashOriginPath({ fromParentId: null }, drive)).toBe('/');
    expect(trashOriginPath({ fromParentId: 'old' }, drive)).toBeNull();
  });

  it('reads the listing once for all the rows of the trash, not once per row', () => {
    // A listing that counts how often it is gone through.
    let reads = 0;
    const counted = new Proxy([...drive], {
      get(target, key, receiver) {
        if (key === Symbol.iterator || key === 'find' || key === 'filter' || key === 'map' || key === 'some') reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    const places = trashPlaces(counted);
    const before = reads;
    const rows = trashedItems(drive);
    const paths = rows.map((item) => trashOriginPath(item, places));
    expect(paths).toEqual(['/Documents/Taxes', '/Documents/Taxes', '/', '/']);
    expect(reads).toBe(before);
    expect(rows.map((item) => restoreTarget(item, places))).toEqual(['tax', 'tax', null, null]);
    expect(reads).toBe(before);
  });
});
