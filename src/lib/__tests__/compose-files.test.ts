import { describe, it, expect, vi, beforeEach } from 'vitest';

const { files, email } = vi.hoisted(() => ({
  files: {
    filesAccountId: vi.fn(() => 'me'),
    copyFileNode: vi.fn(async (node: { blobId: string }, parentId: string | null, name: string) => ({
      id: 'new-node', name, parentId, blobId: node.blobId, type: 'application/pdf',
    })),
    fileNodeKind: vi.fn((node: { nodeType?: string; blobId?: string | null }) =>
      node.nodeType ?? (node.blobId == null ? 'directory' : 'file')),
  },
  email: {
    // As the real one: the ids as they are within one account.
    copyBlobs: vi.fn(async (from: string, ids: string[], to: string) =>
      Object.fromEntries(ids.map((id) => [id, from === to ? id : `copy-of-${id}`]))),
  },
}));
vi.mock('../../api/files', () => files);
vi.mock('../../api/email', () => email);
vi.mock('../../api/jmap-client', () => ({ jmapClient: { accountId: 'me' } }));

import type { FileNode } from '../../api/types';
import {
  attachmentFromFileNode, folderPath, pickerEntries, saveAttachmentToFiles,
} from '../compose-files';

const node = (id: string, name: string, parentId: string | null, blobId?: string, extra: Partial<FileNode> = {}): FileNode =>
  ({ id, name, parentId, blobId: blobId ?? null, type: blobId ? 'application/pdf' : '', ...extra });

const NODES = [
  node('d1', 'Projects', null),
  node('f1', 'b-report.pdf', null, 'blob-1', { size: 10 }),
  node('f0', 'a-notes.pdf', null, 'blob-0'),
  node('trash', '.Trash', null),
  node('hidden', '.cache', null, 'blob-h'),
  node('f2', 'plan.pdf', 'd1', 'blob-2'),
  node('d2', 'Archive', 'd1'),
  node('s1', 'theirs.pdf', null, 'blob-s', { isShared: true, accountId: 'team' }),
];

beforeEach(() => vi.clearAllMocks());

describe('the Files pickers', () => {
  it('lists folders first, then files by name, without hidden and shared nodes', () => {
    expect(pickerEntries(NODES, null).map((n) => n.id)).toEqual(['d1', 'f0', 'f1']);
    expect(pickerEntries(NODES, 'd1').map((n) => n.id)).toEqual(['d2', 'f2']);
  });

  it('lists only folders to save into', () => {
    expect(pickerEntries(NODES, null, true).map((n) => n.id)).toEqual(['d1']);
  });

  it('names the path down to a folder', () => {
    expect(folderPath(NODES, 'd2').map((n) => n.name)).toEqual(['Projects', 'Archive']);
    expect(folderPath(NODES, null)).toEqual([]);
  });
});

describe('Attach from Files (#1179)', () => {
  it("attaches the file's blob as it is when Files and the message share the account", async () => {
    await expect(attachmentFromFileNode(NODES[1])).resolves.toEqual({
      blobId: 'blob-1', name: 'b-report.pdf', type: 'application/pdf', size: 10,
    });
    expect(email.copyBlobs).toHaveBeenCalledWith('me', ['blob-1'], 'me');
  });

  it('copies the blob into the account of a message sent from elsewhere', async () => {
    const part = await attachmentFromFileNode(NODES[1], 'team');
    expect(email.copyBlobs).toHaveBeenCalledWith('me', ['blob-1'], 'team');
    expect(part.blobId).toBe('copy-of-blob-1');
  });

  it('refuses a folder', async () => {
    await expect(attachmentFromFileNode(NODES[0])).rejects.toThrow();
  });
});

describe('Save to Files', () => {
  it('files an own attachment by its blob, in the folder picked', async () => {
    const saved = await saveAttachmentToFiles({ blobId: 'att-1', name: 'invoice.pdf', type: 'application/pdf' }, 'd1');
    expect(email.copyBlobs).toHaveBeenCalledWith('me', ['att-1'], 'me');
    expect(files.copyFileNode).toHaveBeenCalledWith(
      expect.objectContaining({ blobId: 'att-1', nodeType: 'file' }), 'd1', 'invoice.pdf',
    );
    expect(saved.id).toBe('new-node');
  });

  it("copies a group mailbox's attachment into the Files account first", async () => {
    await saveAttachmentToFiles({ blobId: 'att-1', name: 'invoice.pdf', type: 'application/pdf' }, null, 'team');
    expect(email.copyBlobs).toHaveBeenCalledWith('team', ['att-1'], 'me');
    expect(files.copyFileNode).toHaveBeenCalledWith(
      expect.objectContaining({ blobId: 'copy-of-att-1' }), null, 'invoice.pdf',
    );
  });
});
