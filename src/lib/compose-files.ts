// Mail and Files meet here: a file from Files attached to a message (#1179)
// and an attachment filed in Files (webmail save-to-files-dialog). Both
// refer to a blob the server already has where they can. Stalwart 0.16.27
// and 1.0.0 take a FileNode's blob as an attachment, and 1.0.0 an
// attachment's blob for a FileNode; across accounts the blob is copied first
// (Blob/copy), as the webmail does. On 0.16 a FileNode made from an
// attachment's blob holds the whole message, so there the attachment is
// downloaded and uploaded again.

import { uploadBytes } from '../api/blob';
import { copyBlobs } from '../api/email';
import {
  copyFileNode, fileNodeKind, fileNodeTakesPartBlobs, filesAccountId, getAllFileNodes, getFileNameRules,
} from '../api/files';
import { jmapClient } from '../api/jmap-client';
import type { FileNode } from '../api/types';
import { acceptedFileName } from './file-name-rules';
import { getUniqueName } from './filenode-name';

/** The Files trash the webmail keeps (lib/files-trash): hidden like any dot folder. */
const TRASH_FOLDER_NAME = '.Trash';

/** Whether a node is one Files hides: a dot file or folder, the trash among them. */
export function isHiddenFileNode(node: Pick<FileNode, 'name'>): boolean {
  return node.name.startsWith('.') || node.name === TRASH_FOLDER_NAME;
}

/**
 * The nodes the pickers offer in `parentId` (null: My files): the user's
 * own, without hidden ones, folders first, then by name. `foldersOnly` for
 * the Save to Files folder picker.
 */
export function pickerEntries(nodes: FileNode[], parentId: string | null, foldersOnly = false): FileNode[] {
  return nodes
    .filter((n) => !n.isShared && !n.discoverableOnly && !isHiddenFileNode(n))
    .filter((n) => (n.parentId ?? null) === parentId)
    .filter((n) => {
      const kind = fileNodeKind(n);
      return foldersOnly ? kind === 'directory' : kind === 'directory' || kind === 'file';
    })
    .sort((a, b) => {
      const af = fileNodeKind(a) === 'directory' ? 0 : 1;
      const bf = fileNodeKind(b) === 'directory' ? 0 : 1;
      return af - bf || a.name.localeCompare(b.name);
    });
}

/** The folders from My files down to `folderId`, for the picker's path. */
export function folderPath(nodes: FileNode[], folderId: string | null): FileNode[] {
  const path: FileNode[] = [];
  const seen = new Set<string>();
  let id = folderId;
  while (id && !seen.has(id)) {
    seen.add(id);
    const node = nodes.find((n) => n.id === id);
    if (!node) break;
    path.unshift(node);
    id = node.parentId ?? null;
  }
  return path;
}

/**
 * A file from Files as an attachment of a message in `mailAccountId`
 * (undefined: the login's own): its blob, copied into that account when
 * Files lives in another.
 */
export async function attachmentFromFileNode(
  node: FileNode,
  mailAccountId?: string,
): Promise<{ blobId: string; name: string; type: string; size: number }> {
  if (!node.blobId || fileNodeKind(node) !== 'file') throw new Error('Only files can be attached');
  const from = node.accountId ?? filesAccountId();
  const to = mailAccountId ?? jmapClient.accountId;
  const blobId = (await copyBlobs(from, [node.blobId], to))[node.blobId];
  return { blobId, name: node.name, type: node.type || 'application/octet-stream', size: node.size ?? 0 };
}

/**
 * File an attachment in the user's Files, in `parentId` (null: My files).
 * `blobAccountId` is the account the message is in when it is not the
 * login's own: a shared or group mailbox's blob is copied into the Files
 * account first. On Stalwart 0.16 the attachment's bytes are uploaded into
 * the Files account instead (see fileNodeTakesPartBlobs). A name the folder
 * has already gets a number.
 */
export async function saveAttachmentToFiles(
  attachment: { blobId: string; name?: string | null; type?: string | null },
  parentId: string | null,
  blobAccountId?: string,
): Promise<FileNode> {
  const from = blobAccountId ?? jmapClient.accountId;
  const to = filesAccountId();
  const type = attachment.type || 'application/octet-stream';
  // A name the folder holds already is refused (alreadyExists): the copy
  // gets " (1)", " (2)", ... as an upload does.
  const taken = new Set(
    (await getAllFileNodes())
      .filter((n) => !n.isShared && (n.parentId ?? null) === parentId)
      .map((n) => n.name),
  );
  const name = getUniqueName(acceptedFileName(attachment.name || 'attachment', getFileNameRules()), taken);
  let blobId: string;
  if (fileNodeTakesPartBlobs(to)) {
    blobId = (await copyBlobs(from, [attachment.blobId], to))[attachment.blobId];
  } else {
    const bytes = await jmapClient.fetchBlobArrayBuffer(attachment.blobId, name, type, from);
    blobId = (await uploadBytes(new Uint8Array(bytes), type, to)).blobId;
  }
  const node: FileNode = { id: '', name, type, blobId, nodeType: 'file' };
  return copyFileNode(node, parentId, name);
}
