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
  fileNodeKind,
  filesAccountId,
  getAllFileNodesAcrossAccounts,
  getFileNodeDownloadUrl,
  listFolder,
  moveFileNode,
  renameFileNode,
  uploadFileBatch,
} from '../files';

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
});
