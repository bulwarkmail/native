/**
 * Live check of the Files API against a real Stalwart server.
 *
 * Opt-in like live-stalwart.test.ts: skipped unless `BULWARK_LIVE_JMAP`
 * and `BULWARK_LIVE_PASS` are set.
 *
 *   BULWARK_LIVE_JMAP=http://10.10.10.62:8120 \
 *   BULWARK_LIVE_USER=e2e-phone-dark@example.org \
 *   BULWARK_LIVE_PASS=… npx vitest run src/api/__tests__/live-stalwart-files.test.ts
 *
 * Everything it makes lives in one scratch folder that is deleted afterwards.
 *
 * Verified against stalwartlabs/stalwart:v0.16.27 and v1.0.0.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

// The app uploads picked files from a device URI; here the "URI" names bytes
// held in memory, which go up through the same upload endpoint.
const pickedFiles = new Map<string, Uint8Array>();
vi.mock('../blob', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../blob')>();
  return {
    ...actual,
    uploadBlob: (uri: string, type: string) => {
      const bytes = pickedFiles.get(uri);
      if (!bytes) throw new Error(`no bytes for ${uri}`);
      return actual.uploadBytes(bytes, type);
    },
  };
});

import { JMAPClient } from '../jmap-client';
import { CAPABILITIES } from '../types';
import type { FileNode } from '../types';
import {
  copyFileNode,
  createFolder,
  deleteFileNodes,
  destroyEmptyFolders,
  fileNodeKind,
  filesAccountId,
  getAllFileNodes,
  getAllFileNodesAcrossAccounts,
  getFileNodeDownloadUrl,
  listFolder,
  moveFileNode,
  renameFileNode,
  uploadFileBatch,
} from '../files';
import { emptyTrash, moveToTrash, purgeFromTrash, restoreFromTrash } from '../files-trash';
import { findTrashFolder, parseTrashBatchName, trashedItems, withoutTrash } from '../../lib/files-trash';

const SERVER = process.env.BULWARK_LIVE_JMAP;
const USER = process.env.BULWARK_LIVE_USER ?? 'usera@example.org';
const PASS = process.env.BULWARK_LIVE_PASS ?? '';
const live = SERVER && PASS ? describe : describe.skip;

let client: JMAPClient;

async function connectSingleton(): Promise<void> {
  const mod = await import('../jmap-client');
  client = new JMAPClient();
  await client.connect(SERVER!, USER, PASS);
  (mod.jmapClient as unknown as JMAPClient).restoreSnapshot(client.snapshot());
}

function pick(name: string, text: string) {
  const uri = `mem://${name}-${pickedFiles.size}`;
  pickedFiles.set(uri, new TextEncoder().encode(text));
  return { uri, name, mimeType: 'text/plain' };
}

async function nodes(): Promise<FileNode[]> {
  return getAllFileNodesAcrossAccounts();
}

/** Stalwart 1.0 (File Storage draft 18) names the kind `@type`; it lists `supportedNodeTypes`. */
function draft18(): boolean {
  const cap = client.getAccountCapability(CAPABILITIES.FILES, filesAccountId()) as Record<string, unknown> | undefined;
  return !!cap && 'supportedNodeTypes' in cap;
}

live('live Stalwart files', () => {
  let scratch = '';

  beforeAll(async () => {
    await connectSingleton();
    scratch = (await createFolder(`live-files-${Date.now().toString(36)}`, null)).id;
  }, 60_000);

  afterAll(async () => {
    if (!scratch) return;
    await deleteFileNodes([scratch]).catch(() => undefined);
    // Asked by id, so a failed listing can't pass for a clean account.
    const res = await client.request([['FileNode/get', {
      accountId: filesAccountId(), ids: [scratch], properties: ['id'],
    }, '0']], [CAPABILITIES.CORE, CAPABILITIES.FILES]);
    expect(res.methodResponses[0][1].notFound).toEqual([scratch]);
  }, 120_000);

  it('creates a folder, lists it as a folder and lists what it holds', async () => {
    const sub = await createFolder('Sub folder', scratch);
    const all = await nodes();
    const listed = all.find((n) => n.id === sub.id);
    expect(listed?.name).toBe('Sub folder');
    expect(listed?.parentId).toBe(scratch);
    expect(fileNodeKind(listed!)).toBe('directory');
    expect(listFolder(all, scratch).map((n) => n.id)).toContain(sub.id);
  }, 60_000);

  it('uploads files, lists them as files with their media type and downloads the bytes', async () => {
    const { uploaded, failed } = await uploadFileBatch(
      [pick('notes.txt', 'hello from the live test'), pick('con.txt', 'reserved stem')],
      scratch,
      [],
    );
    expect(failed).toEqual([]);
    expect(uploaded).toHaveLength(2);

    const all = await nodes();
    const notes = all.find((n) => n.id === uploaded[0].id)!;
    expect(notes.name).toBe('notes.txt');
    expect(fileNodeKind(notes)).toBe('file');
    expect(notes.type).toBe('text/plain');
    expect(notes.size).toBe(24);

    const res = await fetch(getFileNodeDownloadUrl(notes), { headers: { Authorization: client.authHeader } });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello from the live test');
  }, 60_000);

  it('renames, moves, copies and deletes', async () => {
    const box = await createFolder('Box', scratch);
    const { uploaded } = await uploadFileBatch([pick('a.txt', 'abc')], scratch, []);
    const file = uploaded[0];

    await renameFileNode(file.id, 'b.txt');
    await moveFileNode(file.id, box.id);
    let all = await nodes();
    expect(all.find((n) => n.id === file.id)).toMatchObject({ name: 'b.txt', parentId: box.id });

    // A folder moves too, and back.
    const inner = await createFolder('Inner', scratch);
    await moveFileNode(inner.id, box.id);
    await renameFileNode(inner.id, 'Inner renamed');
    all = await nodes();
    expect(all.find((n) => n.id === inner.id)).toMatchObject({ name: 'Inner renamed', parentId: box.id });

    const listed = all.find((n) => n.id === file.id)!;
    const copy = await copyFileNode(listed, scratch, 'b (copy).txt');
    all = await nodes();
    const copied = all.find((n) => n.id === copy.id)!;
    expect(copied).toMatchObject({ name: 'b (copy).txt', parentId: scratch, size: 3, type: 'text/plain' });
    expect(fileNodeKind(copied)).toBe('file');

    await deleteFileNodes([copy.id, box.id]);
    all = await nodes();
    // The folder's children went with it.
    expect(all.filter((n) => [copy.id, box.id, file.id, inner.id].includes(n.id))).toEqual([]);
  }, 90_000);

  it('moves a node to the drive root and back', async () => {
    const { uploaded } = await uploadFileBatch([pick('root-trip.txt', 'x')], scratch, []);
    const id = uploaded[0].id;
    try {
      await moveFileNode(id, null);
      expect((await nodes()).find((n) => n.id === id)?.parentId ?? null).toBeNull();
    } finally {
      await moveFileNode(id, scratch);
    }
    expect((await nodes()).find((n) => n.id === id)?.parentId).toBe(scratch);
  }, 60_000);

  it('cannot create a symbolic link over JMAP on Stalwart 1.0', async () => {
    if (!draft18()) return;
    // Stalwart 1.0 lists SymLink among its node types but refuses every
    // `target`, so the app offers no way to make one.
    const res = await client.request([['FileNode/set', {
      accountId: filesAccountId(),
      create: { l: { '@type': 'SymLink', name: 'link', parentId: scratch, target: 'Sub folder' } },
    }, '0']], [CAPABILITIES.CORE, CAPABILITIES.FILES]);
    const [, result] = res.methodResponses[0] as unknown as [string, { created?: Record<string, unknown>; notCreated?: Record<string, { properties?: string[] }> }];
    expect(result.created?.l).toBeUndefined();
    expect(result.notCreated?.l?.properties).toEqual(['target']);
  }, 30_000);

  // #1385: past maxObjectsInGet, 0.16 cuts the return-all /get short and 1.0
  // refuses it with requestTooLarge.
  it('lists an account holding more nodes than one FileNode/get returns', async () => {
    const max = client.getMaxObjectsInGet();
    const perSet = client.getMaxObjectsInSet();
    const bulk = await createFolder('bulk', scratch);
    const count = max + 5;
    const made: string[] = [];
    for (let start = 0; start < count; start += perSet) {
      const create: Record<string, Record<string, unknown>> = {};
      for (let i = start; i < Math.min(count, start + perSet); i++) {
        create[`n${i}`] = { name: `n${i}`, parentId: bulk.id, ...(draft18() ? { '@type': 'Directory' } : {}) };
      }
      const res = await client.request([['FileNode/set', { accountId: filesAccountId(), create }, '0']],
        [CAPABILITIES.CORE, CAPABILITIES.FILES]);
      const [, result] = res.methodResponses[0] as unknown as [string, { created?: Record<string, { id: string }> }];
      made.push(...Object.values(result.created ?? {}).map((c) => c.id));
    }
    expect(made).toHaveLength(count);

    const all = await nodes();
    const ids = new Set(all.map((n) => n.id));
    expect(made.filter((id) => !ids.has(id))).toEqual([]);
    expect(ids.has(scratch)).toBe(true);

    await deleteFileNodes([bulk.id]);
  }, 180_000);
});

// Dumps the drive for a check with the webmail's own code (BULWARK_LIVE_PROBE_DIR).
async function writeProbe(name: string, list: FileNode[]): Promise<void> {
  const dir = process.env.BULWARK_LIVE_PROBE_DIR;
  if (!dir) return;
  const { writeFile } = await import('node:fs/promises');
  await writeFile(`${dir}/${name}-${SERVER!.replace(/\D/g, '').slice(-4)}.json`, JSON.stringify(list));
}

// The trash is the webmail's convention (lib/files-trash): /.Trash/<ms>~<parentId>/<item>.
live('live Stalwart files trash', () => {
  let scratch = '';
  // An account's own trash is left alone: only what these tests put there goes.
  let trashBefore: string | undefined;
  const batches = new Set<string>();

  const own = () => getAllFileNodes();
  const upload = async (name: string, parentId: string, text = name) =>
    (await uploadFileBatch([pick(name, text)], parentId, [])).uploaded[0];
  const trashed = async (id: string) => trashedItems(await own()).find((i) => i.node.id === id);

  beforeAll(async () => {
    await connectSingleton();
    trashBefore = findTrashFolder(await own())?.id;
    scratch = (await createFolder(`live-trash-${Date.now().toString(36)}`, null)).id;
  }, 60_000);

  afterAll(async () => {
    const before = await own();
    const trash = findTrashFolder(before);
    const leftovers = [scratch, ...[...batches].filter((id) => before.some((n) => n.id === id))];
    if (trash && !trashBefore) leftovers.push(trash.id);
    await deleteFileNodes(leftovers.filter(Boolean)).catch(() => undefined);
    const after = await own();
    expect(after.filter((n) => leftovers.includes(n.id))).toEqual([]);
    if (!trashBefore) expect(findTrashFolder(after)).toBeUndefined();
  }, 120_000);

  it('moves a file and a folder into one trash folder that names when and where from, and hides them', async () => {
    const file = await upload('trash-me.txt', scratch);
    const folder = await createFolder('Trash me', scratch);
    const inner = await upload('inner.txt', folder.id);
    let list = await own();
    const before = Date.now();
    const { done, refused } = await moveToTrash(list, [
      list.find((n) => n.id === file.id)!,
      list.find((n) => n.id === folder.id)!,
    ]);
    expect(refused).toEqual([]);
    expect(done.map((i) => i.node.id).sort()).toEqual([file.id, folder.id].sort());

    list = await own();
    const trash = findTrashFolder(list)!;
    expect(trash).toBeDefined();
    expect(trash.parentId ?? null).toBeNull();
    expect(trash.name).toBe('.Trash');
    const batch = list.find((n) => n.id === done[0].batchId)!;
    batches.add(batch.id);
    expect(batch.parentId).toBe(trash.id);
    expect(fileNodeKind(batch)).toBe('directory');
    // What the webmail reads back to restore: the time and the folder.
    expect(batch.name).toMatch(/^(\d{10,})~([A-Za-z0-9_-]*)$/);
    expect(parseTrashBatchName(batch.name)?.parentId).toBe(scratch);
    expect(parseTrashBatchName(batch.name)!.deletedAt).toBeGreaterThanOrEqual(before - 1000);
    expect(list.find((n) => n.id === file.id)?.parentId).toBe(batch.id);
    // The folder went whole.
    expect(list.find((n) => n.id === inner.id)?.parentId).toBe(folder.id);

    const items = trashedItems(list).filter((i) => i.batchId === batch.id);
    expect(items.map((i) => i.node.name).sort()).toEqual(['Trash me', 'trash-me.txt']);
    expect(items.every((i) => i.fromParentId === scratch)).toBe(true);

    // Out of every normal listing, the root included.
    const shown = withoutTrash(await nodes());
    expect(shown.some((n) => [trash.id, batch.id, file.id, folder.id, inner.id].includes(n.id))).toBe(false);
    expect(listFolder(shown, null).some((n) => n.id === trash.id)).toBe(false);
    expect(listFolder(shown, scratch).map((n) => n.id)).toEqual([]);

    await writeProbe('trash-after-delete', list);
  }, 90_000);

  it('restores items to the folder they came from and removes their empty trash folder', async () => {
    const all = trashedItems(await own());
    const item = all.find((i) => i.node.name === 'trash-me.txt' && i.fromParentId === scratch)!;
    const sibling = all.find((i) => i.node.name === 'Trash me' && i.batchId === item.batchId)!;
    let list = await own();
    const { done } = await restoreFromTrash(list, [item]);
    expect(done).toHaveLength(1);
    list = await own();
    expect(list.find((n) => n.id === item.node.id)).toMatchObject({ name: 'trash-me.txt', parentId: scratch });
    // The other item still holds the trash folder.
    expect(list.some((n) => n.id === item.batchId)).toBe(true);

    await restoreFromTrash(list, [sibling]);
    list = await own();
    expect(list.find((n) => n.id === sibling.node.id)?.parentId).toBe(scratch);
    expect(list.some((n) => n.id === item.batchId)).toBe(false);
    expect(await trashed(item.node.id)).toBeUndefined();
  }, 90_000);

  it('restores under a free name when the old one is taken, and to the root when the folder is gone', async () => {
    const sub = await createFolder('Gone soon', scratch);
    const a = await upload('clash.txt', scratch, 'old');
    const b = await upload('orphan.txt', sub.id);
    let list = await own();
    const first = await moveToTrash(list, [list.find((n) => n.id === a.id)!]);
    const second = await moveToTrash(list, [list.find((n) => n.id === b.id)!]);
    for (const i of [...first.done, ...second.done]) batches.add(i.batchId!);
    await upload('clash.txt', scratch, 'new');
    await deleteFileNodes([sub.id]);

    list = await own();
    await restoreFromTrash(list, [(await trashed(a.id))!, (await trashed(b.id))!]);
    list = await own();
    expect(list.find((n) => n.id === a.id)).toMatchObject({ name: 'clash (1).txt', parentId: scratch });
    const orphan = list.find((n) => n.id === b.id)!;
    try {
      expect(orphan.name).toBe('orphan.txt');
      expect(orphan.parentId ?? null).toBeNull();
    } finally {
      await deleteFileNodes([b.id]);
    }
  }, 120_000);

  it('undoes a delete with the listing from before it', async () => {
    const file = await upload('undo-me.txt', scratch);
    const list = await own();
    const { done } = await moveToTrash(list, [list.find((n) => n.id === file.id)!]);
    batches.add(done[0].batchId!);
    // The rows on screen still show it where it was.
    await restoreFromTrash(list, done);
    const after = await own();
    expect(after.find((n) => n.id === file.id)).toMatchObject({ name: 'undo-me.txt', parentId: scratch });
    expect(after.some((n) => n.id === done[0].batchId)).toBe(false);
  }, 90_000);

  it('deletes items of the trash for good, and leaves a trash folder that still holds anything', async () => {
    const x = await upload('purge-x.txt', scratch);
    const y = await upload('purge-y.txt', scratch);
    let list = await own();
    const picked = [x, y].map((u) => list.find((n) => n.id === u.id)!);
    const { done } = await moveToTrash(list, picked);
    const batchId = done[0].batchId!;
    batches.add(batchId);

    // Never with what is inside: a folder that holds anything stays.
    expect(await destroyEmptyFolders([batchId])).toEqual([]);
    list = await own();
    expect(list.some((n) => n.id === batchId)).toBe(true);

    await purgeFromTrash(trashedItems(list).filter((i) => i.node.id === x.id));
    list = await own();
    expect(list.some((n) => n.id === x.id)).toBe(false);
    expect(list.some((n) => n.id === batchId)).toBe(true);

    await purgeFromTrash(trashedItems(list).filter((i) => i.node.id === y.id));
    list = await own();
    expect(list.some((n) => [x.id, y.id, batchId].includes(n.id))).toBe(false);
  }, 90_000);

  it('empties the trash', async () => {
    // Only on an account whose trash these tests made: a real one stays.
    if (trashBefore) return;
    const file = await upload('empty-me.txt', scratch);
    const list = await own();
    await moveToTrash(list, [list.find((n) => n.id === file.id)!]);
    await emptyTrash();
    const after = await own();
    expect(findTrashFolder(after)).toBeUndefined();
    expect(after.some((n) => n.id === file.id)).toBe(false);
  }, 90_000);
});
