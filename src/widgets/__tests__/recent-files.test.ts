import { describe, it, expect } from 'vitest';
import type { FileNode } from '../../api/types';
import { isFolder } from '../../api/files';
import * as trash from '../../lib/files-trash';
import { recentFileItems } from '../build';

const dir = (id: string, parentId: string | null, name: string, modified: string): FileNode =>
  ({ id, parentId, name, type: '', blobId: null, modified });
const file = (id: string, parentId: string | null, name: string, modified: string): FileNode =>
  ({ id, parentId, name, type: 'text/plain', blobId: `b-${id}`, size: 1, modified });

describe('recentFileItems', () => {
  it('leaves the Files trash and everything in it out', () => {
    const nodes = [
      dir('docs', null, 'Documents', '2026-10-01T10:00:00Z'),
      file('keep', 'docs', 'keep.txt', '2026-10-02T10:00:00Z'),
      // The trash and a delete's folder are newer than anything else.
      dir('t', null, '.Trash', '2026-10-28T10:00:00Z'),
      dir('b1', 't', '1761700000000~docs', '2026-10-28T10:00:00Z'),
      file('gone', 'b1', 'deleted.txt', '2026-10-27T10:00:00Z'),
    ];
    expect(recentFileItems(nodes, { isFolder }, trash).map((i) => i.id)).toEqual(['keep', 'docs']);
  });
});
