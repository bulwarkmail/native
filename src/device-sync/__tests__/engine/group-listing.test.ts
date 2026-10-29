// SyncState.groups lists the group cards present on the device, so a group an
// app hard-deleted (Fossify) is found by its absence and deleted on the server.
// The list must change in the same batch as the rows: a group row the engine
// removed but still listed reads as a hard delete and destroys the card, and a
// row it inserted but never listed hides a later hard delete.

import { describe, expect, it } from 'vitest';
import { MimeType } from '../../android-columns';
import { calendarPlanner } from '../../calendar/planner';
import { contactsPlanner } from '../../contacts/planner';
import { serializeSyncState } from '../../engine/sync-state';
import { addServerCards, ANDROID_ACCOUNT, CONTACTS_AUTHORITY, createHarness, RUN_BUDGET, type Harness } from './harness';

function real(): Harness {
  const h = createHarness();
  h.deps.planners = { contacts: contactsPlanner, calendar: calendarPlanner };
  return h;
}

/** The personal book with Ada, and a Work book with Boss, Colleague and the group "Team" (Boss). */
async function withWorkGroup() {
  const h = real();
  const work = h.server.addAddressBook('a', { name: 'Work' });
  addServerCards(h, ['Ada']);
  const [boss] = addServerCards(h, ['Boss', 'Colleague'], 'a', work);
  const bossUid = h.server.get('ContactCard', 'a', boss)!.uid as string;
  const group = h.server.addCard('a', {
    uid: 'g-team',
    kind: 'group',
    name: { full: 'Team' },
    addressBookIds: { [work]: true },
    members: { [bossUid]: true },
  });
  expect((await h.run()).outcome).toBe('ok');
  expect(h.state()?.accounts.a.groups).toEqual([`a/${group}`]);
  h.checkpoints.count = 0;
  return { h, group, work };
}

/** Replaces the stored SyncState's `groups` of account `a` (a list that drifted from the rows). */
async function storeGroups(h: Harness, groups: string[]): Promise<void> {
  const state = h.state()!;
  state.accounts.a.groups = groups;
  await h.device.port(ANDROID_ACCOUNT, CONTACTS_AUTHORITY).applyBatch([{ op: 'syncState', value: serializeSyncState(state) }]);
}

describe('device sync engine: the groups a SyncState lists', () => {
  it('keeps a group card on the server after a deselection stopped at any checkpoint', async () => {
    const probe = await withWorkGroup();
    probe.h.prefs.contactsSelection[`a/${probe.work}`] = false;
    await probe.h.run();
    const total = probe.h.checkpoints.count;
    expect(probe.h.server.get('ContactCard', 'a', probe.group)).toBeDefined();

    for (let n = 1; n <= total; n++) {
      const { h, group, work } = await withWorkGroup();
      h.prefs.contactsSelection[`a/${work}`] = false;
      h.checkpoints.crashAt = n;
      await h.run();
      h.checkpoints.crashAt = null;
      expect((await h.run()).outcome, `run after a crash at checkpoint ${n}`).toBe('ok');
      expect(h.server.get('ContactCard', 'a', group), `group card after a crash at checkpoint ${n}`).toBeDefined();
      expect(h.device.rows('groups')).toEqual([]);
      expect(h.state()?.accounts.a.groups).toEqual([]);
    }
  });

  it('keeps a group card on the server when its book is selected again after a stopped deselection', async () => {
    const { h, group, work } = await withWorkGroup();
    h.prefs.contactsSelection[`a/${work}`] = false;
    // Checkpoint 3 comes right after the deselected book's group rows went.
    h.checkpoints.crashAt = 3;
    await h.run();
    h.checkpoints.crashAt = null;
    expect(h.device.rows('groups')).toEqual([]);

    h.prefs.contactsSelection[`a/${work}`] = true;
    const report = await h.run();

    expect(report).toMatchObject({ outcome: 'ok', stats: { uploaded: { deleted: 0 } } });
    expect(h.server.get('ContactCard', 'a', group)).toBeDefined();
  });

  it('keeps a group card on the server when sync is turned off while a deselection drops it', async () => {
    const { h, group, work } = await withWorkGroup();
    h.prefs.contactsSelection[`a/${work}`] = false;
    let teardown: Promise<{ pending: number }> | null = null;
    h.checkpoints.onCheckpoint = (n) => {
      // Right before the run drops the deselected book's rows.
      if (n === 2 && !teardown) teardown = h.teardown(CONTACTS_AUTHORITY);
    };

    const run = await h.run();
    h.checkpoints.onCheckpoint = undefined;

    expect(run.outcome).toBe('cancelled');
    expect(await teardown!).toEqual({ pending: 0 });
    expect(h.contacts()).toHaveLength(0);
    expect(h.server.get('ContactCard', 'a', group)).toBeDefined();
  });

  it('keeps a group card on the server when the deselecting run runs out of time after dropping the group', async () => {
    const { h, group, work } = await withWorkGroup();
    h.prefs.contactsSelection[`a/${work}`] = false;
    h.checkpoints.onCheckpoint = (n) => {
      if (n === 2) h.clock.now += RUN_BUDGET;
    };

    expect((await h.run()).outcome).toBe('cancelled');
    h.checkpoints.onCheckpoint = undefined;
    expect((await h.run()).outcome).toBe('ok');

    expect(h.server.get('ContactCard', 'a', group)).toBeDefined();
  });

  it('keeps a group card the server moved to a book that does not sync when the run stops within the page', async () => {
    const h = real();
    const archive = h.server.addAddressBook('a', { name: 'Archive' });
    h.prefs.contactsSelection[`a/${archive}`] = false;
    const ids = addServerCards(h, Array.from({ length: 60 }, (_, i) => `P${String(i).padStart(2, '0')}`));
    const group = h.server.addCard('a', { uid: 'g-team', kind: 'group', name: { full: 'Team' }, addressBookIds: { [h.book]: true }, members: {} });
    await h.run();
    expect(h.device.rows('groups')).toHaveLength(1);
    // Another client moves the group to Archive and renames 60 contacts: one /changes page, several chunks.
    h.server.serverUpdate('ContactCard', 'a', group, { addressBookIds: { [archive]: true } });
    ids.forEach((id, i) => h.server.serverUpdate('ContactCard', 'a', id, { 'name/full': `Q${i}` }));
    // Checkpoints: 'changes', 'download' (the group's chunk), 'download' (the first contacts chunk) …
    h.checkpoints.count = 0;
    h.checkpoints.crashAt = 3;

    await h.run();
    h.checkpoints.crashAt = null;
    expect(h.device.rows('groups')).toHaveLength(0);
    expect((await h.run()).outcome).toBe('ok');

    expect(h.server.get('ContactCard', 'a', group)).toBeDefined();
    expect(h.state()?.accounts.a.groups).toEqual([]);
  });

  it('lists a group written before an interruption, so a hard delete by an app still reaches the server', async () => {
    const h = real();
    addServerCards(h, Array.from({ length: 60 }, (_, i) => `P${String(i).padStart(2, '0')}`));
    const group = h.server.addCard('a', { uid: 'g1', kind: 'group', name: { full: 'Friends' }, members: {} });
    // First sync: 'reconcile', 'reconcile:ids', 'reconcile:objects' (the group's chunk), then out of time.
    h.checkpoints.onCheckpoint = (n) => {
      if (n === 3) h.clock.now += RUN_BUDGET;
    };
    expect((await h.run()).outcome).toBe('cancelled');
    h.checkpoints.onCheckpoint = undefined;
    expect(h.device.rows('groups')).toHaveLength(1);
    expect(h.state()?.accounts.a.groups).toEqual([`a/${group}`]);
    expect((await h.run()).outcome).toBe('ok');
    expect(h.contacts()).toHaveLength(60);

    // Fossify hard-deletes the group through a sync-adapter URI.
    h.device.user.fossifyDeleteGroup(Number(h.device.rows('groups')[0]._id));
    expect((await h.run()).outcome).toBe('ok');

    expect(h.server.get('ContactCard', 'a', group)).toBeUndefined();
  });

  it('lists a group again when it comes back as an echo', async () => {
    const h = real();
    const group = h.server.addCard('a', { uid: 'g1', kind: 'group', name: { full: 'Friends' }, members: {} });
    await h.run();
    // A list that lost the group (a write committed without its state op), then a download of the unchanged card.
    await storeGroups(h, []);
    addServerCards(h, ['Ada']);
    h.server.truncateChangeLog('a', 'contacts');
    expect((await h.run()).outcome).toBe('ok');
    expect(h.state()?.accounts.a.groups).toEqual([`a/${group}`]);

    h.device.user.fossifyDeleteGroup(Number(h.device.rows('groups')[0]._id));
    await h.run();

    expect(h.server.get('ContactCard', 'a', group)).toBeUndefined();
  });

  it("moves a group's membership on the device even when time ran out after the group's chunk", async () => {
    const h = real();
    const [ada, grace] = addServerCards(h, ['Ada Lovelace', 'Grace Hopper']);
    const uid = (id: string) => h.server.get('ContactCard', 'a', id)!.uid as string;
    const group = h.server.addCard('a', { uid: 'g1', kind: 'group', name: { full: 'Friends' }, members: { [uid(ada)]: true } });
    await h.run();
    const members = () =>
      h.device.rows('data')
        .filter((d) => d.mimetype === MimeType.GROUP_MEMBERSHIP)
        .map((d) => h.contacts().find((c) => c.id === Number(d.raw_contact_id))?.name)
        .sort();
    expect(members()).toEqual(['Ada Lovelace']);
    // Another client moves the membership from Ada to Grace: only the group card changes.
    h.server.serverUpdate('ContactCard', 'a', group, { members: { [uid(grace)]: true } });
    // 'changes', 'download' (the group's chunk), then out of time before the members' chunk.
    h.checkpoints.count = 0;
    h.checkpoints.onCheckpoint = (n) => {
      if (n === 2) h.clock.now += RUN_BUDGET;
    };
    expect((await h.run()).outcome).toBe('cancelled');
    h.checkpoints.onCheckpoint = undefined;

    expect((await h.run()).outcome).toBe('ok');

    expect(members()).toEqual(['Grace Hopper']);
    expect(h.state()?.accounts.a.stale).toEqual([]);
  });

  it('never destroys a listed group card that is in no synced book or no longer a group, and forgets it', async () => {
    const h = real();
    const archive = h.server.addAddressBook('a', { name: 'Archive' });
    h.prefs.contactsSelection[`a/${archive}`] = false;
    const filed = h.server.addCard('a', { uid: 'g1', kind: 'group', name: { full: 'Filed' }, addressBookIds: { [archive]: true }, members: {} });
    const person = h.server.addCard('a', { uid: 'p1', name: { full: 'Was a group' }, addressBookIds: { [h.book]: true } });
    await h.run();
    // The list names both as groups whose rows are gone (the engine removed them, and the batch storing that was lost).
    await storeGroups(h, [`a/${filed}`, `a/${person}`]);

    const report = await h.run();

    expect(report).toMatchObject({ outcome: 'ok', stats: { uploaded: { deleted: 0 } } });
    expect(h.server.get('ContactCard', 'a', filed)).toBeDefined();
    expect(h.server.get('ContactCard', 'a', person)).toBeDefined();
    expect(h.state()?.accounts.a.groups).toEqual([]);
  });
});
