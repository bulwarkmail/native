// The contacts planner driven by the engine (fake providers, fake Stalwart):
// cases that only show end to end, over several runs. The planner's rules
// themselves are tested in the other files of this folder.

import { describe, expect, it } from 'vitest';
import { Data, Groups, MimeType } from '../../android-columns';
import { calendarPlanner } from '../../calendar/planner';
import { contactsPlanner } from '../../contacts/planner';
import { addServerCards, ANDROID_ACCOUNT, CONTACTS_AUTHORITY, createHarness, renameDeviceContact, rowWrites, type Harness } from '../engine/harness';
import type { SetTarget } from '../fakes/fake-jmap-server';
import { JPEG } from './fixtures';

function real(options: Parameters<typeof createHarness>[0] = {}): Harness {
  const h = createHarness(options);
  h.deps.planners = { contacts: contactsPlanner, calendar: calendarPlanner };
  return h;
}

function memberships(h: Harness, rawContactId: number) {
  return h.device.rows('data').filter((d) => Number(d.raw_contact_id) === rawContactId && d.mimetype === MimeType.GROUP_MEMBERSHIP);
}

/** An address book of the personal account that this device does not sync. */
function unsyncedBook(h: Harness, name = 'Archive'): string {
  const id = h.server.addAddressBook('a', { name });
  h.prefs.contactsSelection[`a/${id}`] = false;
  return id;
}

describe('contacts through the engine', () => {
  it('keeps a card deleted on the device that the server meanwhile also filed in an unsynced book', async () => {
    const h = real();
    const archive = unsyncedBook(h);
    const [ada] = addServerCards(h, ['Ada Lovelace']);
    expect((await h.run()).outcome).toBe('ok');

    h.device.user.deleteContact(h.contactNamed('Ada Lovelace')!.id);
    h.server.serverUpdate('ContactCard', 'a', ada, { [`addressBookIds/${archive}`]: true });
    const report = await h.run();

    expect(report).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { deleted: 1 } } });
    expect(h.server.get('ContactCard', 'a', ada)).toMatchObject({ addressBookIds: { [archive]: true } });
    expect(h.contacts()).toEqual([]);
  });

  it('keeps a group deleted on the device that the server meanwhile also filed in an unsynced book', async () => {
    const h = real();
    const archive = unsyncedBook(h);
    const group = h.server.addCard('a', { uid: 'g1', kind: 'group', name: { full: 'Friends' }, addressBookIds: { [h.book]: true } });
    expect((await h.run()).outcome).toBe('ok');

    const row = h.device.rows('groups').find((g) => g.sourceid === `a/${group}`)!;
    h.device.user.deleteGroup(Number(row._id));
    h.server.serverUpdate('ContactCard', 'a', group, { [`addressBookIds/${archive}`]: true });
    const report = await h.run();

    expect(report).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { deleted: 1 } } });
    expect(h.server.get('ContactCard', 'a', group)).toMatchObject({ addressBookIds: { [archive]: true } });
    expect(h.device.rows('groups')).toEqual([]);
  });

  it('puts back a membership in a group of another account, so no change waits for ever', async () => {
    const h = real({ accounts: 'withShared' });
    const book = h.server.all('AddressBook', 'team')[0].id as string;
    h.prefs.contactsSelection[`team/${book}`] = true;
    const team = h.server.addCard('team', { uid: 'g-team', kind: 'group', name: { full: 'Team' }, addressBookIds: { [book]: true } });
    addServerCards(h, ['Ada Lovelace']);
    expect((await h.run()).outcome).toBe('ok');

    const ada = h.contactNamed('Ada Lovelace')!.id;
    h.device.user.addToGroup(ada, Number(h.device.rows('groups').find((g) => g.sourceid === `team/${team}`)!._id));
    const report = await h.run();

    expect(report).toMatchObject({ outcome: 'ok', stats: { skipped: 1 } });
    expect(report.itemErrors).toEqual([expect.objectContaining({ side: 'upload', type: 'groupNotWritable' })]);
    expect(h.contactNamed('Ada Lovelace')).toMatchObject({ dirty: false });
    expect(memberships(h, ada)).toEqual([]);
    expect(h.server.get('ContactCard', 'team', team)?.members).toBeUndefined();
    // Turning sync off finds nothing waiting.
    expect(await h.teardown(CONTACTS_AUTHORITY)).toEqual({ pending: 0 });
  });

  it('puts back a membership in a group of a read-only book, so no change waits for ever', async () => {
    const h = real();
    const shared = h.server.addAddressBook('a', { name: 'Shared', myRights: { mayRead: true, mayWrite: false, mayShare: false, mayDelete: false } });
    h.prefs.contactsSelection[`a/${shared}`] = true;
    const team = h.server.addCard('a', { uid: 'g-team', kind: 'group', name: { full: 'Team' }, members: { other: true }, addressBookIds: { [shared]: true } });
    addServerCards(h, ['Ada Lovelace']);
    expect((await h.run()).outcome).toBe('ok');

    const ada = h.contactNamed('Ada Lovelace')!.id;
    h.device.user.addToGroup(ada, Number(h.device.rows('groups').find((g) => g.sourceid === `a/${team}`)!._id));
    const report = await h.run();

    expect(report).toMatchObject({ outcome: 'ok', stats: { skipped: 1 } });
    expect(report.itemErrors).toEqual([expect.objectContaining({ side: 'upload', type: 'groupNotWritable' })]);
    expect(h.contactNamed('Ada Lovelace')).toMatchObject({ dirty: false });
    expect(memberships(h, ada)).toEqual([]);
    expect(h.server.get('ContactCard', 'a', team)?.members).toEqual({ other: true });
    // Turning sync off finds nothing waiting.
    expect(await h.teardown(CONTACTS_AUTHORITY)).toEqual({ pending: 0 });
  });

  it('puts back an edit of a card that is only in a read-only book, without asking the server', async () => {
    const h = real();
    const shared = h.server.addAddressBook('a', { name: 'Shared', myRights: { mayRead: true, mayWrite: false, mayShare: false, mayDelete: false } });
    h.prefs.contactsSelection[`a/${shared}`] = true;
    const [ada] = addServerCards(h, ['Ada Lovelace'], 'a', shared);
    expect((await h.run()).outcome).toBe('ok');

    renameDeviceContact(h, h.contactNamed('Ada Lovelace')!.id, 'Ada King');
    const report = await h.run();

    expect(report).toMatchObject({ outcome: 'ok', stats: { skipped: 1, uploaded: { updated: 0 } } });
    expect(report.itemErrors).toEqual([expect.objectContaining({ side: 'upload', type: 'readOnly' })]);
    expect(h.contactNamed('Ada Lovelace')).toMatchObject({ dirty: false });
    expect(h.server.get('ContactCard', 'a', ada)).toMatchObject({ name: { full: 'Ada Lovelace' } });
  });

  it('puts a contact created on the device into the group it was added to', async () => {
    const h = real();
    const group = h.server.addCard('a', { uid: 'g1', kind: 'group', name: { full: 'Friends' }, members: { other: true }, addressBookIds: { [h.book]: true } });
    expect((await h.run()).outcome).toBe('ok');
    const id = h.device.user.insertContact(ANDROID_ACCOUNT, [
      { [Data.MIMETYPE]: MimeType.STRUCTURED_NAME, [Data.DATA1]: 'New Person' },
      { [Data.MIMETYPE]: MimeType.GROUP_MEMBERSHIP, [Data.DATA1]: Number(h.device.rows('groups')[0]._id) },
    ]);

    expect(await h.run()).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { created: 1, updated: 1 } } });
    const uid = h.server.all('ContactCard', 'a').find((c) => c.kind !== 'group')!.uid as string;
    expect(h.server.get('ContactCard', 'a', group)?.members).toEqual({ other: true, [uid]: true });
    expect(memberships(h, id)).toHaveLength(1);
  });

  it('keeps one row for a small photo the provider stores as its thumbnail, and never deletes it on the server', async () => {
    const h = real();
    const media = { ph: { kind: 'photo', uri: `data:image/jpeg;base64,${JPEG}`, mediaType: 'image/jpeg' } };
    const card = h.server.addCard('a', { uid: 'u-small', name: { full: 'Photo Smalltest' }, notes: { n1: { note: 'v1' } }, addressBookIds: { [h.book]: true }, media });
    expect((await h.run()).outcome).toBe('ok');
    const id = h.contactNamed('Photo Smalltest')!.id;
    const rowsOf = (mimetype: string) => h.device.rows('data').filter((d) => Number(d.raw_contact_id) === id && d.mimetype === mimetype);
    expect(rowsOf(MimeType.PHOTO)).toMatchObject([{ data14: null }]);

    for (const note of ['v2', 'v3']) {
      h.server.serverUpdate('ContactCard', 'a', card, { 'notes/n1/note': note });
      expect((await h.run()).outcome).toBe('ok');
      expect(rowsOf(MimeType.PHOTO)).toHaveLength(1);
    }
    h.device.user.updateData(Number(rowsOf(MimeType.NOTE)[0]._id), { [Data.DATA1]: 'v4 edited on device' });
    expect(await h.run()).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { updated: 1 } } });
    expect(h.server.get('ContactCard', 'a', card)).toMatchObject({ notes: { n1: { note: 'v4 edited on device' } }, media });
    expect(rowsOf(MimeType.PHOTO)).toHaveLength(1);
  });

  it('syncs a contact whose photo is too large for a provider batch, without the photo', async () => {
    const h = real();
    // About 900 KB of JPEG as a data: URI (a camera photo set over CardDAV).
    const media = { p1: { '@type': 'Media', kind: 'photo', uri: `data:image/jpeg;base64,${'A'.repeat(1_200_000)}`, mediaType: 'image/jpeg' } };
    const card = h.server.addCard('a', { uid: 'u-photo', name: { full: 'Photo Person' }, emails: { e1: { address: 'photo@example.org' } }, addressBookIds: { [h.book]: true }, media });
    addServerCards(h, ['Plain Person']);

    expect(await h.run()).toMatchObject({ outcome: 'ok', itemErrors: [] });
    expect(h.contacts().map((c) => c.name).sort()).toEqual(['Photo Person', 'Plain Person']);
    expect(h.state()?.accounts.a.stale).toEqual([]);
    const before = h.batches.log.length;
    expect((await h.run()).outcome).toBe('ok');
    expect(rowWrites(h.batches.log.slice(before))).toEqual([]);

    // Its device edits upload, and the photo stays on the server.
    const id = h.contactNamed('Photo Person')!.id;
    const email = h.device.rows('data').find((d) => Number(d.raw_contact_id) === id && d.mimetype === MimeType.EMAIL)!;
    h.device.user.updateData(Number(email._id), { data1: 'photo2@example.org' });
    expect(await h.run()).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { updated: 1 } } });
    expect(h.server.get('ContactCard', 'a', card)).toMatchObject({ emails: { e1: { address: 'photo2@example.org' } }, media });
  });

  it('keeps a group rename the server refused when a membership patch of that group goes through', async () => {
    const h = real();
    const [ada] = addServerCards(h, ['Ada Lovelace']);
    const group = h.server.addCard('a', { uid: 'g1', kind: 'group', name: { full: 'Friends' }, members: { other: true }, addressBookIds: { [h.book]: true } });
    expect((await h.run()).outcome).toBe('ok');
    const row = () => h.device.rows('groups').find((g) => g.sourceid === `a/${group}`)!;
    const groupId = Number(row()._id);
    h.device.user.updateGroup(groupId, { [Groups.TITLE]: 'Best friends' });
    h.device.user.addToGroup(h.contactNamed('Ada Lovelace')!.id, groupId);
    const rename = (t: SetTarget) => t.op === 'update' && t.id === group && !!t.object && 'name/full' in t.object;
    h.server.setErrorFor('ContactCard', 'a', rename, { type: 'invalidProperties', properties: ['name'] });

    const report = await h.run();
    expect(report.itemErrors).toMatchObject([{ ref: `a/${group}`, type: 'invalidProperties' }]);
    const uid = h.server.get('ContactCard', 'a', ada)!.uid as string;
    expect(h.server.get('ContactCard', 'a', group)).toMatchObject({ name: { full: 'Friends' }, members: { other: true, [uid]: true } });
    expect(row()).toMatchObject({ [Groups.TITLE]: 'Best friends', [Groups.DIRTY]: 1 });

    // The rename is still the device's and goes up once the server takes it.
    expect((await h.run()).outcome).toBe('ok');
    expect(h.server.get('ContactCard', 'a', group)).toMatchObject({ name: { full: 'Best friends' } });
    expect(row()).toMatchObject({ [Groups.TITLE]: 'Best friends', [Groups.DIRTY]: 0 });
  });
});
