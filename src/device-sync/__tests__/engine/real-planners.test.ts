// The engine with the real contacts and calendar planners (not the toy
// ones): the contract between them holds end to end. Mapping details are
// the planners' own tests; these check what the engine guarantees.

import { describe, expect, it } from 'vitest';
import { Attendees, Data, Events, MimeType } from '../../android-columns';
import { calendarPlanner } from '../../calendar/planner';
import { contactsPlanner } from '../../contacts/planner';
import type { Row } from '../../types';
import {
  addDeviceContact,
  addServerCards,
  CALENDAR_AUTHORITY,
  CONTACTS_AUTHORITY,
  createHarness,
  renameDeviceContact,
  rowWrites,
  RUN_BUDGET,
  type Harness,
} from './harness';

function real(options: Parameters<typeof createHarness>[0] = {}): Harness {
  const h = createHarness(options);
  h.deps.planners = { contacts: contactsPlanner, calendar: calendarPlanner };
  return h;
}

/** The event columns Etar copies into the row it inserts when it moves an event or ends its recurrence. */
const ETAR_COPY = [
  Events.TITLE, Events.DESCRIPTION, Events.EVENT_LOCATION, Events.STATUS, Events.AVAILABILITY, Events.ACCESS_LEVEL,
  Events.EVENT_COLOR, Events.DTSTART, Events.DTEND, Events.DURATION, Events.EVENT_TIMEZONE, Events.ALL_DAY, Events.RRULE,
];

/** Etar's move or "series to single event": the row is deleted and a copy (with its attendees) inserted. */
function etarReinsert(h: Harness, old: Row, calendarRowId: number, changes: Row = {}): number {
  const values: Row = {};
  for (const c of ETAR_COPY) if (old[c] !== undefined) values[c] = old[c];
  const attendees = h.device.rows('attendees')
    .filter((a) => Number(a.event_id) === Number(old._id))
    .map((a) => ({
      [Attendees.ATTENDEE_EMAIL]: a[Attendees.ATTENDEE_EMAIL],
      [Attendees.ATTENDEE_NAME]: a[Attendees.ATTENDEE_NAME],
      [Attendees.ATTENDEE_RELATIONSHIP]: a[Attendees.ATTENDEE_RELATIONSHIP],
      [Attendees.ATTENDEE_TYPE]: a[Attendees.ATTENDEE_TYPE],
      [Attendees.ATTENDEE_STATUS]: a[Attendees.ATTENDEE_STATUS],
    }));
  h.device.user.deleteEvent(Number(old._id));
  return h.device.user.insertEvent(calendarRowId, { ...values, ...changes }, { attendees });
}

/** Masters (no ORIGINAL_*) that share a `_SYNC_ID`: a split the next run would resolve by destroy + create. */
function sharedIdentities(h: Harness): string[] {
  const masters = h.events().filter((e) => e[Events.ORIGINAL_ID] === null && e[Events.ORIGINAL_SYNC_ID] === null && e._sync_id);
  const ids = masters.map((e) => String(e._sync_id));
  return ids.filter((id, i) => ids.indexOf(id) !== i);
}

/** A device edit of the display name only, as AOSP Contacts makes it (the provider fills the components). */
function retypeName(h: Harness, rawContactId: number, name: string): void {
  const row = h.nameDataRow(rawContactId)!;
  h.device.user.updateData(Number(row._id), { [Data.DATA1]: name });
}

function serverUids(h: Harness): string[] {
  return h.server.all('ContactCard', 'a').map((c) => String(c.uid));
}

describe('device sync engine with the real planners', () => {
  it('syncs contacts both ways and writes nothing for its own echo', async () => {
    const h = real();
    const [, grace] = addServerCards(h, ['Ada Lovelace', 'Grace Hopper']);
    expect((await h.run()).outcome).toBe('ok');
    expect(h.contacts().map((c) => c.name).sort()).toEqual(['Ada Lovelace', 'Grace Hopper']);

    addDeviceContact(h, 'Hedy Lamarr');
    h.device.user.deleteContact(h.contactNamed('Grace Hopper')!.id);
    const up = await h.run();
    expect(up).toMatchObject({ outcome: 'ok', itemErrors: [] });
    expect(up.stats.uploaded).toMatchObject({ created: 1, deleted: 1 });
    expect(h.server.get('ContactCard', 'a', grace)).toBeUndefined();
    expect(h.contacts().every((c) => c.sourceId && !c.dirty)).toBe(true);
    expect(new Set(serverUids(h)).size).toBe(2);

    const before = h.batches.log.length;
    const echo = await h.run();
    expect(echo.outcome).toBe('ok');
    expect(rowWrites(h.batches.log.slice(before))).toEqual([]);
  });

  it('converges with the real contacts planner after a crash at any checkpoint', async () => {
    const setup = async () => {
      const h = real();
      addServerCards(h, ['Ada Lovelace', 'Grace Hopper', 'Linus Torvalds']);
      await h.run();
      retypeName(h, h.contactNamed('Grace Hopper')!.id, 'Grace B. Hopper');
      addDeviceContact(h, 'Hedy Lamarr');
      h.device.user.deleteContact(h.contactNamed('Linus Torvalds')!.id);
      h.server.serverUpdate('ContactCard', 'a', h.contactNamed('Ada Lovelace')!.sourceId!.split('/')[1], { 'name/full': 'Ada King' });
      addServerCards(h, ['Margaret Hamilton']);
      h.checkpoints.count = 0;
      return h;
    };
    const probe = await setup();
    await probe.run();
    const final = probe.contacts().map((c) => c.name).sort();
    const finalServer = probe.serverNames();
    const checkpoints = probe.checkpoints.count;

    for (let n = 1; n <= checkpoints; n++) {
      const h = await setup();
      h.checkpoints.crashAt = n;
      await h.run();
      h.checkpoints.crashAt = null;
      const report = await h.run();
      expect(report.outcome, `crash at checkpoint ${n}`).toBe('ok');
      expect(h.contacts().map((c) => c.name).sort(), `device after crash ${n}`).toEqual(final);
      expect(h.serverNames(), `server after crash ${n}`).toEqual(finalServer);
      expect(h.contacts().every((c) => !c.dirty && !c.deleted)).toBe(true);
      expect(new Set(serverUids(h)).size).toBe(serverUids(h).length);
    }
  });

  it('adopts a lost create by uid with the real contacts planner', async () => {
    const h = real();
    addServerCards(h, ['Ada Lovelace']);
    await h.run();
    h.server.setUidIndexLag(3);
    const id = addDeviceContact(h, 'Hedy Lamarr');
    h.server.applyThenLoseResponse({ match: 'ContactCard/set' });

    expect((await h.run()).outcome).toBe('io');
    expect((await h.run()).outcome).toBe('ok');

    expect(h.serverNames()).toEqual(['Ada Lovelace', 'Hedy Lamarr']);
    expect(h.contacts()).toHaveLength(2);
    expect(h.contacts().find((c) => c.id === id)).toMatchObject({ dirty: false, sourceId: expect.stringMatching(/^a\//) });
    expect(h.device.rows('data').filter((d) => d.mimetype === MimeType.STRUCTURED_NAME)).toHaveLength(2);
  });

  it("follows a group's members when only the group card changed on the server", async () => {
    const h = real();
    const [ada, grace] = addServerCards(h, ['Ada Lovelace', 'Grace Hopper']);
    const uid = (id: string) => h.server.get('ContactCard', 'a', id)!.uid as string;
    const group = h.server.addCard('a', { uid: 'g1', kind: 'group', name: { full: 'Friends' }, members: { [uid(ada)]: true } });
    const members = () =>
      h.device
        .rows('data')
        .filter((d) => d.mimetype === MimeType.GROUP_MEMBERSHIP)
        .map((d) => h.contacts().find((c) => c.id === Number(d.raw_contact_id))?.name)
        .sort();
    expect((await h.run()).outcome).toBe('ok');
    expect(members()).toEqual(['Ada Lovelace']);

    h.server.serverUpdate('ContactCard', 'a', group, { members: { [uid(grace)]: true } });
    expect((await h.run()).outcome).toBe('ok');

    expect(members()).toEqual(['Grace Hopper']);
    expect(h.contacts().every((c) => !c.dirty)).toBe(true);
  });

  describe('a membership edit on the device', () => {
    async function adaJoinsFriends() {
      const h = real();
      const [ada] = addServerCards(h, ['Ada Lovelace']);
      const group = h.server.addCard('a', { uid: 'g1', kind: 'group', name: { full: 'Friends' }, members: {} });
      await h.run();
      const contact = h.contactNamed('Ada Lovelace')!;
      h.device.user.addToGroup(contact.id, Number(h.device.rows('groups')[0]._id));
      return { h, ada, group, contact };
    }

    it('leaves the contact clean once the group card shows it', async () => {
      const { h, ada, group, contact } = await adaJoinsFriends();

      expect((await h.run()).outcome).toBe('ok');

      const uid = h.server.get('ContactCard', 'a', ada)!.uid as string;
      expect(h.server.get('ContactCard', 'a', group)!.members).toEqual({ [uid]: true });
      expect(h.contacts().find((c) => c.id === contact.id)).toMatchObject({ dirty: false });
    });

    it('leaves nothing waiting for the teardown once it is uploaded', async () => {
      const { h, ada, group } = await adaJoinsFriends();

      expect(await h.teardown(CONTACTS_AUTHORITY)).toEqual({ pending: 0 });

      const uid = h.server.get('ContactCard', 'a', ada)!.uid as string;
      expect(h.server.get('ContactCard', 'a', group)!.members).toEqual({ [uid]: true });
    });

    it('waits with a membership edit while the group card is stale, instead of resending its members', async () => {
      const { h, ada, group } = await adaJoinsFriends();
      const [bob] = addServerCards(h, ['Bob']);
      const bobUid = h.server.get('ContactCard', 'a', bob)!.uid as string;
      // Another client adds Bob; this device cannot store the new version of the group this run.
      h.server.serverUpdate('ContactCard', 'a', group, { members: { [bobUid]: true } });
      h.deps.planners = {
        ...h.deps.planners,
        contacts: {
          ...contactsPlanner,
          planGroupDownload: (card, local, ctx) => {
            if (card.id === group) throw new Error('cannot store this group now');
            return contactsPlanner.planGroupDownload(card, local, ctx);
          },
        },
      };

      await h.run();

      const adaUid = h.server.get('ContactCard', 'a', ada)!.uid as string;
      expect(h.server.get('ContactCard', 'a', group)!.members).toEqual({ [bobUid]: true });
      expect(h.contacts().find((c) => c.name === 'Ada Lovelace')).toMatchObject({ dirty: true });

      h.deps.planners = { contacts: contactsPlanner, calendar: calendarPlanner };
      expect((await h.run()).outcome).toBe('ok');

      expect(h.server.get('ContactCard', 'a', group)!.members).toEqual({ [bobUid]: true, [adaUid]: true });
      expect(h.contacts().find((c) => c.name === 'Ada Lovelace')).toMatchObject({ dirty: false });
    });

    describe('an upload that downloads nothing first', () => {
      /** Ada in Friends (and Grace); Ada's name edited in place (AOSP); nothing new on the server. */
      async function adaRenamedInFriends() {
        const h = real();
        const [ada, grace] = addServerCards(h, ['Ada Lovelace', 'Grace Hopper']);
        const uid = h.server.get('ContactCard', 'a', ada)!.uid as string;
        h.server.addCard('a', { uid: 'g1', kind: 'group', name: { full: 'Friends' }, members: { [uid]: true } });
        expect((await h.run()).outcome).toBe('ok');
        const row = h.contactNamed('Ada Lovelace')!.id;
        h.device.user.updateData(Number(h.nameDataRow(row)!._id), { [Data.DATA1]: 'Ada King' });
        const memberships = () => h.device.rows('data').filter((d) => Number(d.raw_contact_id) === row && d.mimetype === MimeType.GROUP_MEMBERSHIP);
        return { h, ada, grace, memberships };
      }

      it("keeps the uploaded contact's memberships in a sync run", async () => {
        const { h, ada, memberships } = await adaRenamedInFriends();

        expect((await h.run()).outcome).toBe('ok');

        expect(h.server.get('ContactCard', 'a', ada)).toMatchObject({ name: { full: 'Ada King' } });
        expect(memberships()).toHaveLength(1);
      });

      it("keeps the uploaded contact's memberships in a teardown's upload", async () => {
        const { h, ada, grace, memberships } = await adaRenamedInFriends();
        // Grace's edit cannot go up, so the teardown keeps every row and asks.
        renameDeviceContact(h, h.contactNamed('Grace Hopper')!.id, 'Grace B. Hopper');
        h.server.setErrorFor('ContactCard', 'a', grace, { type: 'tooLarge' });

        expect(await h.teardown(CONTACTS_AUTHORITY)).toEqual({ pending: 1 });

        expect(h.server.get('ContactCard', 'a', ada)).toMatchObject({ name: { full: 'Ada King' } });
        expect(memberships()).toHaveLength(1);
      });
    });

    it('uploads a removal from a group in a run that downloads no contact', async () => {
      const h = real();
      // A keyed phone row shows the editor works in place, so a missing membership row is a removal.
      h.server.addCard('a', { uid: 'ada-uid', name: { full: 'Ada Lovelace' }, phones: { p1: { '@type': 'Phone', number: '+1 111' } } });
      const group = h.server.addCard('a', { uid: 'g1', kind: 'group', name: { full: 'Friends' }, members: { 'ada-uid': true } });
      await h.run();
      const contact = h.contactNamed('Ada Lovelace')!;
      const membership = h.device.rows('data').find((d) => Number(d.raw_contact_id) === contact.id && d.mimetype === MimeType.GROUP_MEMBERSHIP)!;
      h.device.user.deleteData(Number(membership._id));

      // The upload sync Android requests after the edit: the server has nothing new.
      expect((await h.run(CONTACTS_AUTHORITY, { upload: true })).outcome).toBe('ok');

      expect(h.server.get('ContactCard', 'a', group)!.members ?? {}).toEqual({});
      expect(h.contacts().find((c) => c.id === contact.id)).toMatchObject({ dirty: false });
      expect(h.device.rows('data').filter((d) => d.mimetype === MimeType.GROUP_MEMBERSHIP)).toEqual([]);
    });
  });

  describe('a batch the provider committed up to a yield point before it failed', () => {
    const alert = { al1: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' }, action: 'display' } };

    it("never inserts a clean event's new reminder twice", async () => {
      const h = real();
      const event = (uid: string, title: string) =>
        h.server.addEvent('a', { uid, title, start: '2026-10-06T12:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin', calendarIds: { [h.calendar]: true } });
      const lunch = event('lunch-uid', 'Lunch');
      const retro = event('retro-uid', 'Retro');
      await h.run(CALENDAR_AUTHORITY);
      // Only an alert for Lunch (its row's columns stay), a new title for Retro: one download batch, two groups.
      h.server.serverUpdate('CalendarEvent', 'a', lunch, { alerts: alert });
      h.server.serverUpdate('CalendarEvent', 'a', retro, { title: 'Retrospective' });
      h.device.partialCommitNextBatch(1, 'assert', (ops) => ops.some((op) => op.op === 'insert' && op.table === 'reminders'));

      expect((await h.run(CALENDAR_AUTHORITY)).outcome).toBe('ok');

      const row = h.events().find((e) => e.title === 'Lunch')!;
      expect(h.device.rows('reminders').filter((r) => Number(r.event_id) === Number(row._id)).map((r) => r.minutes)).toEqual([15]);
      expect(h.events().map((e) => e.title).sort()).toEqual(['Lunch', 'Retrospective']);
    });
  });

  describe('a deletion decided on the server version', () => {
    /** The contacts planner as fixed for data finding 4: a deleted contact's shadow follows the server. */
    function refreshingDeletedShadows(h: Harness): void {
      h.deps.planners = {
        ...h.deps.planners,
        contacts: {
          ...contactsPlanner,
          planDownload: (card, local, ctx) => {
            if (!local?.deleted || !local.sourceId) return contactsPlanner.planDownload(card, local, ctx);
            const shadow = JSON.stringify({ ...card, '~memberOf': local.shadow?.['~memberOf'] ?? [] });
            const ops = [{ op: 'update' as const, table: 'raw_contacts' as const, id: local.rawContactId, values: { sync2: shadow } }];
            return { ops: { ref: local.sourceId, ops }, conflicts: 0, stillDirty: true, effect: 'update' as const, writes: 1 };
          },
        },
      };
    }

    it('in a teardown, when the server changed since the last sync', async () => {
      const h = real();
      const archive = h.server.addAddressBook('a', { name: 'Archive' });
      h.prefs.contactsSelection[`a/${archive}`] = false;
      const [ada] = addServerCards(h, ['Ada Lovelace']);
      await h.run();
      refreshingDeletedShadows(h);
      h.device.user.deleteContact(h.contactNamed('Ada Lovelace')!.id);
      // Meanwhile another client files Ada in Archive too.
      h.server.serverUpdate('ContactCard', 'a', ada, { [`addressBookIds/${archive}`]: true });

      expect(await h.teardown(CONTACTS_AUTHORITY)).toEqual({ pending: 0 });

      expect(h.server.get('ContactCard', 'a', ada)).toMatchObject({ addressBookIds: { [archive]: true } });
      expect((h.server.get('ContactCard', 'a', ada)!.addressBookIds as object)).not.toHaveProperty(h.book);
    });

    it('lets the planner see the server version of a contact deleted on the device and filed away meanwhile', async () => {
      const h = real();
      const archive = h.server.addAddressBook('a', { name: 'Archive' });
      h.prefs.contactsSelection[`a/${archive}`] = false;
      const [ada] = addServerCards(h, ['Ada Lovelace']);
      await h.run();
      refreshingDeletedShadows(h);
      const planned: string[][] = [];
      const contacts = h.deps.planners.contacts;
      h.deps.planners = {
        ...h.deps.planners,
        contacts: {
          ...contacts,
          planUpload: (local, ctx) => {
            if (local.deleted) planned.push(Object.keys(local.shadow?.addressBookIds ?? {}));
            return contacts.planUpload(local, ctx);
          },
        },
      };
      h.device.user.deleteContact(h.contactNamed('Ada Lovelace')!.id);
      // Another client files Ada in Archive only: she left every synced book.
      h.server.serverUpdate('ContactCard', 'a', ada, { addressBookIds: { [archive]: true } });

      expect((await h.run()).outcome).toBe('ok');

      expect(planned).toEqual([[archive]]);
    });

    it('leaves a contact deleted on the device that another client moved out of every synced book', async () => {
      const h = real();
      const archive = h.server.addAddressBook('a', { name: 'Archive' });
      h.prefs.contactsSelection[`a/${archive}`] = false;
      const [ada] = addServerCards(h, ['Ada Lovelace', 'Grace Hopper']);
      await h.run();
      h.device.user.deleteContact(h.contactNamed('Ada Lovelace')!.id);
      // Another client files Ada in Archive only before the deletion reached the server.
      h.server.serverUpdate('ContactCard', 'a', ada, { addressBookIds: { [archive]: true } });

      const report = await h.run();

      expect(report).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { created: 0, updated: 0, deleted: 0 } } });
      expect(h.server.get('ContactCard', 'a', ada)).toMatchObject({ addressBookIds: { [archive]: true } });
      expect(h.contacts().map((c) => c.name)).toEqual(['Grace Hopper']);
    });

    /** Lunch synced, deleted on the device, then filed by another client in Archive, which this device does not sync. */
    async function lunchDeletedAndFiledAway() {
      const h = real();
      const archive = h.server.addCalendar('a', { name: 'Archive' });
      h.prefs.calendarSelection[`a/${archive}`] = false;
      const lunch = h.server.addEvent('a', { uid: 'lunch-uid', title: 'Lunch', start: '2026-10-06T12:00:00', duration: 'PT1H', timeZone: 'Europe/Berlin', calendarIds: { [h.calendar]: true } });
      await h.run(CALENDAR_AUTHORITY);
      h.device.user.deleteEvent(Number(h.events()[0]._id));
      h.server.serverUpdate('CalendarEvent', 'a', lunch, { calendarIds: { [archive]: true } });
      return { h, archive, lunch };
    }

    it('leaves an event deleted on the device that another client moved out of every synced calendar', async () => {
      const { h, archive, lunch } = await lunchDeletedAndFiledAway();

      const report = await h.run(CALENDAR_AUTHORITY);

      expect(report).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { created: 0, updated: 0, deleted: 0 } } });
      expect(h.server.get('CalendarEvent', 'a', lunch)).toMatchObject({ calendarIds: { [archive]: true } });
      expect(h.events()).toEqual([]);
    });

    it('still uploads the deletion as it was planned when the planner cannot take the server version', async () => {
      const { h, lunch } = await lunchDeletedAndFiledAway();
      h.deps.planners = {
        ...h.deps.planners,
        calendar: {
          ...calendarPlanner,
          planDownload: (event, local, ctx) => {
            if (local?.deleted) throw new Error('cannot take it');
            return calendarPlanner.planDownload(event, local, ctx);
          },
        },
      };

      const report = await h.run(CALENDAR_AUTHORITY);

      expect(report).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { deleted: 1 } } });
      expect(h.server.get('CalendarEvent', 'a', lunch)).toBeUndefined();
      expect(h.events()).toEqual([]);
    });

    it('waits in a teardown, with the edits, while no state guards the upload (the first sync never ended)', async () => {
      const h = real();
      const [ada] = addServerCards(h, ['Ada Lovelace', 'Grace Hopper', ...Array.from({ length: 60 }, (_, i) => `P${i}`)]);
      // The first sync (a full reconcile) runs out of time after its first chunk (Ada and Grace): no state yet.
      h.checkpoints.onCheckpoint = (n) => {
        if (n === 3) h.clock.now += RUN_BUDGET;
      };
      expect((await h.run()).outcome).toBe('cancelled');
      h.checkpoints.onCheckpoint = undefined;
      expect(h.state()?.accounts.a.itemsState).toBeNull();
      renameDeviceContact(h, h.contactNamed('Ada Lovelace')!.id, 'Ada King');
      h.device.user.deleteContact(h.contactNamed('Grace Hopper')!.id);
      addDeviceContact(h, 'Hedy Lamarr');
      // Meanwhile another client changes Ada.
      h.server.serverUpdate('ContactCard', 'a', ada, { 'name/full': 'Ada, Countess of Lovelace' });

      expect(await h.teardown(CONTACTS_AUTHORITY)).toEqual({ pending: 2 });

      expect(h.serverNames().filter((n) => !/^P\d+$/.test(n))).toEqual(['Ada, Countess of Lovelace', 'Grace Hopper', 'Hedy Lamarr']);
    });
  });

  describe('a device edit the server refuses (forbidden)', () => {
    it('puts a contact back in place, keeping what only the device knows', async () => {
      const h = real();
      const [ada] = addServerCards(h, ['Ada Lovelace']);
      await h.run();
      const before = h.contactNamed('Ada Lovelace')!;
      h.device.user.star(before.id);
      renameDeviceContact(h, before.id, 'Ada King');
      h.server.setErrorFor('ContactCard', 'a', ada, { type: 'forbidden' });

      const report = await h.run();

      expect(report.itemErrors).toEqual([expect.objectContaining({ ref: `a/${ada}`, type: 'forbidden' })]);
      expect(h.server.get('ContactCard', 'a', ada)).toMatchObject({ name: { full: 'Ada Lovelace' } });
      expect(h.contacts()).toEqual([expect.objectContaining({ id: before.id, name: 'Ada Lovelace', dirty: false })]);
      expect(h.contacts()[0].row.starred).toBe(1);
    });

    it('brings a contact back whose deletion the server refuses', async () => {
      const h = real();
      const [ada] = addServerCards(h, ['Ada Lovelace']);
      await h.run();
      h.device.user.deleteContact(h.contactNamed('Ada Lovelace')!.id);
      h.server.setErrorFor('ContactCard', 'a', ada, { type: 'forbidden' });

      const report = await h.run();

      expect(report.itemErrors).toEqual([expect.objectContaining({ ref: `a/${ada}`, type: 'forbidden' })]);
      expect(h.server.get('ContactCard', 'a', ada)).toBeDefined();
      expect(h.contacts()).toEqual([expect.objectContaining({ sourceId: `a/${ada}`, name: 'Ada Lovelace', dirty: false, deleted: false })]);
    });

    it('puts an event back in place', async () => {
      const h = real();
      const standup = h.server.addEvent('a', {
        uid: 'standup-uid',
        title: 'Standup',
        start: '2026-09-28T09:00:00',
        duration: 'PT15M',
        timeZone: 'Europe/Berlin',
        calendarIds: { [h.calendar]: true },
      });
      await h.run(CALENDAR_AUTHORITY);
      const row = h.events()[0];
      h.device.user.updateEvent(Number(row._id), { [Events.TITLE]: 'Mine', [Events.CUSTOM_APP_PACKAGE]: 'org.example.app' });
      h.server.setErrorFor('CalendarEvent', 'a', standup, { type: 'forbidden' });

      const report = await h.run(CALENDAR_AUTHORITY);

      expect(report.itemErrors).toEqual([expect.objectContaining({ ref: `a/${standup}`, type: 'forbidden' })]);
      expect(h.events()).toEqual([
        expect.objectContaining({ _id: row._id, title: 'Standup', dirty: 0, [Events.CUSTOM_APP_PACKAGE]: 'org.example.app' }),
      ]);
    });
  });

  describe('the last run status the settings show', () => {
    /** A run that puts back an edit the server refuses: reported once, nothing waits afterwards. */
    async function refusedEdit() {
      const h = real();
      const [ada] = addServerCards(h, ['Ada Lovelace', 'Grace Hopper']);
      await h.run();
      renameDeviceContact(h, h.contactNamed('Ada Lovelace')!.id, 'Ada King');
      h.server.setErrorFor('ContactCard', 'a', ada, { type: 'forbidden' });
      h.clock.now += 60_000;
      expect((await h.run()).itemErrors).toEqual([expect.objectContaining({ type: 'forbidden' })]);
      const status = h.lastStatus()!;
      expect(status).toMatchObject({ outcome: 'ok', itemErrors: 1 });
      return { h, status };
    }

    it('keeps what a run reported through an upload sync after it that finds nothing to do', async () => {
      const { h, status } = await refusedEdit();
      h.clock.now += 2_000;

      await h.run(CONTACTS_AUTHORITY, { upload: true });

      expect(h.lastStatus()).toEqual({ ...status, at: expect.any(Number) });
      expect(h.lastStatus()!.at).toBeGreaterThan(status.at);
    });

    it('keeps what a run reported through a follow-up sync that finds nothing new on the server', async () => {
      const { h, status } = await refusedEdit();
      h.clock.now += 2_000;

      expect((await h.run()).itemErrors).toEqual([]);

      expect(h.lastStatus()).toEqual({ ...status, at: expect.any(Number) });
      expect(h.lastStatus()!.at).toBeGreaterThan(status.at);
    });

    it('replaces it with a run that did something', async () => {
      const { h } = await refusedEdit();
      addServerCards(h, ['Linus Torvalds']);

      await h.run();

      expect(h.lastStatus()).toMatchObject({ outcome: 'ok', itemErrors: 0, stats: { downloaded: { created: 1 } } });
    });

    it('shows a sync that finds nothing to do after a failed one as recovered', async () => {
      const h = real();
      addServerCards(h, ['Ada Lovelace']);
      await h.run();
      renameDeviceContact(h, h.contactNamed('Ada Lovelace')!.id, 'Ada King');
      h.server.failNextRequest('network', { match: 'ContactCard/set' });
      expect((await h.run()).outcome).toBe('io');
      expect(h.lastStatus()).toMatchObject({ outcome: 'io' });
      // Uploaded by the next sync; the one after it finds nothing to do.
      expect((await h.run()).outcome).toBe('ok');
      h.clock.now += 2_000;
      h.server.failNextRequest('network', { match: 'ContactCard/changes' });
      expect((await h.run()).outcome).toBe('io');

      expect((await h.run()).outcome).toBe('ok');

      expect(h.lastStatus()).toMatchObject({ outcome: 'ok', itemErrors: 0, conflicts: 0 });
      expect(h.lastStatus()).not.toHaveProperty('message');
    });
  });

  describe('a create whose target the server deleted after the claim', () => {
    it('claims a new contact again for a book that exists', async () => {
      const h = real();
      const work = h.server.addAddressBook('a', { name: 'Work' });
      h.prefs.newContactsAddressBook = `a/${work}`;
      await h.run();
      const id = addDeviceContact(h, 'Hedy Lamarr');
      // The claim names Work, the create is lost; then another client deletes Work.
      h.server.failNextRequest('network', { match: 'ContactCard/set' });
      expect((await h.run()).outcome).toBe('io');
      h.server.serverDestroy('AddressBook', 'a', work);

      const report = await h.run();

      expect(report).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { created: 1 } } });
      const hedy = h.server.all('ContactCard', 'a').find((c) => (c.name as { full?: string }).full === 'Hedy Lamarr')!;
      expect(hedy.addressBookIds).toEqual({ [h.book]: true });
      expect(h.contacts().find((c) => c.id === id)).toMatchObject({ sourceId: `a/${hedy.id}`, dirty: false });
      expect(h.contacts().find((c) => c.id === id)!.row.sync4).toBeNull();
    });

    it('keeps a new event whose calendar is gone, without poisoning it, until the user moves it', async () => {
      const h = real();
      const work = h.server.addCalendar('a', { name: 'Work' });
      await h.run(CALENDAR_AUTHORITY);
      const rowOf = (calendarId: string) => Number(h.device.rows('calendars').find((c) => c._sync_id === `a/${calendarId}`)!._id);
      const workRow = rowOf(work);
      const dentist = { title: 'Dentist', dtstart: Date.UTC(2026, 9, 1, 8), dtend: Date.UTC(2026, 9, 1, 9), eventTimezone: 'Europe/Berlin' };
      const id = h.device.user.insertEvent(workRow, dentist);
      h.server.failNextRequest('network', { match: 'CalendarEvent/set' });
      expect((await h.run(CALENDAR_AUTHORITY)).outcome).toBe('io');
      h.server.serverDestroy('Calendar', 'a', work);

      const report = await h.run(CALENDAR_AUTHORITY);

      expect(report.itemErrors).toEqual([expect.objectContaining({ ref: `row:${id}`, type: 'collectionGone' })]);
      expect(h.server.all('CalendarEvent', 'a')).toEqual([]);
      expect(h.events().find((e) => Number(e._id) === id)).toMatchObject({ title: 'Dentist', sync_data5: null });

      // The user moves it to the personal calendar (Etar: delete + insert).
      h.device.user.deleteEvent(id);
      h.device.user.insertEvent(rowOf(h.calendar), dentist);
      expect(await h.run(CALENDAR_AUTHORITY)).toMatchObject({ outcome: 'ok', itemErrors: [] });

      expect(h.server.all('CalendarEvent', 'a').map((e) => [e.title, e.calendarIds])).toEqual([['Dentist', { [h.calendar]: true }]]);
      expect(h.device.rows('calendars').map((c) => c._sync_id)).toEqual([`a/${h.calendar}`]);
    });
  });

  describe('a device edit of an object the server moved out of every synced collection', () => {
    /** Ada with two numbers in the synced book; the device deletes the second in place (AOSP). */
    async function adaWithDeletedNumber() {
      const h = real();
      const archive = h.server.addAddressBook('a', { name: 'Archive' });
      h.prefs.contactsSelection[`a/${archive}`] = false;
      const ada = h.server.addCard('a', {
        uid: 'ada-uid',
        name: { full: 'Ada Lovelace' },
        phones: { p1: { '@type': 'Phone', number: '+1 111' }, p2: { '@type': 'Phone', number: '+1 222' } },
        addressBookIds: { [h.book]: true },
      });
      await h.run();
      const contact = h.contactNamed('Ada Lovelace')!;
      const p2 = h.device.rows('data').find((d) => Number(d.raw_contact_id) === contact.id && d[Data.DATA1] === '+1 222')!;
      h.device.user.deleteData(Number(p2._id));
      // Meanwhile another client files Ada in Archive only and adds a number.
      h.server.serverUpdate('ContactCard', 'a', ada, { addressBookIds: { [archive]: true }, 'phones/p3': { '@type': 'Phone', number: '+1 333' } });
      return { h, ada, archive };
    }

    const numbers = (card: Record<string, unknown>) =>
      Object.values((card.phones ?? {}) as Record<string, { number: string }>).map((p) => p.number).sort();

    it('uploads it against the server version, then drops the rows', async () => {
      const { h, ada, archive } = await adaWithDeletedNumber();

      const report = await h.run();

      expect(report).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { updated: 1 } } });
      const card = h.server.get('ContactCard', 'a', ada)!;
      expect(numbers(card)).toEqual(['+1 111', '+1 333']);
      expect(card.addressBookIds).toEqual({ [archive]: true });
      expect(h.contacts()).toEqual([]);
    });

    it('does the same when a full reconcile finds the object outside', async () => {
      const { h, ada, archive } = await adaWithDeletedNumber();
      h.server.truncateChangeLog('a', 'contacts');

      const report = await h.run();

      expect(report).toMatchObject({ outcome: 'ok', itemErrors: [] });
      const card = h.server.get('ContactCard', 'a', ada)!;
      expect(numbers(card)).toEqual(['+1 111', '+1 333']);
      expect(card.addressBookIds).toEqual({ [archive]: true });
      expect(h.contacts()).toEqual([]);
    });

    it('never uploads an event edit against an outdated shadow', async () => {
      const h = real();
      const archive = h.server.addCalendar('a', { name: 'Archive' });
      h.prefs.calendarSelection[`a/${archive}`] = false;
      const series = h.server.addEvent('a', {
        uid: 'series-uid',
        title: 'Standup',
        start: '2026-09-28T09:00:00',
        duration: 'PT15M',
        timeZone: 'Europe/Berlin',
        recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily' },
        recurrenceOverrides: { '2026-09-29T09:00:00': { title: 'Planning' } },
        calendarIds: { [h.calendar]: true },
      });
      await h.run(CALENDAR_AUTHORITY);
      const master = h.events().find((e) => e._sync_id === `a/${series}`)!;
      const later = Number(master[Events.DTSTART]) + 3_600_000;
      // The device moves the series by an hour; another client files it in Archive and changes another instance.
      h.device.user.updateEvent(Number(master._id), { [Events.DTSTART]: later });
      h.server.serverUpdate('CalendarEvent', 'a', series, {
        calendarIds: { [archive]: true },
        'recurrenceOverrides/2026-10-01T09:00:00': { title: 'Retro' },
      });

      expect(await h.run(CALENDAR_AUTHORITY)).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { updated: 1 } } });

      const event = h.server.get('CalendarEvent', 'a', series)!;
      const titles = Object.values((event.recurrenceOverrides ?? {}) as Record<string, { title?: string }>).map((o) => o.title).sort();
      expect(titles).toEqual(['Planning', 'Retro']);
      // The move went up against the server's version, and the rows went with the event.
      expect(event).toMatchObject({ start: '2026-09-28T10:00:00', calendarIds: { [archive]: true } });
      expect(h.events()).toEqual([]);
    });
  });

  it('creates a device event that carries the uid of a synced event (an app copied it) under a fresh uid', async () => {
    const h = real();
    const standup = h.server.addEvent('a', {
      uid: 'standup-uid',
      title: 'Standup',
      start: '2026-09-28T09:00:00',
      duration: 'PT15M',
      timeZone: 'Europe/Berlin',
      calendarIds: { [h.calendar]: true },
    });
    await h.run(CALENDAR_AUTHORITY);
    const rowId = Number(h.device.rows('calendars')[0]._id);

    const copy = h.device.user.insertEvent(rowId, {
      title: 'Standup (copy)',
      dtstart: Date.UTC(2026, 8, 29, 7),
      dtend: Date.UTC(2026, 8, 29, 7, 15),
      eventTimezone: 'Europe/Berlin',
      uid2445: 'standup-uid',
    });
    const report = await h.run(CALENDAR_AUTHORITY);

    expect(report).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { created: 1 } } });
    expect(h.server.get('CalendarEvent', 'a', standup)).toMatchObject({ title: 'Standup', uid: 'standup-uid' });
    const created = h.server.all('CalendarEvent', 'a').find((e) => e.title === 'Standup (copy)')!;
    expect(created.uid).not.toBe('standup-uid');
    expect(h.events().find((e) => Number(e._id) === copy)).toMatchObject({ _sync_id: `a/${created.id}`, uid2445: created.uid });
    expect(h.events().every((e) => Number(e.dirty ?? 0) === 0)).toBe(true);
  });

  it('uploads "this and following" in one run: the capped rule and the new series', async () => {
    const h = real();
    const series = h.server.addEvent('a', {
      uid: 'series-uid',
      title: 'Standup',
      start: '2026-09-28T09:00:00',
      duration: 'PT15M',
      timeZone: 'Europe/Berlin',
      recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily' },
      calendarIds: { [h.calendar]: true },
    });
    await h.run(CALENDAR_AUTHORITY);
    const master = h.events()[0];
    expect(master).toMatchObject({ rrule: 'FREQ=DAILY' });
    const rowId = Number(master.calendar_id);

    // Etar: the master's rule ends before the split, a new series starts there (it copies the uid).
    h.device.user.updateEvent(Number(master._id), { rrule: 'FREQ=DAILY;UNTIL=20260930T235959Z' });
    const later = h.device.user.insertEvent(rowId, {
      title: 'Standup',
      dtstart: Date.UTC(2026, 9, 1, 7),
      duration: 'P900S',
      rrule: 'FREQ=DAILY',
      eventTimezone: 'Europe/Berlin',
      uid2445: 'series-uid',
    });
    const report = await h.run(CALENDAR_AUTHORITY);

    expect(report).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { created: 1, updated: 1 } } });
    const capped = h.server.get('CalendarEvent', 'a', series)!;
    expect(capped.recurrenceRule).toMatchObject({ frequency: 'daily', until: expect.any(String) });
    const next = h.server.all('CalendarEvent', 'a').find((e) => e.id !== series)!;
    expect(next).toMatchObject({ start: '2026-10-01T09:00:00', timeZone: 'Europe/Berlin', recurrenceRule: { frequency: 'daily' } });
    expect(next.uid).not.toBe('series-uid');
    expect(h.events().find((e) => Number(e._id) === later)).toMatchObject({ _sync_id: `a/${next.id}` });
    expect(h.events().every((e) => Number(e.dirty ?? 0) === 0)).toBe(true);
  });

  it("uploads Etar's move to another calendar as a patch of the same event, keeping what the device can't show", async () => {
    const h = real();
    const work = h.server.addCalendar('a', { name: 'Work' });
    const lunch = h.server.addEvent('a', {
      uid: 'lunch-uid',
      title: 'Lunch',
      start: '2026-10-06T12:00:00',
      duration: 'PT1H',
      timeZone: 'Europe/Berlin',
      keywords: { important: true },
      virtualLocations: { v1: { '@type': 'VirtualLocation', uri: 'https://meet.example.com/lunch' } },
      organizerCalendarAddress: 'mailto:alice@example.com',
      participants: {
        me: { '@type': 'Participant', calendarAddress: 'mailto:alice@example.com', roles: { owner: true, attendee: true }, participationStatus: 'accepted' },
        bob: { '@type': 'Participant', calendarAddress: 'mailto:bob@example.com', name: 'Bob', roles: { attendee: true }, participationStatus: 'accepted' },
      },
      calendarIds: { [h.calendar]: true },
    });
    await h.run(CALENDAR_AUTHORITY);
    const old = h.events().find((e) => e._sync_id === `a/${lunch}`)!;
    const workRow = Number(h.device.rows('calendars').find((c) => c._sync_id === `a/${work}`)!._id);

    const moved = etarReinsert(h, old, workRow);
    const report = await h.run(CALENDAR_AUTHORITY);

    expect(report).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { created: 0, updated: 1, deleted: 0 } } });
    expect(h.server.all('CalendarEvent', 'a')).toHaveLength(1);
    const event = h.server.get('CalendarEvent', 'a', lunch)!;
    expect(event.calendarIds).toEqual({ [work]: true });
    expect(event).toMatchObject({
      uid: 'lunch-uid',
      keywords: { important: true },
      virtualLocations: { v1: { uri: 'https://meet.example.com/lunch' } },
      participants: { bob: { participationStatus: 'accepted' } },
    });
    // A move tells nobody.
    expect(h.server.scheduling).toEqual([]);
    expect(h.events()).toEqual([expect.objectContaining({ _id: moved, _sync_id: `a/${lunch}`, uid2445: 'lunch-uid', calendar_id: workRow, dirty: 0 })]);

    const before = h.batches.log.length;
    expect((await h.run(CALENDAR_AUTHORITY)).outcome).toBe('ok');
    expect(rowWrites(h.batches.log.slice(before))).toEqual([]);
  });

  it('keeps a meeting Etar moved the same event, without cancelling and inviting anyone again', async () => {
    const h = real();
    const work = h.server.addCalendar('a', { name: 'Work' });
    const lunch = h.server.addEvent('a', {
      uid: 'lunch-uid',
      title: 'Lunch',
      start: '2026-10-06T12:00:00',
      duration: 'PT1H',
      timeZone: 'Europe/Berlin',
      organizerCalendarAddress: 'mailto:alice@example.com',
      participants: {
        me: { '@type': 'Participant', calendarAddress: 'mailto:alice@example.com', roles: { owner: true, attendee: true }, participationStatus: 'accepted' },
        bob: { '@type': 'Participant', calendarAddress: 'mailto:bob@example.com', name: 'Bob', roles: { attendee: true, optional: true }, participationStatus: 'accepted' },
      },
      calendarIds: { [h.calendar]: true },
    });
    await h.run(CALENDAR_AUTHORITY);
    const old = h.events().find((e) => e._sync_id === `a/${lunch}`)!;
    const workRow = Number(h.device.rows('calendars').find((c) => c._sync_id === `a/${work}`)!._id);

    // What Etar really inserts: Bob as a required attendee without an answer, and no row for the user.
    const moved = h.device.user.etarMove(Number(old._id), workRow);
    const report = await h.run(CALENDAR_AUTHORITY);

    expect(report).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { created: 0, updated: 1, deleted: 0 } } });
    expect(h.server.all('CalendarEvent', 'a')).toHaveLength(1);
    expect(h.server.get('CalendarEvent', 'a', lunch)).toMatchObject({
      uid: 'lunch-uid',
      calendarIds: { [work]: true },
      participants: { bob: { roles: { attendee: true, optional: true }, participationStatus: 'accepted' } },
    });
    expect(h.server.scheduling).toEqual([]);
    // The rows show the meeting as the server holds it again: the user's own row and Bob's answer.
    const attendees = h.device.rows('attendees').filter((a) => Number(a.event_id) === moved);
    expect(attendees.map((a) => [a[Attendees.ATTENDEE_EMAIL], a[Attendees.ATTENDEE_STATUS], a[Attendees.ATTENDEE_TYPE]]).sort()).toEqual([
      ['alice@example.com', 1, 1],
      ['bob@example.com', 1, 2],
    ]);
    expect(h.events()).toEqual([expect.objectContaining({ _id: moved, _sync_id: `a/${lunch}`, dirty: 0 })]);
  });

  it('uploads a series Etar turned into a single event as the removal of its rule', async () => {
    const h = real();
    const series = h.server.addEvent('a', {
      uid: 'series-uid',
      title: 'Standup',
      start: '2026-09-28T09:00:00',
      duration: 'PT15M',
      timeZone: 'Europe/Berlin',
      keywords: { team: true },
      recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily' },
      calendarIds: { [h.calendar]: true },
    });
    await h.run(CALENDAR_AUTHORITY);
    const old = h.events().find((e) => e._sync_id === `a/${series}`)!;

    const single = etarReinsert(h, old, Number(old.calendar_id), {
      [Events.RRULE]: null,
      [Events.DURATION]: null,
      [Events.DTEND]: Number(old[Events.DTSTART]) + 15 * 60_000,
    });
    const report = await h.run(CALENDAR_AUTHORITY);

    expect(report).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { created: 0, updated: 1, deleted: 0 } } });
    expect(h.server.all('CalendarEvent', 'a')).toHaveLength(1);
    const event = h.server.get('CalendarEvent', 'a', series)!;
    expect(event).toMatchObject({ uid: 'series-uid', title: 'Standup', keywords: { team: true } });
    expect(event.recurrenceRule).toBeUndefined();
    expect(h.events()).toEqual([expect.objectContaining({ _id: single, _sync_id: `a/${series}`, rrule: null, dirty: 0 })]);
  });

  it('never leaves two rows with one identity when the moved event is edited while its move uploads', async () => {
    const h = real();
    const work = h.server.addCalendar('a', { name: 'Work' });
    const lunch = h.server.addEvent('a', {
      uid: 'lunch-uid',
      title: 'Lunch',
      start: '2026-10-06T12:00:00',
      duration: 'PT1H',
      timeZone: 'Europe/Berlin',
      calendarIds: { [h.calendar]: true },
    });
    await h.run(CALENDAR_AUTHORITY);
    const old = h.events().find((e) => e._sync_id === `a/${lunch}`)!;
    const workRow = Number(h.device.rows('calendars').find((c) => c._sync_id === `a/${work}`)!._id);
    const moved = etarReinsert(h, old, workRow);
    let edited = false;
    const stop = h.server.onAfterRequest((request) => {
      if (edited || !request.methods.includes('CalendarEvent/set')) return;
      edited = true;
      h.device.user.updateEvent(moved, { [Events.TITLE]: 'Team lunch' });
    });

    await h.run(CALENDAR_AUTHORITY);
    stop();

    expect(edited).toBe(true);
    expect(sharedIdentities(h)).toEqual([]);
    expect(h.events().find((e) => Number(e._id) === moved)).toMatchObject({ title: 'Team lunch' });

    expect((await h.run(CALENDAR_AUTHORITY)).outcome).toBe('ok');
    expect(sharedIdentities(h)).toEqual([]);
    const server = h.server.all('CalendarEvent', 'a');
    expect(server.map((e) => [e.title, e.calendarIds])).toEqual([['Team lunch', { [work]: true }]]);
    expect(h.events()).toEqual([expect.objectContaining({ _id: moved, _sync_id: `a/${server[0].id}`, dirty: 0 })]);
  });

  it('pairs the rows again when an app rewrote the moved event unchanged while its move uploaded', async () => {
    const h = real();
    const work = h.server.addCalendar('a', { name: 'Work' });
    const lunch = h.server.addEvent('a', {
      uid: 'lunch-uid',
      title: 'Lunch',
      start: '2026-10-06T12:00:00',
      duration: 'PT1H',
      timeZone: 'Europe/Berlin',
      keywords: { important: true },
      organizerCalendarAddress: 'mailto:alice@example.com',
      participants: {
        me: { '@type': 'Participant', calendarAddress: 'mailto:alice@example.com', roles: { owner: true, attendee: true }, participationStatus: 'accepted' },
        bob: { '@type': 'Participant', calendarAddress: 'mailto:bob@example.com', name: 'Bob', roles: { attendee: true }, participationStatus: 'accepted' },
      },
      calendarIds: { [h.calendar]: true },
    });
    await h.run(CALENDAR_AUTHORITY);
    const old = h.events().find((e) => e._sync_id === `a/${lunch}`)!;
    const workRow = Number(h.device.rows('calendars').find((c) => c._sync_id === `a/${work}`)!._id);
    const moved = etarReinsert(h, old, workRow);
    const stop = h.server.onAfterRequest((request) => {
      if (!request.methods.includes('CalendarEvent/set')) return;
      stop();
      // Fossify's save: the same attendees, deleted and inserted again.
      const attendees = h.device.rows('attendees').filter((a) => Number(a.event_id) === moved).map(({ _id, event_id, ...a }) => a);
      h.device.user.fossifySaveEvent(moved, {}, attendees, []);
    });

    const report = await h.run(CALENDAR_AUTHORITY);

    expect(report).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { created: 0, updated: 1, deleted: 0 } } });
    expect(h.server.all('CalendarEvent', 'a')).toHaveLength(1);
    expect(h.server.get('CalendarEvent', 'a', lunch)).toMatchObject({ uid: 'lunch-uid', calendarIds: { [work]: true }, keywords: { important: true } });
    expect(h.events()).toEqual([expect.objectContaining({ _id: moved, _sync_id: `a/${lunch}`, dirty: 0 })]);
  });

  it('syncs events both ways and writes nothing for its own echo', async () => {
    const h = real();
    const standup = h.server.addEvent('a', {
      uid: 'e1',
      title: 'Standup',
      start: '2026-09-28T09:00:00',
      duration: 'PT15M',
      timeZone: 'Europe/Berlin',
      calendarIds: { [h.calendar]: true },
    });
    expect((await h.run(CALENDAR_AUTHORITY)).outcome).toBe('ok');
    const rowId = Number(h.device.rows('calendars')[0]._id);

    h.device.user.insertEvent(rowId, { title: 'Lunch', dtstart: Date.UTC(2026, 8, 28, 10), dtend: Date.UTC(2026, 8, 28, 11), eventTimezone: 'Europe/Berlin' });
    h.device.user.updateEvent(Number(h.events().find((e) => e.title === 'Standup')!._id), { title: 'Daily standup' });
    const up = await h.run(CALENDAR_AUTHORITY);

    expect(up).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { created: 1, updated: 1 } } });
    expect(h.server.get('CalendarEvent', 'a', standup)).toMatchObject({ title: 'Daily standup' });
    expect(h.server.all('CalendarEvent', 'a').find((e) => e.title === 'Lunch')).toMatchObject({ start: '2026-09-28T12:00:00', timeZone: 'Europe/Berlin' });
    expect(h.events().every((e) => Number(e.dirty ?? 0) === 0 && String(e._sync_id).startsWith('a/'))).toBe(true);

    const before = h.batches.log.length;
    expect((await h.run(CALENDAR_AUTHORITY)).outcome).toBe('ok');
    expect(rowWrites(h.batches.log.slice(before))).toEqual([]);
  });
});
