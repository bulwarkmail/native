// The engine's building blocks on their own: provider batches, the
// SyncState blob, the run lock, SetError handling, query paging, the auth
// rebuild and how failures map to outcomes.

import { describe, expect, it, vi } from 'vitest';
import { BatchWriter, buildBatch, estimateBatchBytes, MAX_OPS_PER_YIELD, prependOps, type Work } from '../../engine/batch';
import { classifyFailure, RunAbort, StateMismatch, StopRun } from '../../engine/errors';
import { acquireLock } from '../../engine/mutex';
import { isBackedOff, nextMarker } from '../../engine/poison';
import { emptyStats, isQuietRun, statusToRecord } from '../../engine/report';
import { collectionDefaultOn, isCollectionSelected } from '../../engine/selection';
import { accountOf, emptySyncState, parseSyncState, serializeSyncState, StateStore, type SyncState } from '../../engine/sync-state';
import { classifySetError, existingIdFromUidError, JmapCaller } from '../../jmap/caller';
import { openWithAuthRebuild } from '../../jmap/connection';
import { JMAPMethodError } from '../../jmap/errors';
import { accountsWithCapability, calendarAddresses } from '../../jmap/session';
import { JMAP_CALENDARS, JMAP_CONTACTS, type BatchResult, type ProviderOp, type ProviderPort, type RunStats, type RunStatus } from '../../types';
import { FakeJmapServer } from '../fakes/fake-jmap-server';

function port(apply: (ops: ProviderOp[]) => BatchResult | Promise<BatchResult>): ProviderPort & { sent: ProviderOp[][] } {
  const sent: ProviderOp[][] = [];
  return {
    accountName: 'x',
    authority: 'com.android.contacts',
    sent,
    query: async () => ({ columns: [], rows: [] }),
    readSyncState: async () => null,
    readPhoto: async () => null,
    applyBatch: async (ops) => {
      sent.push(ops);
      return apply(ops);
    },
  };
}

const ok = (ops: ProviderOp[]): BatchResult => ({ ok: true, results: ops.map(() => ({ count: 1 })) });
const insert = (table: 'raw_contacts' | 'data', values: Record<string, string> = {}): ProviderOp => ({ op: 'insert', table, values });
const writer = (p: ProviderPort, options: Partial<{ maxOps: number; maxBytes: number; maxReplans: number }> = {}) =>
  new BatchWriter(p, { maxOps: 400, maxBytes: 300_000, maxReplans: 3, ...options });

describe('provider batches', () => {
  it('rebases refs, makes each group start at a yield point and puts the state op last', () => {
    const group = { ref: 'g', ops: [insert('raw_contacts'), { op: 'insert', table: 'data', values: {}, refs: { raw_contact_id: 0 }, yieldAllowed: true } as ProviderOp] };

    const ops = buildBatch([group, group], { op: 'syncState', value: '{}', yieldAllowed: true } as ProviderOp);

    expect(ops.map((op) => (op as { yieldAllowed?: boolean }).yieldAllowed ?? false)).toEqual([true, false, true, false, false]);
    expect((ops[3] as { refs: Record<string, number> }).refs).toEqual({ raw_contact_id: 2 });
    expect(ops[4]).toEqual({ op: 'syncState', value: '{}' });
  });

  it('prepends ops to a group, shifting its refs', () => {
    const group = prependOps({ ref: 'g', ops: [insert('raw_contacts'), { op: 'insert', table: 'data', values: {}, refs: { raw_contact_id: 0 } }] }, [
      { op: 'assert', table: 'raw_contacts', where: 'sourceid = ?', args: ['a/1'], expectCount: 0 },
    ]);
    expect((group.ops[2] as { refs: Record<string, number> }).refs).toEqual({ raw_contact_id: 1 });
  });

  it('never splits a group, keeps batches within the op budget and sends photo groups alone', async () => {
    const p = port(ok);
    const works: Work[] = [
      ...Array.from({ length: 5 }, (_, i) => ({ group: { ref: `g${i}`, ops: [insert('raw_contacts'), insert('data'), insert('data')] } })),
      { group: { ref: 'photo', ops: [{ op: 'insert', table: 'data', values: { data15: { b64: 'AAAA' } } }] } },
      { group: { ref: 'g5', ops: [insert('raw_contacts')] } },
    ];

    await writer(p, { maxOps: 7 }).write(works, { op: () => ({ op: 'syncState', value: 's' }), applied: () => undefined });

    expect(p.sent.map((b) => b.length)).toEqual([6, 6, 3, 1, 2]);
    expect(p.sent[3]).toEqual([expect.objectContaining({ values: { data15: { b64: 'AAAA' } } })]);
    expect(p.sent[4][1]).toEqual({ op: 'syncState', value: 's' });
  });

  it('retries the groups of a failed batch one by one and re-plans a failed assert at most three times', async () => {
    let failing = 5;
    const p = port((ops) =>
      ops.some((op) => op.op === 'assert') && failing-- > 0 ? { ok: false, reason: 'assert', message: 'stale' } : ok(ops),
    );
    const applied: string[] = [];
    const failed = vi.fn();
    let replans = 0;
    const stale: Work = {
      group: { ref: 'stale', ops: [{ op: 'assert', table: 'raw_contacts', id: 1, values: { version: 1 } }, insert('data')] },
      applied: () => {
        applied.push('stale');
      },
      failed,
    };
    stale.replan = async () => {
      replans++;
      return stale;
    };
    const fine: Work = {
      group: { ref: 'fine', ops: [insert('raw_contacts')] },
      applied: () => {
        applied.push('fine');
      },
    };
    const tail = { op: () => ({ op: 'syncState', value: 's' }) as ProviderOp, applied: vi.fn() };

    await writer(p).write([fine, stale], tail);

    expect(applied).toEqual(['fine']);
    expect(replans).toBe(3);
    expect(failed).toHaveBeenCalledWith('assert', 'stale');
    expect(tail.applied).toHaveBeenCalledOnce();
    expect(p.sent.at(-1)).toEqual([{ op: 'syncState', value: 's' }]);
  });

  it('splits a batch the Binder refused (tooLarge) and gives up a single group that is too large', async () => {
    const p = port((ops) => (ops.length > 2 ? { ok: false, reason: 'tooLarge', message: 'TransactionTooLargeException' } : ok(ops)));
    const failed = vi.fn();
    const works: Work[] = [
      ...Array.from({ length: 4 }, (_, i) => ({ group: { ref: `g${i}`, ops: [insert('raw_contacts')] } })),
      { group: { ref: 'big', ops: [insert('raw_contacts'), insert('data'), insert('data')] }, failed },
    ];

    await writer(p).write(works);

    expect(failed).toHaveBeenCalledWith('tooLarge', 'TransactionTooLargeException');
    expect(p.sent.filter((b) => b.length <= 2).flat()).toHaveLength(4);
  });

  it('ends the run when the permission is gone and refuses to retry an op outside the account', async () => {
    const denied = port(() => ({ ok: false, reason: 'permission', message: 'SecurityException' }));
    await expect(writer(denied).write([{ group: { ref: 'g', ops: [insert('raw_contacts')] } }])).rejects.toMatchObject({ outcome: 'permission' });
    const scope = port(() => ({ ok: false, reason: 'scope', message: 'not our account' }));
    await expect(writer(scope).write([{ group: { ref: 'g', ops: [insert('raw_contacts')] } }])).rejects.toThrow(/not our account/);
  });

  it("stores a group's state change in the batch that applies it, its retry included, and never without it", async () => {
    const store = new StateStore(emptySyncState(), { registryId: 'r', origin: 'o' });
    let failures = 1;
    const p = port((ops) => (ops.some((op) => op.op === 'assert') && failures-- > 0 ? { ok: false, reason: 'assert', message: 'stale' } : ok(ops)));
    const listed = (ref: string) => (next: SyncState) => {
      accountOf(next, 'a').groups = [...(accountOf(next, 'a').groups ?? []), ref];
    };
    const groupOps = (id: number): ProviderOp[] => [
      { op: 'assert', table: 'groups', id, values: { version: 1 } },
      { op: 'update', table: 'groups', id, values: { sourceid: `a/g${id}` } },
    ];
    const plain: Work = { group: { ref: 'c', ops: [insert('raw_contacts'), insert('data')] } };
    const retried: Work = { group: { ref: 'a/g1', ops: groupOps(1) }, state: listed('a/g1') };
    retried.replan = async () => ({ group: retried.group, state: retried.state });
    const w = new BatchWriter(p, { maxOps: 2, maxBytes: 300_000, maxReplans: 3 }, store);

    await w.write([plain, retried]);

    // The plain group alone, without a state op; the group with its state op, refused; its retry, with the state op.
    expect(p.sent.map((b) => b.map((op) => op.op))).toEqual([['insert', 'insert'], ['assert', 'update', 'syncState'], ['assert', 'update', 'syncState']]);
    expect(store.committed.accounts.a.groups).toEqual(['a/g1']);

    failures = Infinity;
    const given: Work = { group: { ref: 'a/g2', ops: groupOps(2) }, state: listed('a/g2'), replan: async () => null };
    await w.write([given], store.tail(() => undefined));

    expect(p.sent.at(-1)!.map((op) => op.op)).toEqual(['syncState']);
    expect(store.committed.accounts.a.groups).toEqual(['a/g1']);
  });

  it('plans a download again after a failed batch, which may have been committed up to a yield point', async () => {
    let failures = 1;
    const p = port((ops) => (failures-- > 0 ? { ok: false, reason: 'provider', message: 'failed after a yield point' } : ok(ops)));
    const planned: Work = { group: { ref: 'a/1', ops: [{ op: 'update', table: 'events', id: 1, values: { title: 'Planned from the new read' } }] } };
    const download: Work = { group: { ref: 'a/1', ops: [insert('data', { stale: 'group' })] }, fresh: true, replan: async () => planned };
    const other: Work = { group: { ref: 'a/2', ops: [insert('raw_contacts')] } };

    await writer(p).write([download, other]);

    expect(p.sent.slice(1)).toEqual([planned.group.ops.map((op) => ({ ...op, yieldAllowed: true })), buildBatch([other.group])]);
  });

  it('weighs a batch as the Parcel carries it: two bytes per character of its JSON and 300 per op', () => {
    const ops: ProviderOp[] = [insert('data', { data1: 'x'.repeat(1000) }), insert('raw_contacts')];

    expect(estimateBatchBytes(ops)).toBe(2 * JSON.stringify(ops).length + 2 * 300);
    expect(estimateBatchBytes(ops)).toBeGreaterThan(2 * 1000);
  });

  it('packs batches by that weight', async () => {
    const p = port(ok);
    const group = (i: number): Work => ({ group: { ref: `g${i}`, ops: [insert('data', { data1: 'x'.repeat(1000) })] } });

    await writer(p, { maxBytes: 2 * estimateBatchBytes(group(0).group.ops) }).write([group(0), group(1), group(2)]);

    expect(p.sent.map((b) => b.length)).toEqual([2, 1]);
  });

  it('sends the state op alone after a group that fills a yield window, and with a group that leaves room', async () => {
    const tail = () => ({ op: () => ({ op: 'syncState', value: 's' }) as ProviderOp, applied: () => undefined });
    const group = (n: number): Work => ({ group: { ref: `g${n}`, ops: Array.from({ length: n }, () => insert('data')) } });
    const p = port(ok);

    await writer(p, { maxOps: 1000 }).write([group(MAX_OPS_PER_YIELD)], tail());
    await writer(p, { maxOps: 1000 }).write([group(MAX_OPS_PER_YIELD - 1)], tail());

    expect(p.sent.map((b) => b.length)).toEqual([MAX_OPS_PER_YIELD, 1, MAX_OPS_PER_YIELD]);
  });

  it('skips groups that only assert', async () => {
    const p = port(ok);
    await writer(p).write([{ group: { ref: 'g', ops: [{ op: 'assert', table: 'raw_contacts', id: 1, values: { dirty: 0 } }] } }]);
    expect(p.sent).toEqual([]);
  });

  describe('an item too big for one group (a chain)', () => {
    const named = (n: string) => insert('data', { n });
    const namesOf = (batches: ProviderOp[][]) => batches.map((b) => b.map((op) => (op.op === 'insert' ? op.values.n : op.op)));
    const chained = (extra: Partial<Work> = {}): Work => ({
      group: { ref: 'big', ops: [named('1')], next: [{ ref: 'big', ops: [named('2')] }, { ref: 'big', ops: [named('3')] }] },
      ...extra,
    });

    it('applies its groups in order, each in a batch of its own, between the other works, and counts it after the last', async () => {
      const p = port(ok);
      const applied: string[] = [];
      const store = new StateStore(emptySyncState(), { registryId: 'r', origin: 'o' });
      const big = chained({
        applied: (results) => void applied.push(`big:${results.length}`),
        state: (next) => {
          accountOf(next, 'a').stale = ['big'];
        },
      });
      const other = (n: string): Work => ({ group: { ref: n, ops: [named(n)] }, applied: () => void applied.push(n) });

      await new BatchWriter(p, { maxOps: 400, maxBytes: 300_000, maxReplans: 3 }, store).write(
        [other('a'), big, other('b')],
        store.tail(() => undefined),
      );

      expect(namesOf(p.sent)).toEqual([['a'], ['1'], ['2'], ['3', 'syncState'], ['b', 'syncState']]);
      expect(applied).toEqual(['a', 'big:3', 'b']);
      expect(store.committed.accounts.a.stale).toEqual(['big']);
    });

    it('plans the item again from what its first groups wrote when a later one fails, never sending that one again', async () => {
      let failures = 1;
      const p = port((ops) => (namesOf([ops])[0].includes('2') && failures-- > 0 ? { ok: false, reason: 'assert', message: 'changed' } : ok(ops)));
      const rest: Work = { group: { ref: 'big', ops: [named('rest')] } };

      await writer(p).write([chained({ replan: async () => rest })]);

      expect(namesOf(p.sent)).toEqual([['1'], ['2'], ['rest']]);
    });

    it('gives the item up when one of its groups is refused for good', async () => {
      const p = port((ops) => (namesOf([ops])[0].includes('2') ? { ok: false, reason: 'tooLarge', message: 'TransactionTooLargeException' } : ok(ops)));
      const failed = vi.fn();

      await writer(p).write([chained({ failed, replan: async () => null })]);

      expect(namesOf(p.sent)).toEqual([['1'], ['2']]);
      expect(failed).toHaveBeenCalledWith('tooLarge', 'TransactionTooLargeException');
    });
  });
});

describe('SyncState', () => {
  it('round-trips and tolerates missing parts', () => {
    const state = emptySyncState();
    state.owner = { registryId: 'r', origin: 'https://o' };
    state.accounts.a = { collectionsState: 's1', itemsState: 's2', selected: ['a/b'], stale: ['c1'], reconcile: null, groups: ['a/g'] };
    state.deviceZone = 'Europe/Berlin';

    expect(parseSyncState(serializeSyncState(state))).toEqual({ state, readable: true });
    expect(parseSyncState(JSON.stringify({ v: 1, accounts: { a: { itemsState: 'x' } } })).state.accounts.a).toEqual({
      collectionsState: null,
      itemsState: 'x',
      selected: [],
      stale: [],
      reconcile: null,
    });
  });

  it('starts over when the blob is unreadable or of another version', () => {
    expect(parseSyncState('{nope').readable).toBe(false);
    expect(parseSyncState(JSON.stringify({ v: 2, accounts: {} })).readable).toBe(false);
    expect(parseSyncState(null)).toEqual({ state: emptySyncState(), readable: true });
    expect(parseSyncState('')).toEqual({ state: emptySyncState(), readable: true });
  });

  it('adopts a proposed state only after its batch applied', () => {
    const store = new StateStore(emptySyncState(), { registryId: 'r', origin: 'o' });
    const tail = store.tail((next) => {
      next.deviceZone = 'UTC';
    });
    const op = tail.op();
    expect(store.committed.deviceZone).toBeUndefined();
    expect(JSON.parse((op as { value: string }).value)).toMatchObject({ deviceZone: 'UTC', owner: { registryId: 'r' } });
    tail.applied();
    expect(store.committed.deviceZone).toBe('UTC');
  });
});

describe('run lock', () => {
  it('serialises holders and hands on the turn of a waiter that gave up', async () => {
    const order: string[] = [];
    const first = await acquireLock('k');
    const second = acquireLock('k', 10);
    const third = acquireLock('k');
    expect(await second).toBeNull();
    first!();
    const release = await third;
    order.push('third');
    release!();
    expect(order).toEqual(['third']);
    const again = await acquireLock('k', 10);
    expect(again).not.toBeNull();
    again!();
  });
});

describe('poison markers', () => {
  it('backs off an hour, doubling to a day, while the item stays the same', () => {
    const first = nextMarker(null, 'fp', { type: 'invalidPatch' }, 0, { firstMs: 3_600_000, maxMs: 86_400_000 });
    const second = nextMarker(first, 'fp', { type: 'invalidPatch' }, 0, { firstMs: 3_600_000, maxMs: 86_400_000 });
    let marker = second;
    for (let i = 0; i < 10; i++) marker = nextMarker(marker, 'fp', { type: 'invalidPatch' }, 0, { firstMs: 3_600_000, maxMs: 86_400_000 });
    expect([first.until, second.until, marker.until]).toEqual([3_600_000, 7_200_000, 86_400_000]);
    expect(nextMarker(second, 'changed', { type: 'invalidPatch' }, 0, { firstMs: 1, maxMs: 10 }).n).toBe(1);
    expect(isBackedOff(first, 'fp', 1)).toBe(true);
    expect(isBackedOff(first, 'other', 1)).toBe(false);
    expect(isBackedOff(first, 'fp', 3_600_001)).toBe(false);
  });
});

describe('JMAP side', () => {
  it('classifies SetErrors', () => {
    expect(classifySetError({ type: 'notFound' }, 'update')).toBe('notFound');
    expect(classifySetError({ type: 'forbidden' }, 'destroy')).toBe('forbidden');
    expect(classifySetError({ type: 'invalidProperties', properties: ['uid'] }, 'create')).toBe('uidExists');
    expect(classifySetError({ type: 'invalidProperties', properties: ['uid'] }, 'update')).toBe('poison');
    expect(classifySetError({ type: 'overQuota' }, 'create')).toBe('poison');
    expect(existingIdFromUidError({ type: 'invalidProperties', description: 'Contact with UID u1 already exists with id c5.' })).toBe('c5');
    expect(existingIdFromUidError({ type: 'invalidProperties', description: 'An event with UID u1 already exists.' })).toBeNull();
  });

  it('pages /query by position until the total, with overlapping pages', async () => {
    const server = new FakeJmapServer();
    server.addAccount('a', { name: 'alice@example.com' });
    const book = server.addAddressBook('a', { name: 'Personal' });
    for (let i = 0; i < 30; i++) server.addCard('a', { uid: `u${i}` });
    server.setLimits({ maxQueryResults: 8 });
    const caller = new JmapCaller(server.port(), () => 0);

    const ids = await caller.queryAll('ContactCard', 'a', { inAddressBook: book });

    expect(ids).toHaveLength(30);
    expect(server.calls('ContactCard/query').length).toBeGreaterThan(3);
  });

  it('looks uids up in one query and maps them back', async () => {
    const server = new FakeJmapServer();
    server.addAccount('a', { name: 'alice@example.com' });
    const book = server.addAddressBook('a', { name: 'Personal' });
    const other = server.addAddressBook('a', { name: 'Other' });
    const c1 = server.addCard('a', { uid: 'u1', addressBookIds: { [book]: true } });
    server.addCard('a', { uid: 'u2', addressBookIds: { [other]: true } });
    const caller = new JmapCaller(server.port(), () => 0);

    const found = await caller.lookupUids('ContactCard', 'a', ['u1', 'u2', 'u3'], book);

    expect([...found]).toEqual([['u1', [c1]]]);
  });

  it('names the accounts with a capability, the primary first', () => {
    const server = new FakeJmapServer();
    server.addAccount('team', { name: 'Team', isPersonal: false, capabilities: ['contacts'] });
    server.addAccount('a', { name: 'alice@example.com' });
    const session = server.port().session();

    expect(accountsWithCapability(session, JMAP_CONTACTS).map((a) => [a.id, a.primary, a.personal])).toEqual([
      ['a', true, true],
      ['team', false, false],
    ]);
    expect(accountsWithCapability(session, JMAP_CALENDARS).map((a) => a.id)).toEqual(['a']);
  });

  it("counts only the capability's primary account as personal, like the app's chooser", () => {
    const server = new FakeJmapServer();
    server.addAccount('a', { name: 'alice@example.com' });
    // Another account the server calls personal (a second mailbox of the same login, say).
    server.addAccount('home', { name: 'alice-home@example.com', isPersonal: true });
    const session = server.port().session();

    expect(accountsWithCapability(session, JMAP_CONTACTS).map((a) => [a.id, a.primary, a.personal])).toEqual([
      ['a', true, true],
      ['home', false, false],
    ]);
  });

  it('takes the login as the owner address and survives a server without identities', async () => {
    const server = new FakeJmapServer();
    server.addAccount('a', { name: 'Alice@Example.com' });
    const addresses = await calendarAddresses(new JmapCaller(server.port(), () => 0), 'fallback');
    expect(addresses).toEqual({ ownerAccount: 'alice@example.com', selfAddresses: ['alice@example.com'] });
  });

  it('rebuilds the connection once when the credentials are rejected', async () => {
    const server = new FakeJmapServer();
    server.addAccount('a', { name: 'alice@example.com' });
    const load = vi.fn(async () => ({ port: server.port(), origin: 'o' }));
    const connection = await openWithAuthRebuild(load);
    server.failNextRequest('auth');

    await connection.port.request([['Core/echo', {}, '0']], ['urn:ietf:params:jmap:core']);
    expect(load).toHaveBeenCalledTimes(2);

    server.failNextRequest('auth');
    await expect(connection.port.request([['Core/echo', {}, '0']], ['urn:ietf:params:jmap:core'])).rejects.toMatchObject({ name: 'AuthenticationError' });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('opens with a second client when the first has no session, and gives up after that', async () => {
    const connection = { port: new FakeJmapServer().port(), origin: 'o' };
    const loads = [null, connection];
    await expect(openWithAuthRebuild(async () => loads.shift() ?? null)).resolves.toMatchObject({ origin: 'o' });
    expect(loads).toEqual([]);
    const rejected = Object.assign(new Error('401'), { name: 'AuthenticationError' });
    await expect(openWithAuthRebuild(async () => { throw rejected; })).rejects.toMatchObject({ name: 'AuthenticationError' });
    await expect(openWithAuthRebuild(async () => null)).rejects.toMatchObject({ name: 'AuthenticationError' });
    const offline = Object.assign(new Error('offline'), { name: 'NetworkError' });
    await expect(openWithAuthRebuild(async () => { throw offline; })).rejects.toBe(offline);
  });
});

describe('selection defaults', () => {
  it("syncs the personal account's collections, not shared ones nor the Trusted Senders book, unless chosen", () => {
    expect(collectionDefaultOn(true, 'com.android.contacts', 'Personal')).toBe(true);
    expect(collectionDefaultOn(true, 'com.android.contacts', 'Trusted Senders')).toBe(false);
    expect(collectionDefaultOn(true, 'com.android.calendar', 'Trusted Senders')).toBe(true);
    expect(collectionDefaultOn(false, 'com.android.contacts', 'Team')).toBe(false);
    expect(collectionDefaultOn(true, 'com.android.calendar', null)).toBe(true);

    const personal = { id: 'a', personal: true };
    const trusted = { id: 'ab9', name: 'Trusted Senders' };
    expect(isCollectionSelected({}, personal, 'com.android.contacts', trusted)).toBe(false);
    expect(isCollectionSelected({ 'a/ab9': true }, personal, 'com.android.contacts', trusted)).toBe(true);
    expect(isCollectionSelected({ 'a/ab1': false }, personal, 'com.android.contacts', { id: 'ab1', name: 'Personal' })).toBe(false);
    expect(isCollectionSelected({ 't/c1': true }, { id: 't', personal: false }, 'com.android.calendar', { id: 'c1' })).toBe(true);
  });
});

describe('outcomes', () => {
  it('maps failures to report outcomes', () => {
    const named = (name: string, extra: object = {}) => Object.assign(new Error(name), { name, ...extra });
    expect(classifyFailure(new StopRun('deadline'), 0)).toMatchObject({ outcome: 'cancelled', moreRecordsToGet: true });
    expect(classifyFailure(new RunAbort('safetyAbort', 'x'), 0)).toMatchObject({ outcome: 'safetyAbort' });
    expect(classifyFailure(new StateMismatch('a'), 0)).toMatchObject({ outcome: 'io', noProgress: true });
    expect(classifyFailure(named('AuthenticationError'), 0)).toMatchObject({ outcome: 'auth', authProblem: true });
    expect(classifyFailure(named('NetworkError'), 0)).toMatchObject({ outcome: 'io' });
    expect(classifyFailure(named('RequestTimeoutError'), 0)).toMatchObject({ outcome: 'io' });
    expect(classifyFailure(named('RateLimitError', { retryAfterMs: 5000 }), 10_000)).toMatchObject({ outcome: 'io', delayUntil: 15 });
    expect(classifyFailure(new JMAPMethodError('serverFail'), 0)).toMatchObject({ outcome: 'io' });
    expect(classifyFailure(new Error('JMAP request failed: 503 - busy'), 0)).toMatchObject({ outcome: 'io' });
    expect(
      classifyFailure(new Error('JMAP request failed: 400 - {"type":"urn:ietf:params:jmap:error:limit","limit":"maxCallsInRequest"}'), 0),
    ).toMatchObject({ outcome: 'internal' });
    expect(classifyFailure(Object.assign(new Error('denied'), { code: 'permission' }), 0)).toMatchObject({ outcome: 'permission' });
    expect(classifyFailure(new TypeError('x is undefined'), 0)).toMatchObject({ outcome: 'internal' });
  });
});

describe('the status a run leaves for the settings', () => {
  const status = (over: Partial<RunStatus> = {}): RunStatus => ({ at: 2_000, outcome: 'ok', durationMs: 50, conflicts: 0, itemErrors: 0, stats: emptyStats(), ...over });
  const withStats = (edit: (stats: RunStats) => void) => {
    const stats = emptyStats();
    edit(stats);
    return status({ stats });
  };
  const reported = status({ at: 1_000, durationMs: 900, conflicts: 1, itemErrors: 2, message: 'invitations not sent', stats: { ...emptyStats(), skipped: 2 } });

  it('keeps what the run before reported through a run that did nothing, moving the time on', () => {
    expect(isQuietRun(status())).toBe(true);
    expect(statusToRecord(status(), reported)).toEqual({ ...reported, at: 2_000 });
    expect(statusToRecord(status(), undefined)).toEqual(status());
  });

  it('shows a failure followed by a run that did nothing as recovered, with what the failed run reported', () => {
    const failed = { ...reported, outcome: 'io' as const, message: 'Could not reach the server' };
    const recorded = statusToRecord(status(), failed);

    expect(recorded).toEqual({ at: 2_000, outcome: 'ok', durationMs: 900, conflicts: 1, itemErrors: 2, stats: reported.stats });
  });

  it('replaces it with a run that wrote, skipped or reported anything, or failed', () => {
    const busy = [
      withStats((s) => (s.downloaded.created = 1)),
      withStats((s) => (s.downloaded.deleted = 1)),
      withStats((s) => (s.uploaded.updated = 1)),
      withStats((s) => (s.skipped = 1)),
      status({ conflicts: 1 }),
      status({ itemErrors: 1 }),
      status({ message: 'invitations not sent' }),
      status({ outcome: 'io', message: 'Could not reach the server' }),
      status({ outcome: 'cancelled' }),
      status({ outcome: 'disabled', message: 'Sync is off for this account' }),
    ];
    for (const run of busy) {
      expect(isQuietRun(run)).toBe(false);
      expect(statusToRecord(run, reported)).toBe(run);
    }
    // Items only looked at are no work.
    expect(isQuietRun(withStats((s) => (s.entries = 3)))).toBe(true);
  });
});
