import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    serverUrl: 'https://mail.example.org',
    username: 'me@example.org',
    request: vi.fn(),
    hasCapability: vi.fn(() => true),
    hasAccountCapability: vi.fn(() => false),
    getMaxObjectsInGet: vi.fn(() => 500),
    getMaxObjectsInSet: vi.fn(() => 500),
    getMaxCallsInRequest: vi.fn(() => 16),
    getAccountCapability: vi.fn(),
    currentSession: {
      primaryAccounts: { 'urn:ietf:params:jmap:filenode': 'acc-1' },
      accounts: { 'acc-1': { name: 'me', isPersonal: true }, 'acc-2': { name: 'them', isPersonal: false } },
    },
  },
}));

import { jmapClient } from '../jmap-client';
import type { FileNode } from '../types';
import {
  TrashUnavailableError, emptyTrash, moveToTrash, purgeFromTrash, restoreFromTrash, undoMoveToTrash,
} from '../files-trash';
import { trashedItems } from '../../lib/files-trash';

// A Stalwart-like FileNode store for the user's own account: destroy without
// onDestroyRemoveChildren refuses a folder that holds anything.
type Node = { id: string; parentId: string | null; name: string; blobId: string | null; type?: string };
let store: Node[];
let nextId: number;
let calls: Array<Record<string, unknown>>;
let refuseUpdate: Set<string>;

function serve(method: string, args: Record<string, any>) {
  if (method === 'FileNode/get') return { list: store.map((n) => ({ ...n })) };
  calls.push(args);
  const out: Record<string, any> = {};
  // Like Stalwart, two nodes of one folder can't share a name.
  const clashes = (parentId: string | null, name: string, self?: string) =>
    store.some((n) => n.parentId === parentId && n.name === name && n.id !== self);
  for (const [key, props] of Object.entries((args.create ?? {}) as Record<string, any>)) {
    if (clashes(props.parentId ?? null, props.name)) {
      (out.notCreated ??= {})[key] = { type: 'alreadyExists', description: 'taken' };
      continue;
    }
    const id = `n${nextId++}`;
    store.push({ id, parentId: props.parentId ?? null, name: props.name, blobId: props.blobId ?? null });
    (out.created ??= {})[key] = { id };
  }
  for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, any>)) {
    const node = store.find((n) => n.id === id);
    if (!node || refuseUpdate.has(id)) {
      (out.notUpdated ??= {})[id] = { type: 'forbidden', description: 'no' };
      continue;
    }
    const parentId = 'parentId' in patch ? patch.parentId : node.parentId;
    if (clashes(parentId, patch.name ?? node.name, id)) {
      (out.notUpdated ??= {})[id] = { type: 'alreadyExists', description: 'taken' };
      continue;
    }
    Object.assign(node, patch);
    (out.updated ??= {})[id] = null;
  }
  for (const id of (args.destroy ?? []) as string[]) {
    if (!store.some((n) => n.id === id)) {
      (out.notDestroyed ??= {})[id] = { type: 'notFound' };
      continue;
    }
    if (!args.onDestroyRemoveChildren && store.some((n) => n.parentId === id)) {
      (out.notDestroyed ??= {})[id] = { type: 'nodeHasChildren' };
      continue;
    }
    const gone = new Set([id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const n of store) if (n.parentId && gone.has(n.parentId) && !gone.has(n.id)) { gone.add(n.id); grew = true; }
    }
    store = store.filter((n) => !gone.has(n.id));
    (out.destroyed ??= []).push(id);
  }
  return out;
}

const listed = (): FileNode[] => store.map((n) => ({ ...n, type: n.type ?? '' }) as FileNode);
const byId = (id: string) => store.find((n) => n.id === id);

// Who is signed in: another login, or another files account of it.
const client = jmapClient as unknown as { username: string; currentSession: { primaryAccounts: Record<string, string> } };
function signIn(username: string, filesAccount = 'acc-1') {
  client.username = username;
  client.currentSession.primaryAccounts['urn:ietf:params:jmap:filenode'] = filesAccount;
}

beforeEach(() => {
  signIn('me@example.org');
  // No naming rules published unless a test says so.
  (jmapClient.getAccountCapability as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
  nextId = 1;
  calls = [];
  refuseUpdate = new Set();
  store = [
    { id: 'docs', parentId: null, name: 'Docs', blobId: null },
    { id: 'a', parentId: 'docs', name: 'a.txt', blobId: 'ba' },
    { id: 'b', parentId: 'docs', name: 'b.txt', blobId: 'bb' },
    { id: 'top', parentId: null, name: 'top.txt', blobId: 'bt' },
  ];
  (jmapClient.request as ReturnType<typeof vi.fn>).mockImplementation(async (methodCalls: any[]) => ({
    methodResponses: methodCalls.map(([method, args, id]: [string, any, string]) => [method, serve(method, args), id]),
  }));
});

describe('moveToTrash', () => {
  it('makes .Trash on the first delete and one trash folder per folder the items came from', async () => {
    const nodes = listed();
    const { done } = await moveToTrash(nodes, nodes.filter((n) => ['a', 'top'].includes(n.id)), 1730112000000);

    const trash = store.find((n) => n.name === '.Trash')!;
    expect(trash.parentId).toBeNull();
    expect(trash.blobId).toBeNull();
    const batchNames = store.filter((n) => n.parentId === trash.id).map((n) => n.name).sort();
    expect(batchNames).toEqual(['1730112000000~', '1730112000000~docs']);
    expect(byId('a')!.parentId).toBe(store.find((n) => n.name === '1730112000000~docs')!.id);
    expect(byId('top')!.parentId).toBe(store.find((n) => n.name === '1730112000000~')!.id);
    expect(done.map((i) => [i.node.id, i.fromParentId])).toEqual([['a', 'docs'], ['top', null]]);
    // What the webmail reads back.
    expect(trashedItems(listed()).map((i) => [i.node.id, i.fromParentId, i.deletedAt])).toEqual([
      ['a', 'docs', 1730112000000],
      ['top', null, 1730112000000],
    ]);
  });

  it('reuses the trash folder that is there', async () => {
    store.push({ id: 'T', parentId: null, name: '.Trash', blobId: null });
    const nodes = listed();
    await moveToTrash(nodes, nodes.filter((n) => n.id === 'a'), 1730112000001);
    expect(store.filter((n) => n.name === '.Trash')).toHaveLength(1);
    expect(byId(byId('a')!.parentId!)!.parentId).toBe('T');
  });

  it('finds the trash again when the one on screen was emptied elsewhere', async () => {
    store.push({ id: 'T', parentId: null, name: '.Trash', blobId: null });
    const nodes = listed();
    store = store.filter((n) => n.id !== 'T');
    store.push({ id: 'T2', parentId: null, name: '.Trash', blobId: null });
    // The fake creates under a missing parent, so make that fail like the server.
    const real = (jmapClient.request as ReturnType<typeof vi.fn>).getMockImplementation() as (calls: any[]) => Promise<unknown>;
    (jmapClient.request as ReturnType<typeof vi.fn>).mockImplementation(async (methodCalls: any[]) => {
      const create = methodCalls[0][1].create as Record<string, any> | undefined;
      const parent = create && Object.values(create)[0].parentId;
      if (parent && !byId(parent)) {
        return { methodResponses: [['FileNode/set', { notCreated: { 'new-dir': { type: 'invalidProperties' } } }, '0']] };
      }
      return real(methodCalls);
    });
    await moveToTrash(nodes, nodes.filter((n) => n.id === 'a'), 1730112000001);
    expect(byId(byId('a')!.parentId!)!.parentId).toBe('T2');
  });

  it('refuses nodes of a shared drive', async () => {
    const shared = { id: 'acc-2:x', parentId: null, name: 'x', type: '', blobId: 'bx', isShared: true } as FileNode;
    await expect(moveToTrash([shared], [shared])).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('throws the refusal and leaves no empty trash folder when nothing went', async () => {
    refuseUpdate.add('a');
    const nodes = listed();
    await expect(moveToTrash(nodes, nodes.filter((n) => n.id === 'a'), 1730112000005)).rejects.toThrow('no');
    expect(store.some((n) => n.name === '1730112000005~docs')).toBe(false);
    expect(byId('a')!.parentId).toBe('docs');
    const destroy = calls.find((c) => c.destroy);
    expect(destroy?.onDestroyRemoveChildren).toBeUndefined();
  });

  it('says the trash cannot be had when a file at the root is named .Trash', async () => {
    store.push({ id: 'f', parentId: null, name: '.Trash', blobId: 'bf' });
    const nodes = listed();
    const err = await moveToTrash(nodes, nodes.filter((n) => n.id === 'a'), 1730112000005).catch((e) => e);
    expect(err).toBeInstanceOf(TrashUnavailableError);
    expect(calls.some((c) => c.update)).toBe(false);
    expect(byId('a')!.parentId).toBe('docs');
  });

  it('says the trash cannot be had when no folder can be made in it (quota)', async () => {
    store.push({ id: 'T', parentId: null, name: '.Trash', blobId: null });
    const real = (jmapClient.request as ReturnType<typeof vi.fn>).getMockImplementation() as (c: any[]) => Promise<unknown>;
    (jmapClient.request as ReturnType<typeof vi.fn>).mockImplementation(async (methodCalls: any[]) => {
      if (methodCalls[0][1].create) {
        return { methodResponses: [['FileNode/set', { notCreated: { 'new-dir': { type: 'overQuota' } } }, '0']] };
      }
      return real(methodCalls);
    });
    const nodes = listed();
    await expect(moveToTrash(nodes, nodes.filter((n) => n.id === 'a'), 1730112000005)).rejects.toBeInstanceOf(TrashUnavailableError);
    expect(byId('a')!.parentId).toBe('docs');
  });

  it('reports a partial refusal and keeps what went', async () => {
    refuseUpdate.add('b');
    const nodes = listed();
    const { done, refused } = await moveToTrash(nodes, nodes.filter((n) => n.parentId === 'docs'), 1730112000005);
    expect(done.map((i) => i.node.id)).toEqual(['a']);
    expect(refused).toHaveLength(1);
  });
});

describe('restoreFromTrash', () => {
  it('puts items back where they came from and removes their empty trash folder', async () => {
    let nodes = listed();
    await moveToTrash(nodes, nodes.filter((n) => n.parentId === 'docs'), 1730112000007);
    nodes = listed();
    const batch = store.find((n) => n.name === '1730112000007~docs')!;
    await restoreFromTrash(trashedItems(nodes));
    expect(byId('a')).toMatchObject({ parentId: 'docs', name: 'a.txt' });
    expect(byId('b')).toMatchObject({ parentId: 'docs', name: 'b.txt' });
    expect(byId(batch.id)).toBeUndefined();
    // No rename was sent along with the move.
    const update = calls.filter((c) => c.update).pop()!.update as Record<string, Record<string, unknown>>;
    expect(update.a).toEqual({ parentId: 'docs' });
  });

  it('keeps a trash folder that other items still hold', async () => {
    let nodes = listed();
    await moveToTrash(nodes, nodes.filter((n) => n.parentId === 'docs'), 1730112000007);
    nodes = listed();
    const batch = store.find((n) => n.name === '1730112000007~docs')!;
    await restoreFromTrash(trashedItems(nodes).filter((i) => i.node.id === 'a'));
    expect(byId(batch.id)).toBeDefined();
    expect(byId('b')!.parentId).toBe(batch.id);
  });

  it('gives a name taken by now a free one, and sends the root for a folder that is gone', async () => {
    let nodes = listed();
    await moveToTrash(nodes, nodes.filter((n) => n.id === 'a'), 1730112000007);
    store.push({ id: 'a2', parentId: 'docs', name: 'a.txt', blobId: 'ba2' });
    nodes = listed();
    await moveToTrash(nodes, nodes.filter((n) => n.id === 'docs'), 1730112000008);
    nodes = listed();
    // Docs is in the trash itself now: a.txt goes to the root.
    await restoreFromTrash(trashedItems(nodes).filter((i) => i.node.id === 'a'));
    expect(byId('a')).toMatchObject({ parentId: null, name: 'a.txt' });

    nodes = listed();
    await restoreFromTrash(trashedItems(nodes).filter((i) => i.node.id === 'docs'));
    await moveToTrash(listed(), listed().filter((n) => n.id === 'a2'), 1730112000009);
    store.push({ id: 'a3', parentId: 'docs', name: 'a.txt', blobId: 'ba3' });
    nodes = listed();
    await restoreFromTrash(trashedItems(nodes).filter((i) => i.node.id === 'a2'));
    expect(byId('a2')).toMatchObject({ parentId: 'docs', name: 'a (1).txt' });
  });

  it('undoes a delete with the listing from before it, without renaming', async () => {
    const before = listed();
    const { done } = await moveToTrash(before, before.filter((n) => n.parentId === 'docs'), 1730112000007);
    await restoreFromTrash(done);
    expect(byId('a')).toMatchObject({ parentId: 'docs', name: 'a.txt' });
    expect(byId('b')).toMatchObject({ parentId: 'docs', name: 'b.txt' });
    expect(store.some((n) => n.name === '1730112000007~docs')).toBe(false);
  });

  it('undoes into the root when the folder went to the trash after the delete', async () => {
    const before = listed();
    const { done } = await moveToTrash(before, before.filter((n) => n.id === 'a'), 1730112000007);
    await moveToTrash(listed(), listed().filter((n) => n.id === 'docs'), 1730112000008);
    const { done: back } = await restoreFromTrash(done);
    expect(back).toHaveLength(1);
    expect(byId('a')).toMatchObject({ parentId: null, name: 'a.txt' });
  });

  it('undoes under a free name when the old one was taken after the delete', async () => {
    const before = listed();
    const { done } = await moveToTrash(before, before.filter((n) => n.id === 'a'), 1730112000007);
    store.push({ id: 'a2', parentId: 'docs', name: 'a.txt', blobId: 'ba2' });
    await restoreFromTrash(done);
    expect(byId('a')).toMatchObject({ parentId: 'docs', name: 'a (1).txt' });
    expect(byId('a2')).toMatchObject({ parentId: 'docs', name: 'a.txt' });
  });

  it('puts an item back into its folder when that folder is restored with it', async () => {
    await moveToTrash(listed(), listed().filter((n) => n.id === 'a'), 1730112000007);
    await moveToTrash(listed(), listed().filter((n) => n.id === 'docs'), 1730112000008);
    const nodes = listed();
    const { done } = await restoreFromTrash(trashedItems(nodes));
    expect(done.map((i) => [i.node.id, i.node.parentId]).sort()).toEqual([['a', 'docs'], ['docs', null]]);
    expect(byId('docs')!.parentId).toBeNull();
    expect(byId('a')).toMatchObject({ parentId: 'docs', name: 'a.txt' });
    expect(store.some((n) => /^\d+~/.test(n.name))).toBe(false);
  });

  it('puts an item back into a folder inside one restored with it, under a free name', async () => {
    store.push({ id: 'sub', parentId: 'docs', name: 'Sub', blobId: null }, { id: 'c', parentId: 'sub', name: 'c.txt', blobId: 'bc' });
    await moveToTrash(listed(), listed().filter((n) => n.id === 'c'), 1730112000007);
    store.push({ id: 'c2', parentId: 'sub', name: 'c.txt', blobId: 'bc2' });
    await moveToTrash(listed(), listed().filter((n) => n.id === 'docs'), 1730112000008);
    await restoreFromTrash(trashedItems(listed()));
    expect(byId('docs')!.parentId).toBeNull();
    expect(byId('c')).toMatchObject({ parentId: 'sub', name: 'c (1).txt' });
    expect(byId('c2')).toMatchObject({ parentId: 'sub', name: 'c.txt' });
  });

  it('puts the item at the root when its folder could not be restored with it', async () => {
    await moveToTrash(listed(), listed().filter((n) => n.id === 'a'), 1730112000007);
    await moveToTrash(listed(), listed().filter((n) => n.id === 'docs'), 1730112000008);
    refuseUpdate.add('docs');
    const { done, refused } = await restoreFromTrash(trashedItems(listed()));
    expect(done.map((i) => i.node.id)).toEqual(['a']);
    expect(refused).toHaveLength(1);
    expect(byId('a')!.parentId).toBeNull();
  });

  it('gives a clashing WebDAV name a free one the server accepts', async () => {
    // Stored by WebDAV with a ":" escaped, which JMAP names refuse.
    store.push({ id: 'w', parentId: 'docs', name: 'a%3Ab.txt', blobId: 'bw' });
    await moveToTrash(listed(), listed().filter((n) => n.id === 'w'), 1730112000007);
    store.push({ id: 'w2', parentId: 'docs', name: 'a%3Ab.txt', blobId: 'bw2' });
    (jmapClient.getAccountCapability as ReturnType<typeof vi.fn>).mockReturnValue({ forbiddenNameChars: ':*' });
    await restoreFromTrash(trashedItems(listed()));
    const update = calls.filter((c) => c.update).pop()!.update as Record<string, Record<string, unknown>>;
    expect(update.w).toEqual({ parentId: 'docs', name: 'a_b (1).txt' });
    expect(byId('w')).toMatchObject({ parentId: 'docs', name: 'a_b (1).txt' });
  });

  it('gives a folder named .Trash that goes back to the root another name', async () => {
    store.push({ id: 'x', parentId: 'docs', name: '.Trash', blobId: null }, { id: 'xin', parentId: 'x', name: 'in.txt', blobId: 'bi' });
    let nodes = listed();
    await moveToTrash(nodes, nodes.filter((n) => n.id === 'x'), 1730112000007);
    // Docs goes too: the folder comes back to the root.
    await moveToTrash(listed(), listed().filter((n) => n.id === 'docs'), 1730112000008);
    nodes = listed();
    await restoreFromTrash(trashedItems(nodes).filter((i) => i.node.id === 'x'));
    expect(byId('x')).toMatchObject({ parentId: null, name: '.Trash (1)' });
    expect(store.filter((n) => n.parentId === null && n.name === '.Trash')).toHaveLength(1);
  });

  it('leaves an item alone that left the trash since the rows were listed', async () => {
    let nodes = listed();
    await moveToTrash(nodes, nodes.filter((n) => n.id === 'a'), 1730112000007);
    nodes = listed();
    const rows = trashedItems(nodes);
    // Restored on another device and moved on from there.
    byId('a')!.parentId = 'top-dir';
    store.push({ id: 'top-dir', parentId: null, name: 'Elsewhere', blobId: null });
    const sent = calls.length;
    const { done } = await restoreFromTrash(rows);
    expect(done).toEqual([]);
    expect(calls.slice(sent).filter((c) => c.update)).toEqual([]);
    expect(byId('a')!.parentId).toBe('top-dir');
  });
});

describe('undoMoveToTrash', () => {
  it('puts the items back while the same drive is signed in', async () => {
    const before = listed();
    const moved = await moveToTrash(before, before.filter((n) => n.id === 'a'), 1730112000007);
    expect((await undoMoveToTrash(moved))?.done).toHaveLength(1);
    expect(byId('a')).toMatchObject({ parentId: 'docs' });
  });

  it('sends nothing once another login is signed in, whose ids may be the same', async () => {
    const before = listed();
    const moved = await moveToTrash(before, before.filter((n) => n.id === 'a'), 1730112000007);
    signIn('other@example.org');
    const sent = calls.length;
    const requests = (jmapClient.request as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(await undoMoveToTrash(moved)).toBeNull();
    expect(calls.length).toBe(sent);
    expect((jmapClient.request as ReturnType<typeof vi.fn>).mock.calls.length).toBe(requests);
    expect(byId(byId('a')!.parentId!)!.name).toBe('1730112000007~docs');
  });

  it('sends nothing once the login reads another files account', async () => {
    const before = listed();
    const moved = await moveToTrash(before, before.filter((n) => n.id === 'a'), 1730112000007);
    signIn('me@example.org', 'acc-3');
    const sent = calls.length;
    expect(await undoMoveToTrash(moved)).toBeNull();
    expect(calls.length).toBe(sent);
  });

  it('stops before the restore when the account changes while the drive is read', async () => {
    const before = listed();
    const moved = await moveToTrash(before, before.filter((n) => n.id === 'a'), 1730112000007);
    const real = (jmapClient.request as ReturnType<typeof vi.fn>).getMockImplementation() as (c: any[]) => Promise<unknown>;
    (jmapClient.request as ReturnType<typeof vi.fn>).mockImplementation(async (methodCalls: any[]) => {
      const out = await real(methodCalls);
      if (methodCalls[0][0] === 'FileNode/get') signIn('other@example.org');
      return out;
    });
    const sent = calls.length;
    expect(await undoMoveToTrash(moved)).toBeNull();
    expect(calls.length).toBe(sent);
  });

  it('stops a delete whose account changes before its items are moved', async () => {
    const before = listed();
    const real = (jmapClient.request as ReturnType<typeof vi.fn>).getMockImplementation() as (c: any[]) => Promise<unknown>;
    (jmapClient.request as ReturnType<typeof vi.fn>).mockImplementation(async (methodCalls: any[]) => {
      const out = await real(methodCalls);
      if (methodCalls[0][1].create) signIn('other@example.org');
      return out;
    });
    await expect(moveToTrash(before, before.filter((n) => n.id === 'a'), 1730112000007)).rejects.toThrow('Another account');
    expect(calls.some((c) => c.update)).toBe(false);
    expect(byId('a')!.parentId).toBe('docs');
  });
});

describe('purgeFromTrash and emptyTrash', () => {
  it('deletes items for good with what is inside, and their emptied trash folder', async () => {
    let nodes = listed();
    await moveToTrash(nodes, nodes.filter((n) => n.id === 'docs'), 1730112000007);
    nodes = listed();
    expect(await purgeFromTrash(trashedItems(nodes))).toBe(1);
    expect(store.map((n) => n.id).sort()).toEqual(['n1', 'top']);
    expect(byId('n1')!.name).toBe('.Trash');
  });

  it('leaves a row on screen alone that was restored elsewhere meanwhile', async () => {
    let nodes = listed();
    await moveToTrash(nodes, nodes.filter((n) => n.id === 'docs'), 1730112000007);
    nodes = listed();
    const rows = trashedItems(nodes);
    // Another device puts Docs back before the Delete permanently here.
    byId('docs')!.parentId = null;
    expect(await purgeFromTrash(rows)).toBe(0);
    expect(store.map((n) => n.id).sort()).toEqual(['a', 'b', 'docs', 'n1', 'n2', 'top']);
    expect(calls.some((c) => (c.destroy as string[] | undefined)?.includes('docs'))).toBe(false);
  });

  it('deletes only the rows still in the trash, and their trash folder as it is now', async () => {
    let nodes = listed();
    await moveToTrash(nodes, nodes.filter((n) => n.parentId === 'docs'), 1730112000007);
    nodes = listed();
    const rows = trashedItems(nodes);
    byId('b')!.parentId = 'docs';
    expect(await purgeFromTrash(rows)).toBe(1);
    expect(byId('a')).toBeUndefined();
    expect(byId('b')).toMatchObject({ parentId: 'docs' });
    expect(store.some((n) => n.name === '1730112000007~docs')).toBe(false);
  });

  it('empties the trash, everything in it included', async () => {
    const nodes = listed();
    await moveToTrash(nodes, nodes.filter((n) => n.parentId === 'docs'), 1730112000007);
    await emptyTrash();
    expect(store.map((n) => n.id).sort()).toEqual(['docs', 'top']);
  });

  it('empties the trash as it is now, not a folder that was the trash on screen', async () => {
    store.push({ id: 'T', parentId: null, name: '.Trash', blobId: null }, { id: 'old', parentId: 'T', name: 'old.txt', blobId: 'bo' });
    // Renamed elsewhere (WebDAV), and a new trash made since.
    byId('T')!.name = 'Kept';
    store.push({ id: 'T2', parentId: null, name: '.Trash', blobId: null }, { id: 'new', parentId: 'T2', name: 'new.txt', blobId: 'bn' });
    await emptyTrash();
    expect(store.map((n) => n.id).sort()).toEqual(['T', 'a', 'b', 'docs', 'old', 'top']);
  });
});
