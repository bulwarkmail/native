import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { FileNode } from './types';

const USING = [CAPABILITIES.CORE, CAPABILITIES.MAIL];

export async function getFileNodes(parentId?: string | null): Promise<FileNode[]> {
  const accountId = jmapClient.accountId;
  const filter: Record<string, unknown> = {};
  if (parentId !== undefined) filter.parentId = parentId;

  const res = await jmapClient.request(
    [['FileNode/get', { accountId, filter }, '0']],
    USING,
  );
  return res.methodResponses[0][1].list;
}

export async function createFileNode(
  fileNode: Partial<FileNode>,
): Promise<FileNode> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['FileNode/set', {
      accountId,
      create: { 'new-file': fileNode },
    }, '0']],
    USING,
  );
  return res.methodResponses[0][1].created['new-file'];
}

export async function deleteFileNodes(ids: string[]): Promise<void> {
  const accountId = jmapClient.accountId;
  await jmapClient.request(
    [['FileNode/set', { accountId, destroy: ids }, '0']],
    USING,
  );
}
