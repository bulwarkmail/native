// Engine runs for contacts against the fake provider and the fake JMAP
// server: first sync, incremental /changes, uploads, echoes, selection
// changes and groups (docs/device-sync.md, "A sync run").

import { describe, expect, it } from 'vitest';
import { Data, MimeType } from '../../android-columns';
import { runDeviceSync } from '../../engine/run';
import {
  addDeviceContact,
  addServerCards,
  ANDROID_ACCOUNT,
  CONTACTS_AUTHORITY,
  createHarness,
  REGISTRY_ID,
  renameDeviceContact,
  RUN_BUDGET,
  rowWrites,
  type Harness,
} from './harness';

function runAs(h: Harness, registryId: string) {
  return runDeviceSync(
    { runId: 'other', accountName: ANDROID_ACCOUNT, registryId, authority: CONTACTS_AUTHORITY, extras: {}, deadline: h.clock.now + RUN_BUDGET },
    h.deps,
  );
}

describe('device sync engine: contacts', () => {
  it('downloads every card of the synced address books on the first sync (a full reconcile)', async () => {
    const h = createHarness();
    addServerCards(h, ['Ada', 'Grace', 'Linus']);

    const report = await h.run();

    expect(report).toMatchObject({ outcome: 'ok', stats: { downloaded: { created: 3, updated: 0, deleted: 0 } } });
    expect(h.contacts().map((c) => c.name).sort()).toEqual(['Ada', 'Grace', 'Linus']);
    expect(h.contacts().every((c) => c.sourceId?.startsWith('a/') && !c.dirty)).toBe(true);
    const state = h.state();
    expect(state?.owner).toEqual({ registryId: REGISTRY_ID, origin: 'https://mail.example.com' });
    expect(state?.accounts.a).toMatchObject({
      itemsState: h.server.state('ContactCard', 'a'),
      reconcile: null,
      selected: [`a/${h.book}`],
      stale: [],
    });
    expect(h.device.rows('settings')).toEqual([expect.objectContaining({ ungrouped_visible: 1, should_sync: 1 })]);
    expect(h.deps.recordStatus).toHaveBeenCalledWith(REGISTRY_ID, CONTACTS_AUTHORITY, expect.objectContaining({ outcome: 'ok' }));
  });

  it('applies server creates, updates and deletes from /changes', async () => {
    const h = createHarness();
    const [ada, grace] = addServerCards(h, ['Ada', 'Grace']);
    await h.run();

    h.server.serverUpdate('ContactCard', 'a', ada, { 'name/full': 'Ada Lovelace' });
    h.server.serverDestroy('ContactCard', 'a', grace);
    addServerCards(h, ['Katherine']);
    const report = await h.run();

    expect(report.stats.downloaded).toEqual({ created: 1, updated: 1, deleted: 1 });
    expect(h.contacts().map((c) => c.name).sort()).toEqual(['Ada Lovelace', 'Katherine']);
    expect(h.server.calls('ContactCard/changes').length).toBeGreaterThan(0);
    expect(h.state()?.accounts.a.itemsState).toBe(h.server.state('ContactCard', 'a'));
  });

  it('pages through /changes and stores the state with every page', async () => {
    const h = createHarness();
    await h.run();
    addServerCards(h, Array.from({ length: 300 }, (_, i) => `Person ${i}`));
    const before = h.server.calls('ContactCard/changes').length;

    const report = await h.run();

    const pages = h.server.calls('ContactCard/changes').slice(before);
    expect(pages.map(([, args]) => args.maxChanges)).toEqual([256, 256]);
    expect(report.stats.downloaded.created).toBe(300);
    expect(h.contacts()).toHaveLength(300);
    // One state op per page, each the last op of its batch.
    const stateBatches = h.batches.log.filter((ops) => ops.some((op) => op.op === 'syncState'));
    for (const ops of stateBatches) expect(ops[ops.length - 1].op).toBe('syncState');
  });

  it('uploads a device edit as a patch and a new device contact as a create with a client uid', async () => {
    const h = createHarness();
    const [ada] = addServerCards(h, ['Ada']);
    await h.run();

    renameDeviceContact(h, h.contactNamed('Ada')!.id, 'Ada King');
    const fresh = addDeviceContact(h, 'Hedy');
    const report = await h.run();

    expect(report).toMatchObject({ outcome: 'ok', stats: { uploaded: { created: 1, updated: 1, deleted: 0 } } });
    expect(h.server.get('ContactCard', 'a', ada)).toMatchObject({ name: { full: 'Ada King' } });
    const created = h.server.all('ContactCard', 'a').find((c) => (c.name as { full: string }).full === 'Hedy')!;
    expect(created.uid).toMatch(/^[0-9a-f-]{36}$/);
    expect(h.contacts().find((c) => c.id === fresh)).toMatchObject({ sourceId: `a/${created.id}`, dirty: false });
    expect(h.contacts().every((c) => !c.dirty)).toBe(true);
    const set = h.server.calls('ContactCard/set');
    expect(set.every(([, args]) => typeof args.ifInState === 'string')).toBe(true);
  });

  it('uploads to an account without any card yet, whose /changes state is spelled differently from its type state', async () => {
    const h = createHarness();
    await h.run();
    addDeviceContact(h, 'Hedy');

    const report = await h.run();

    expect(report.outcome).toBe('ok');
    expect(h.serverNames()).toEqual(['Hedy']);
    expect(h.contacts()).toEqual([expect.objectContaining({ name: 'Hedy', dirty: false, sourceId: expect.stringMatching(/^a\//) })]);
  });

  it('writes nothing but the state when its own upload comes back through /changes (echo)', async () => {
    const h = createHarness();
    addServerCards(h, ['Ada']);
    await h.run();
    renameDeviceContact(h, h.contactNamed('Ada')!.id, 'Ada King');
    addDeviceContact(h, 'Hedy');
    await h.run();
    const before = h.batches.log.length;

    const report = await h.run();

    expect(report.stats.downloaded).toEqual({ created: 0, updated: 0, deleted: 0 });
    expect(rowWrites(h.batches.log.slice(before))).toEqual([]);
    expect(h.contacts().map((c) => c.name).sort()).toEqual(['Ada King', 'Hedy']);
  });

  it('keeps a contact dirty when the user edits it again while its upload is on the way', async () => {
    const h = createHarness();
    const [ada] = addServerCards(h, ['Ada']);
    await h.run();
    const id = h.contactNamed('Ada')!.id;
    renameDeviceContact(h, id, 'Ada King');
    const stop = h.server.onAfterRequest((request) => {
      if (request.methods.includes('ContactCard/set')) renameDeviceContact(h, id, 'Ada, Countess');
    });

    await h.run();
    stop();

    expect(h.server.get('ContactCard', 'a', ada)).toMatchObject({ name: { full: 'Ada King' } });
    expect(h.contacts().find((c) => c.id === id)).toMatchObject({ name: 'Ada, Countess', dirty: true });

    await h.run();

    expect(h.server.get('ContactCard', 'a', ada)).toMatchObject({ name: { full: 'Ada, Countess' } });
    expect(h.contacts().find((c) => c.id === id)).toMatchObject({ dirty: false });
  });

  it('lets the server win a conflicting edit of the same unit and counts it', async () => {
    const h = createHarness();
    const [ada] = addServerCards(h, ['Ada']);
    await h.run();
    renameDeviceContact(h, h.contactNamed('Ada')!.id, 'Ada (device)');
    h.server.serverUpdate('ContactCard', 'a', ada, { 'name/full': 'Ada (server)' });

    const report = await h.run();

    expect(report.conflicts).toBe(1);
    expect(h.contacts().map((c) => c.name)).toEqual(['Ada (server)']);
    expect(h.server.get('ContactCard', 'a', ada)).toMatchObject({ name: { full: 'Ada (server)' } });
  });

  it('deletes on the server what the user deleted, and purges the rows', async () => {
    const h = createHarness();
    const [ada] = addServerCards(h, ['Ada', 'Grace']);
    await h.run();

    h.device.user.deleteContact(h.contactNamed('Ada')!.id);
    const report = await h.run();

    expect(report.stats.uploaded.deleted).toBe(1);
    expect(h.server.get('ContactCard', 'a', ada)).toBeUndefined();
    expect(h.contacts().map((c) => c.name)).toEqual(['Grace']);
  });

  it('drops only the clean rows of a deselected address book, after uploading its dirty ones', async () => {
    const h = createHarness();
    const work = h.server.addAddressBook('a', { name: 'Work' });
    addServerCards(h, ['Ada']);
    const [boss, colleague] = addServerCards(h, ['Boss', 'Colleague'], 'a', work);
    await h.run();
    expect(h.contacts()).toHaveLength(3);

    renameDeviceContact(h, h.contactNamed('Boss')!.id, 'The Boss');
    h.prefs.contactsSelection[`a/${work}`] = false;
    const report = await h.run();

    expect(report.outcome).toBe('ok');
    expect(h.contacts().map((c) => c.name)).toEqual(['Ada']);
    expect(h.server.get('ContactCard', 'a', boss)).toMatchObject({ name: { full: 'The Boss' } });
    expect(h.server.get('ContactCard', 'a', colleague)).toBeDefined();
    expect(h.state()?.accounts.a.selected).toEqual([`a/${h.book}`]);
  });

  it("leaves the webmail's Trusted Senders book off the device unless the user picked it", async () => {
    const h = createHarness();
    const trusted = h.server.addAddressBook('a', { name: 'Trusted Senders' });
    addServerCards(h, ['Ada']);
    addServerCards(h, ['newsletter@example.com'], 'a', trusted);

    await h.run();
    expect(h.contacts().map((c) => c.name)).toEqual(['Ada']);

    h.prefs.contactsSelection[`a/${trusted}`] = true;
    await h.run();
    expect(h.contacts().map((c) => c.name).sort()).toEqual(['Ada', 'newsletter@example.com']);
  });

  it('loads a newly selected address book once the account is up to date', async () => {
    const h = createHarness({ accounts: 'withShared' });
    addServerCards(h, ['Ada']);
    const teamBook = h.server.all('AddressBook', 'team')[0].id as string;
    h.server.addCard('team', { uid: 'u-team', name: { full: 'Teammate' }, addressBookIds: { [teamBook]: true } });
    await h.run();
    expect(h.contacts().map((c) => c.name)).toEqual(['Ada']);

    h.prefs.contactsSelection[`team/${teamBook}`] = true;
    const report = await h.run();

    expect(report.stats.downloaded.created).toBe(1);
    expect(h.contacts().map((c) => c.name).sort()).toEqual(['Ada', 'Teammate']);
    expect(h.contactNamed('Teammate')?.sourceId).toMatch(/^team\//);
    expect(h.state()?.accounts.team.selected).toEqual([`team/${teamBook}`]);
  });

  it('writes group cards before the contacts that are their members', async () => {
    const h = createHarness();
    const [ada] = addServerCards(h, ['Ada']);
    const adaUid = h.server.get('ContactCard', 'a', ada)!.uid as string;
    h.server.addCard('a', { uid: 'g1', kind: 'group', name: { full: 'Friends' }, members: { [adaUid]: true } });

    await h.run();

    const groups = h.device.rows('groups');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ title: 'Friends', group_visible: 1 });
    const memberships = h.device.rows('data').filter((d) => d.mimetype === MimeType.GROUP_MEMBERSHIP);
    expect(memberships).toHaveLength(1);
    // data1 is a TEXT column: the group row id may read back as text.
    expect(String(memberships[0][Data.DATA1])).toBe(String(groups[0]._id));
    expect(memberships[0].group_sourceid).toBe(groups[0].sourceid);
    expect(h.state()?.accounts.a.groups).toEqual([groups[0].sourceid]);
  });

  it("updates a member's rows when only the group card's members changed on the server", async () => {
    const h = createHarness();
    const [ada, grace] = addServerCards(h, ['Ada', 'Grace']);
    const adaUid = h.server.get('ContactCard', 'a', ada)!.uid as string;
    const graceUid = h.server.get('ContactCard', 'a', grace)!.uid as string;
    const group = h.server.addCard('a', { uid: 'g1', kind: 'group', name: { full: 'Friends' }, members: { [adaUid]: true } });
    await h.run();
    const members = () =>
      h.device
        .rows('data')
        .filter((d) => d.mimetype === MimeType.GROUP_MEMBERSHIP)
        .map((d) => h.contacts().find((c) => c.id === Number(d.raw_contact_id))?.name)
        .sort();
    expect(members()).toEqual(['Ada']);

    // Another client moves the membership: only the group card changes.
    h.server.serverUpdate('ContactCard', 'a', group, { members: { [graceUid]: true } });
    await h.run();

    expect(members()).toEqual(['Grace']);
    expect(h.contacts().every((c) => !c.dirty)).toBe(true);
  });

  it('uploads a membership added on the device as a patch of the group card', async () => {
    const h = createHarness();
    const [ada] = addServerCards(h, ['Ada']);
    const group = h.server.addCard('a', { uid: 'g1', kind: 'group', name: { full: 'Friends' }, members: {} });
    await h.run();

    const groupRow = h.device.rows('groups')[0];
    h.device.user.addToGroup(h.contactNamed('Ada')!.id, Number(groupRow._id));
    await h.run();

    const adaUid = h.server.get('ContactCard', 'a', ada)!.uid as string;
    expect(h.server.get('ContactCard', 'a', group)?.members).toEqual({ [adaUid]: true });
    expect(h.contacts().every((c) => !c.dirty)).toBe(true);
  });

  it('skips the network for an upload-only sync with nothing to upload', async () => {
    const h = createHarness();
    addServerCards(h, ['Ada']);
    await h.run();
    const requests = h.server.requests.length;

    const report = await h.run(CONTACTS_AUTHORITY, { upload: true });

    expect(report.outcome).toBe('ok');
    expect(h.server.requests.length).toBe(requests);
  });

  it("keeps the last run's status when an upload-only sync finds nothing to do, moving only its time on", async () => {
    const h = createHarness();
    addServerCards(h, ['Ada']);
    await h.run();
    const status = h.lastStatus()!;
    expect(status).toMatchObject({ outcome: 'ok', stats: { downloaded: { created: 1 } } });

    // The upload sync Android starts right after a manual one: nothing waits on the device.
    h.clock.now += 1_000;
    expect((await h.run(CONTACTS_AUTHORITY, { upload: true })).outcome).toBe('ok');

    expect(h.lastStatus()).toEqual({ ...status, at: h.clock.now });
    // One that has something to upload is a run like any other.
    renameDeviceContact(h, h.contactNamed('Ada')!.id, 'Ada King');
    await h.run(CONTACTS_AUTHORITY, { upload: true });
    expect(h.lastStatus()).toMatchObject({ stats: { downloaded: { created: 0 }, uploaded: { updated: 1 } } });
  });

  it('reports disabled, unsupported and rows of another owner without touching anything', async () => {
    const off = createHarness();
    off.deps.isSyncEnabled = async () => false;
    expect((await off.run()).outcome).toBe('disabled');
    expect(off.server.requests).toHaveLength(0);

    const bare = createHarness();
    const port = bare.server.port();
    bare.deps.jmap = async () => ({
      origin: 'https://mail.example.com',
      port: { ...port, session: () => ({ ...port.session(), primaryAccounts: {}, accounts: {} }) },
    });
    expect((await bare.run()).outcome).toBe('unsupported');

    const other = createHarness();
    addServerCards(other, ['Ada']);
    await other.run();
    other.deps.jmap = async () => ({ port: other.server.port(), origin: 'https://other.example.com' });
    const moved = await other.run();
    expect(moved.outcome).toBe('internal');
    expect(moved.message).toMatch(/another server/);
    expect(other.contacts()).toHaveLength(1);
    const foreign = await runAs(other, 'bob@mail.example.com');
    expect(foreign.outcome).toBe('internal');
    expect(foreign.message).toMatch(/another account/);
  });

  it('keeps one request in flight and stays within the server limits', async () => {
    const h = createHarness();
    h.server.setLimits({ maxObjectsInGet: 20, maxObjectsInSet: 10 });
    addServerCards(h, Array.from({ length: 60 }, (_, i) => `Server ${i}`));
    await h.run();
    for (let i = 0; i < 25; i++) addDeviceContact(h, `Device ${i}`);

    const report = await h.run();

    expect(report.outcome).toBe('ok');
    expect(h.server.maxInFlight).toBe(1);
    for (const [, args] of h.server.calls('ContactCard/get')) {
      expect(Array.isArray(args.ids)).toBe(true);
      expect((args.ids as string[]).length).toBeLessThanOrEqual(20);
    }
    for (const [, args] of h.server.calls('ContactCard/set')) {
      const count = Object.keys(args.create ?? {}).length + Object.keys(args.update ?? {}).length + ((args.destroy as string[]) ?? []).length;
      expect(count).toBeLessThanOrEqual(10);
    }
    expect(h.serverNames()).toHaveLength(85);
    expect(h.contacts()).toHaveLength(85);
    expect(ANDROID_ACCOUNT).toBe('alice@example.com');
  });

  it('packs provider batches of at most 400 ops with a yield point at every group and the state op last', async () => {
    const h = createHarness();
    addServerCards(h, Array.from({ length: 450 }, (_, i) => `Person ${i}`));

    await h.run();

    expect(h.contacts()).toHaveLength(450);
    for (const ops of h.batches.log) {
      expect(ops.length).toBeLessThanOrEqual(400);
      const state = ops.findIndex((op) => op.op === 'syncState');
      if (state >= 0) {
        expect(state).toBe(ops.length - 1);
        expect((ops[state] as { yieldAllowed?: boolean }).yieldAllowed).toBeFalsy();
      }
      // Every download insert starts a group with its "not there yet" guard: a yield point, and nothing inside a group is one.
      ops.forEach((op, i) => {
        if (op.op === 'insert' && op.table === 'raw_contacts') {
          expect(ops[i - 1]).toMatchObject({ op: 'assert', table: 'raw_contacts', expectCount: 0, yieldAllowed: true });
          expect(op.yieldAllowed).toBeFalsy();
        }
      });
    }
  });
});
