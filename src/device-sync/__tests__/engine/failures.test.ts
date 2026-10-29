// How the engine survives crashes, lost responses and server trouble, and
// its guards (docs/device-sync.md, "Invariants", "Failure matrix",
// "Deletion threshold").

import { describe, expect, it } from 'vitest';
import { parseJsonColumn } from '../../common/json';
import type { PoisonMarker } from '../../planner';
import type { JmapInvocation, JmapResponse } from '../../types';
import {
  addDeviceContact,
  addServerCards,
  CALENDAR_AUTHORITY,
  CONTACTS_AUTHORITY,
  createHarness,
  CrashError,
  renameDeviceContact,
  REGISTRY_ID,
  type Harness,
} from './harness';

const FINAL = ['Ada King', 'Grace Hopper', 'Hedy', 'Margaret'];

/** Work on both sides: device edit, create and delete; server update, create and delete. */
async function scenario(options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
  const h = createHarness(options);
  const [, grace, , katherine] = addServerCards(h, ['Ada', 'Grace', 'Linus', 'Katherine']);
  await h.run();
  renameDeviceContact(h, h.contactNamed('Ada')!.id, 'Ada King');
  addDeviceContact(h, 'Hedy');
  h.device.user.deleteContact(h.contactNamed('Linus')!.id);
  h.server.serverUpdate('ContactCard', 'a', grace, { 'name/full': 'Grace Hopper' });
  addServerCards(h, ['Margaret']);
  h.server.serverDestroy('ContactCard', 'a', katherine);
  h.checkpoints.count = 0;
  h.batches.applied = 0;
  return h;
}

/** Both sides hold exactly the expected contacts, once each, and nothing waits for an upload. */
function expectConverged(h: Harness, names = FINAL): void {
  const device = h.contacts();
  expect(device.map((c) => c.name).sort()).toEqual(names);
  expect(device.every((c) => !c.dirty && !c.deleted && c.sourceId)).toBe(true);
  expect(h.serverNames()).toEqual(names);
  const refs = device.map((c) => c.sourceId);
  expect(new Set(refs).size).toBe(refs.length);
  for (const contact of device) {
    const card = h.server.get('ContactCard', 'a', contact.sourceId!.split('/')[1]);
    expect((card?.name as { full: string }).full).toBe(contact.name);
  }
  const uids = h.server.all('ContactCard', 'a').map((c) => c.uid);
  expect(new Set(uids).size).toBe(uids.length);
}

describe('device sync engine: crashes and lost responses', () => {
  it('converges after a crash at any checkpoint, with no duplicates and no lost edits', async () => {
    const probe = await scenario();
    await probe.run();
    expectConverged(probe);
    const checkpoints = probe.checkpoints.count;
    expect(checkpoints).toBeGreaterThan(5);

    for (let n = 1; n <= checkpoints; n++) {
      const h = await scenario();
      h.checkpoints.crashAt = n;
      const crashed = await h.run();
      expect(crashed.outcome, `crash at checkpoint ${n}`).toBe('internal');
      h.checkpoints.crashAt = null;
      const report = await h.run();
      expect(report.outcome, `after a crash at checkpoint ${n}`).toBe('ok');
      expectConverged(h);
    }
  });

  it('converges after a crash after any number of provider batches', async () => {
    const probe = await scenario();
    await probe.run();
    const batches = probe.batches.applied;
    expect(batches).toBeGreaterThan(3);

    for (let n = 0; n < batches; n++) {
      const h = await scenario();
      h.batches.crashAfter = n;
      await h.run();
      h.batches.crashAfter = null;
      const report = await h.run();
      expect(report.outcome, `after a crash following batch ${n}`).toBe('ok');
      expectConverged(h);
    }
  });

  it('converges when the server applied any request but its response was lost', async () => {
    const probe = await scenario();
    const before = probe.server.requests.length;
    await probe.run();
    const requests = probe.server.requests.length - before;

    for (let n = 1; n <= requests; n++) {
      const h = await scenario();
      // The uid index lags behind, as on Stalwart: a lookup right after the lost create misses it.
      h.server.setUidIndexLag(2);
      let seen = 0;
      const stop = h.server.onBeforeRequest(() => {
        if (++seen === n) h.server.applyThenLoseResponse();
      });
      const lost = await h.run();
      stop();
      expect(lost.outcome, `lost response ${n}`).toBe('io');
      const report = await h.run();
      expect(report.outcome, `after losing response ${n}`).toBe('ok');
      expectConverged(h);
    }
  });

  it('converges from a crash anywhere in a first sync (a checkpointed full reconcile)', async () => {
    const names = Array.from({ length: 120 }, (_, i) => `P${String(i).padStart(3, '0')}`);
    const fresh = () => {
      const h = createHarness();
      addServerCards(h, names);
      return h;
    };
    const probe = fresh();
    await probe.run();
    const checkpoints = probe.checkpoints.count;

    for (let n = 1; n <= checkpoints; n += 2) {
      const h = fresh();
      h.checkpoints.crashAt = n;
      await h.run();
      h.checkpoints.crashAt = null;
      expect((await h.run()).outcome).toBe('ok');
      expect(h.contacts().map((c) => c.name).sort()).toEqual(names);
      expect(new Set(h.contacts().map((c) => c.sourceId)).size).toBe(120);
    }
  });

  it('resumes a reconcile after its last stored chunk instead of starting over', async () => {
    const names = Array.from({ length: 150 }, (_, i) => `P${String(i).padStart(3, '0')}`);
    const h = createHarness();
    addServerCards(h, names);
    // Batches: the Settings row, the reconcile marker, then one per chunk of 50. Stop after the second chunk.
    h.batches.crashAfter = 4;
    await h.run();
    const marker = h.state()?.accounts.a.reconcile;
    expect(marker).toMatchObject({ phase: 'objects', position: 100 });
    h.batches.crashAfter = null;
    const gets = h.server.calls('ContactCard/get').length;

    await h.run();

    const fetched = h.server
      .calls('ContactCard/get')
      .slice(gets)
      .filter(([, args]) => (args.properties as string[]).includes('name'))
      .flatMap(([, args]) => args.ids as string[]);
    expect(fetched).toHaveLength(50);
    expect(h.contacts()).toHaveLength(150);
    expect(h.state()?.accounts.a.reconcile).toBeNull();
  });

  it('adopts its own create whose response was lost instead of creating it twice', async () => {
    const h = createHarness();
    addServerCards(h, ['Ada']);
    await h.run();
    h.server.setUidIndexLag(3);
    const id = addDeviceContact(h, 'Hedy');
    h.server.applyThenLoseResponse({ match: 'ContactCard/set' });

    expect((await h.run()).outcome).toBe('io');
    expect(h.serverNames()).toEqual(['Ada', 'Hedy']);
    expect(h.contacts().find((c) => c.id === id)?.sourceId).toBeNull();

    expect((await h.run()).outcome).toBe('ok');
    expect(h.serverNames()).toEqual(['Ada', 'Hedy']);
    expect(h.contacts().find((c) => c.id === id)).toMatchObject({ name: 'Hedy', dirty: false, sourceId: expect.stringMatching(/^a\//) });
    expect(h.contacts()).toHaveLength(2);
  });

  it("adopts the card a duplicate-uid error names (the client's automatic retry of a create)", async () => {
    const h = createHarness();
    await h.run();
    addDeviceContact(h, 'Hedy');
    // The first attempt was applied; the retry answers with Stalwart's duplicate-uid error.
    const port = h.server.port();
    let retried = false;
    h.deps.jmap = async () => ({
      origin: 'https://mail.example.com',
      port: {
        ...port,
        request: async (calls: JmapInvocation[], using: string[]): Promise<JmapResponse> => {
          const response = await port.request(calls, using);
          const [name, args] = response.methodResponses[0];
          if (retried || name !== 'ContactCard/set' || !args.created) return response;
          retried = true;
          const [[key, created]] = Object.entries(args.created as Record<string, { id: string }>);
          const uid = (calls[0][1].create as Record<string, { uid: string }>)[key].uid;
          const notCreated = {
            [key]: { type: 'invalidProperties', properties: ['uid'], description: `Contact with UID ${uid} already exists with id ${created.id}.` },
          };
          return { ...response, methodResponses: [[name, { ...args, created: undefined, notCreated }, response.methodResponses[0][2]]] };
        },
      },
    });

    const report = await h.run();

    expect(report.outcome).toBe('ok');
    expect(retried).toBe(true);
    expect(h.serverNames()).toEqual(['Hedy']);
    expect(h.contacts()).toEqual([expect.objectContaining({ name: 'Hedy', dirty: false, sourceId: expect.stringMatching(/^a\//) })]);
  });
});

describe('device sync engine: server trouble', () => {
  it('downloads again and retries the upload after a stateMismatch', async () => {
    const h = createHarness();
    const [ada, grace] = addServerCards(h, ['Ada', 'Grace']);
    await h.run();
    renameDeviceContact(h, h.contactNamed('Ada')!.id, 'Ada King');
    let sets = 0;
    const stop = h.server.onBeforeRequest((request) => {
      // Another client writes right before our first upload.
      if (request.methods.includes('ContactCard/set') && ++sets === 1) {
        h.server.serverUpdate('ContactCard', 'a', grace, { 'name/full': 'Grace Hopper' });
      }
    });

    const report = await h.run();
    stop();

    expect(report.outcome).toBe('ok');
    const set = h.server.requests.filter((r) => r.methods.includes('ContactCard/set'));
    expect(set[0].responses?.[0]).toEqual(['error', { type: 'stateMismatch' }, 's']);
    expect(h.server.get('ContactCard', 'a', ada)).toMatchObject({ name: { full: 'Ada King' } });
    expect(h.contacts().map((c) => c.name).sort()).toEqual(['Ada King', 'Grace Hopper']);
  });

  it('gives up with io and no progress when the server keeps changing', async () => {
    const h = createHarness();
    const [, grace] = addServerCards(h, ['Ada', 'Grace']);
    await h.run();
    renameDeviceContact(h, h.contactNamed('Ada')!.id, 'Ada King');
    let n = 0;
    const stop = h.server.onBeforeRequest((request) => {
      if (request.methods.includes('ContactCard/set')) h.server.serverUpdate('ContactCard', 'a', grace, { 'name/full': `Grace ${++n}` });
    });

    const report = await h.run();
    stop();

    expect(report.outcome).toBe('io');
    expect(report.stats.downloaded).toEqual({ created: 0, updated: 0, deleted: 0 });
    expect(n).toBe(4);
    expect(h.contactNamed('Ada King')?.dirty).toBe(true);
  });

  it('holds back the uploads of an account that refuses writes, and uploads the other accounts', async () => {
    const h = createHarness({ accounts: 'withShared' });
    const teamBook = h.server.all('AddressBook', 'team')[0].id as string;
    h.prefs.contactsSelection[`team/${teamBook}`] = true;
    addServerCards(h, ['Ada']);
    const [mate] = addServerCards(h, ['Teammate'], 'team', teamBook);
    await h.run();
    renameDeviceContact(h, h.contactNamed('Ada')!.id, 'Ada King');
    renameDeviceContact(h, h.contactNamed('Teammate')!.id, 'Team mate');
    h.server.failNextMethod('ContactCard/set', { type: 'accountReadOnly' }, { accountId: 'team' });

    const report = await h.run();

    expect(report.outcome).toBe('ok');
    expect(report.itemErrors).toEqual([expect.objectContaining({ ref: 'team', type: 'accountReadOnly' })]);
    expect(h.serverNames()).toEqual(['Ada King']);
    expect(h.server.get('ContactCard', 'team', mate)).toMatchObject({ name: { full: 'Teammate' } });
    expect(h.contactNamed('Team mate')?.dirty).toBe(true);

    await h.run();
    expect(h.server.get('ContactCard', 'team', mate)).toMatchObject({ name: { full: 'Team mate' } });
  });

  it('reports a 429 as io with delayUntil from Retry-After', async () => {
    const h = createHarness();
    await h.run();
    h.server.failNextRequest('rateLimit', { retryAfterMs: 120_000 });

    const report = await h.run();

    expect(report.outcome).toBe('io');
    expect(report.delayUntil).toBe(Math.ceil((h.clock.now + 120_000) / 1000));
  });

  it('rebuilds the client once when the server rejects the credentials, then reports auth', async () => {
    const h = createHarness();
    addServerCards(h, ['Ada']);
    h.server.failNextRequest('auth');
    expect((await h.run()).outcome).toBe('ok');
    expect(h.deps.notifyAuthProblem).not.toHaveBeenCalled();

    h.server.failNextRequest('auth', { times: 2 });
    const report = await h.run();

    expect(report.outcome).toBe('auth');
    expect(h.deps.notifyAuthProblem).toHaveBeenCalledWith(REGISTRY_ID, 'alice@example.com', CONTACTS_AUTHORITY);
    expect(h.contacts()).toHaveLength(1);
  });

  it('reports auth without touching anything when the account has no stored credentials', async () => {
    const h = createHarness();
    addServerCards(h, ['Ada']);
    await h.run();
    const writes = h.batches.log.length;
    h.deps.jmap = async () => {
      const error = new Error('No usable credentials for this account');
      error.name = 'AuthenticationError';
      throw error;
    };

    const report = await h.run();

    expect(report.outcome).toBe('auth');
    expect(h.batches.log.length).toBe(writes);
  });

  it('full-reconciles an account after cannotCalculateChanges', async () => {
    const h = createHarness();
    const [ada, grace] = addServerCards(h, ['Ada', 'Grace', 'Linus']);
    await h.run();
    h.server.serverUpdate('ContactCard', 'a', ada, { 'name/full': 'Ada King' });
    h.server.serverDestroy('ContactCard', 'a', grace);
    h.server.truncateChangeLog('a', 'contacts');

    const report = await h.run();

    expect(report.outcome).toBe('ok');
    expect(h.server.requests.some((r) => r.responses?.some(([, args]) => (args as { type?: string }).type === 'cannotCalculateChanges'))).toBe(true);
    expect(h.contacts().map((c) => c.name).sort()).toEqual(['Ada King', 'Linus']);
    expect(h.state()?.accounts.a).toMatchObject({ reconcile: null, itemsState: h.server.state('ContactCard', 'a') });
  });

  it('stops a reconcile that finds an empty server while the device is full (safetyAbort)', async () => {
    const h = createHarness();
    const ids = addServerCards(h, Array.from({ length: 12 }, (_, i) => `P${i}`));
    await h.run();
    for (const id of ids) h.server.serverDestroy('ContactCard', 'a', id);
    h.server.truncateChangeLog('a', 'contacts');

    const report = await h.run();

    expect(report.outcome).toBe('safetyAbort');
    expect(h.contacts()).toHaveLength(12);
  });
});

describe('device sync engine: time and cancellation', () => {
  it('stops cleanly near the deadline and asks for another sync', async () => {
    const h = createHarness();
    addServerCards(h, Array.from({ length: 150 }, (_, i) => `P${i}`));
    h.checkpoints.onCheckpoint = (n) => {
      // Time runs out in the middle of the download.
      if (n === 4) h.clock.now += 9 * 60_000;
    };

    const report = await h.run();

    expect(report).toMatchObject({ outcome: 'cancelled', moreRecordsToGet: true });
    expect(h.contacts().length).toBeGreaterThan(0);
    expect(h.contacts().length).toBeLessThan(150);
    h.checkpoints.onCheckpoint = undefined;

    expect((await h.run()).outcome).toBe('ok');
    expect(h.contacts()).toHaveLength(150);
  });

  it('stops at the next checkpoint when the framework cancels the run', async () => {
    const h = createHarness();
    addServerCards(h, Array.from({ length: 150 }, (_, i) => `P${i}`));
    h.deps.isCancelled = async () => true;

    const report = await h.run();

    expect(report).toMatchObject({ outcome: 'cancelled', moreRecordsToGet: true });
    expect(h.contacts()).toHaveLength(0);
  });

  it('sends Core/echo when a local phase went 40 s without a JMAP request', async () => {
    const h = createHarness();
    addServerCards(h, Array.from({ length: 120 }, (_, i) => `P${i}`));
    let n = 0;
    const port = h.deps.provider;
    h.deps.provider = (name, authority) => {
      const inner = port(name, authority);
      return {
        ...inner,
        applyBatch: async (ops) => {
          h.clock.now += 45_000;
          n++;
          return inner.applyBatch(ops);
        },
      };
    };

    await h.run();

    expect(n).toBeGreaterThan(2);
    expect(h.server.calls('Core/echo').length).toBeGreaterThan(0);
  });

  it('runs one sync of an account and authority at a time', async () => {
    const h = createHarness();
    addServerCards(h, Array.from({ length: 60 }, (_, i) => `P${i}`));

    const [first, second] = await Promise.all([h.run(), h.run()]);

    expect([first.outcome, second.outcome]).toEqual(['ok', 'ok']);
    expect(h.server.maxInFlight).toBe(1);
    expect(h.contacts()).toHaveLength(60);
  });
});

describe('device sync engine: poisoned items', () => {
  it('backs a refused item off, retries it after the back-off, and at once when it changes', async () => {
    const h = createHarness();
    const [ada] = addServerCards(h, ['Ada', 'Grace']);
    await h.run();
    const id = h.contactNamed('Ada')!.id;
    renameDeviceContact(h, id, 'Ada King');
    h.server.setErrorFor('ContactCard', 'a', (t) => t.op === 'update' && t.id === ada, {
      type: 'invalidProperties',
      properties: ['name'],
      description: 'Invalid property.',
    }, 3);

    const first = await h.run();

    expect(first.outcome).toBe('ok');
    expect(first.stats.skipped).toBe(1);
    expect(first.itemErrors).toEqual([
      expect.objectContaining({ ref: `a/${ada}`, side: 'upload', type: 'invalidProperties', retryAt: h.clock.now + 3_600_000 }),
    ]);
    const marker = parseJsonColumn<PoisonMarker>(h.contacts().find((c) => c.id === id)!.row.sync4);
    expect(marker).toMatchObject({ type: 'invalidProperties', n: 1, until: h.clock.now + 3_600_000 });

    // Not retried hot.
    const sets = h.server.calls('ContactCard/set').length;
    const again = await h.run();
    expect(h.server.calls('ContactCard/set').length).toBe(sets);
    expect(again.itemErrors).toEqual([expect.objectContaining({ type: 'invalidProperties' })]);

    // Retried once the back-off is over; refused again, the back-off doubles.
    h.clock.now += 3_600_001;
    await h.run();
    expect(h.server.calls('ContactCard/set').length).toBe(sets + 1);
    expect(parseJsonColumn<PoisonMarker>(h.contacts().find((c) => c.id === id)!.row.sync4)).toMatchObject({ n: 2, until: h.clock.now + 7_200_000 });

    // Changed by the user: retried at once (the server refuses once more), then accepted.
    renameDeviceContact(h, id, 'Ada, Countess');
    await h.run();
    expect(h.server.calls('ContactCard/set').length).toBe(sets + 2);
    renameDeviceContact(h, id, 'Ada Lovelace');
    const fixed = await h.run();
    expect(fixed.itemErrors).toEqual([]);
    expect(h.server.get('ContactCard', 'a', ada)).toMatchObject({ name: { full: 'Ada Lovelace' } });
    expect(h.contacts().find((c) => c.id === id)!.row.sync4).toBeNull();
  });

  it('never uploads an item whose rows could not be written until it was fetched again', async () => {
    const h = createHarness();
    const [ada] = addServerCards(h, ['Ada']);
    await h.run();
    h.server.serverUpdate('ContactCard', 'a', ada, { 'name/full': 'Ada King' });
    // The provider refuses the item's rows (in its batch and alone): it goes on `stale`, the state still moves on.
    const provider = h.deps.provider;
    let refusals = 2;
    h.deps.provider = (name, authority) => {
      const port = provider(name, authority);
      return {
        ...port,
        applyBatch: async (ops) =>
          refusals > 0 && ops.some((op) => op.op === 'update' && op.table === 'data') && refusals--
            ? { ok: false, reason: 'provider', message: 'SQLiteException' }
            : port.applyBatch(ops),
      };
    };
    const failing = await h.run();
    expect(refusals).toBe(0);
    expect(failing.itemErrors).toEqual([expect.objectContaining({ ref: `a/${ada}`, side: 'download', type: 'provider' })]);
    expect(h.state()?.accounts.a.stale).toEqual([ada]);
    expect(h.state()?.accounts.a.itemsState).toBe(h.server.state('ContactCard', 'a'));

    const next = await h.run();

    expect(next.outcome).toBe('ok');
    expect(h.contacts().map((c) => c.name)).toEqual(['Ada King']);
    expect(h.state()?.accounts.a.stale).toEqual([]);
  });
});

describe('device sync engine: planner failures', () => {
  it('keeps syncing everything else when a planner throws on one item, and tries that one again next run', async () => {
    const h = createHarness();
    const [, grace] = addServerCards(h, ['Ada', 'Grace', 'Linus']);
    let broken = true;
    const planner = h.deps.planners.contacts;
    h.deps.planners = {
      ...h.deps.planners,
      contacts: {
        ...planner,
        planDownload: (card, local, ctx) => {
          if (broken && card.id === grace) throw new TypeError('cannot read the card');
          return planner.planDownload(card, local, ctx);
        },
        planUpload: (local, ctx) => {
          if (broken && local.rows.some((r) => r.cells.data1 === 'Hedy')) throw new TypeError('cannot read the rows');
          return planner.planUpload(local, ctx);
        },
      },
    };
    addDeviceContact(h, 'Hedy');
    addDeviceContact(h, 'Mary');

    const report = await h.run();

    expect(report.outcome).toBe('ok');
    expect(report.itemErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ref: `a/${grace}`, side: 'download', type: 'plannerError' }),
        expect.objectContaining({ side: 'upload', type: 'plannerError' }),
      ]),
    );
    expect(h.contacts().map((c) => c.name).sort()).toEqual(['Ada', 'Hedy', 'Linus', 'Mary']);
    expect(h.serverNames()).toEqual(['Ada', 'Grace', 'Linus', 'Mary']);
    // The reconcile completed past the item that could not be planned.
    expect(h.state()?.accounts.a).toMatchObject({ stale: [grace], reconcile: null, itemsState: expect.any(String) });

    broken = false;
    expect((await h.run()).itemErrors).toEqual([]);
    expect(h.contacts().map((c) => c.name).sort()).toEqual(['Ada', 'Grace', 'Hedy', 'Linus', 'Mary']);
    expect(h.serverNames()).toEqual(['Ada', 'Grace', 'Hedy', 'Linus', 'Mary']);
    expect(h.state()?.accounts.a.stale).toEqual([]);
  });
});

describe('device sync engine: deletion guards', () => {
  async function withDeletions(total: number, deleted: number): Promise<Harness> {
    const h = createHarness();
    addServerCards(h, Array.from({ length: total }, (_, i) => `P${String(i).padStart(3, '0')}`));
    await h.run();
    for (const contact of h.contacts().slice(0, deleted)) h.device.user.deleteContact(contact.id);
    return h;
  }

  it('holds every deletion back above 50 and 20 % (tooManyDeletions)', async () => {
    const h = await withDeletions(100, 55);

    const report = await h.run();

    expect(report).toMatchObject({ outcome: 'tooManyDeletions', tooManyDeletions: { count: 55, threshold: 50 } });
    expect(h.serverNames()).toHaveLength(100);
    expect(h.contacts().filter((c) => c.deleted)).toHaveLength(55);
  });

  it('uploads the deletions when the run overrides the threshold', async () => {
    const h = await withDeletions(100, 55);

    const report = await h.run(CONTACTS_AUTHORITY, { overrideTooManyDeletions: true });

    expect(report.outcome).toBe('ok');
    expect(report.stats.uploaded.deleted).toBe(55);
    expect(h.serverNames()).toHaveLength(45);
    expect(h.contacts()).toHaveLength(45);
  });

  it('restores the deleted contacts from the server when the run discards the deletions', async () => {
    const h = await withDeletions(100, 55);

    const discard = await h.run(CONTACTS_AUTHORITY, { discardLocalDeletions: true });
    expect(discard.outcome).toBe('ok');
    expect(h.serverNames()).toHaveLength(100);

    const next = await h.run(CONTACTS_AUTHORITY, { upload: true });
    expect(next.outcome).toBe('ok');
    expect(h.contacts()).toHaveLength(100);
    expect(h.contacts().every((c) => !c.deleted && !c.dirty)).toBe(true);
  });

  it('uploads deletions below the threshold', async () => {
    const h = await withDeletions(100, 20);

    const report = await h.run();

    expect(report.outcome).toBe('ok');
    expect(h.serverNames()).toHaveLength(80);
  });

  it('counts groups an app hard-deleted, found by their absence', async () => {
    const h = createHarness();
    const group = h.server.addCard('a', { uid: 'g1', kind: 'group', name: { full: 'Friends' } });
    addServerCards(h, ['Ada']);
    await h.run();

    h.device.user.fossifyDeleteGroup(Number(h.device.rows('groups')[0]._id));
    const report = await h.run();

    expect(report.stats.uploaded.deleted).toBe(1);
    expect(h.server.get('ContactCard', 'a', group)).toBeUndefined();
    expect(h.state()?.accounts.a.groups).toEqual([]);
  });

  it('fails a crash-free run with CrashError only when injected', () => {
    expect(new CrashError('x').name).toBe('CrashError');
  });
});

describe('device sync engine: accounts that refuse access', () => {
  // Stalwart lists an account shared for mail only with every capability,
  // and its /get calls answer `forbidden`.
  it('syncs the personal account when a shared one refuses to list its address books', async () => {
    const h = createHarness({ accounts: 'withShared' });
    addServerCards(h, ['Ada']);
    h.server.failNextMethod('AddressBook/get', { type: 'forbidden', description: 'You do not have access to account team' }, { accountId: 'team' });

    const report = await h.run();

    expect(report.outcome).toBe('ok');
    expect(report.itemErrors).toEqual([]);
    expect(h.contactNamed('Ada')).toBeDefined();
  });

  it('keeps the contacts of an account that stops listing its address books, and syncs it again once it does', async () => {
    const h = createHarness({ accounts: 'withShared' });
    const teamBook = h.server.all('AddressBook', 'team')[0].id as string;
    h.prefs.contactsSelection[`team/${teamBook}`] = true;
    const [mate] = addServerCards(h, ['Teammate'], 'team', teamBook);
    await h.run();
    expect(h.contactNamed('Teammate')).toBeDefined();

    addServerCards(h, ['Ada']);
    h.server.serverUpdate('ContactCard', 'team', mate, { 'name/full': 'Team mate' });
    h.server.failNextMethod('AddressBook/get', { type: 'forbidden' }, { accountId: 'team' });
    const report = await h.run();

    expect(report.outcome).toBe('ok');
    expect(h.contactNamed('Ada')).toBeDefined();
    expect(h.contactNamed('Teammate')).toBeDefined();

    expect((await h.run()).itemErrors).toEqual([]);
    expect(h.contactNamed('Team mate')).toBeDefined();
  });

  it('keeps the calendar and events of an account that refuses to list its calendars', async () => {
    const h = createHarness({ accounts: 'withShared' });
    const teamCalendar = h.server.all('Calendar', 'team')[0].id as string;
    h.prefs.calendarSelection[`team/${teamCalendar}`] = true;
    h.server.addEvent('team', {
      uid: 'uid-team',
      title: 'Team meeting',
      start: '2026-09-28T09:00:00',
      duration: 'PT1H',
      timeZone: 'Etc/UTC',
      calendarIds: { [teamCalendar]: true },
    });
    await h.run(CALENDAR_AUTHORITY);
    expect(h.events()).toHaveLength(1);

    h.server.failNextMethod('Calendar/get', { type: 'forbidden' }, { accountId: 'team' });
    const report = await h.run(CALENDAR_AUTHORITY);

    expect(report.outcome).toBe('ok');
    expect(report.itemErrors).toEqual([]);
    expect(h.events()).toHaveLength(1);
    expect(h.device.rows('calendars').some((c) => c._sync_id === `team/${teamCalendar}`)).toBe(true);
  });
});
