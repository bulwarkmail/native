// Tests for the fake JMAP server the device-sync engine tests run against:
// it has to answer like Stalwart v0.16.23 wherever the engine depends on it,
// so its own behaviour is pinned here.

import { describe, expect, it } from 'vitest';
import { JMAP_CALENDARS, JMAP_CONTACTS, JMAP_CORE, type JmapInvocation, type JmapPort } from '../types';
import { FakeJmapServer, uuid5 } from './fakes/fake-jmap-server';

const USING = [JMAP_CORE, JMAP_CONTACTS, JMAP_CALENDARS];

type Args = Record<string, any>;

/** One method call in its own request: the response name and arguments. */
async function call(port: JmapPort, name: string, args: Args): Promise<[string, Args]> {
  const { methodResponses } = await port.request([[name, args, '0']], USING);
  return [methodResponses[0][0], methodResponses[0][1] as Args];
}

function setup() {
  const server = new FakeJmapServer();
  server.addAccount('a', { name: 'alice@example.com' });
  const book = server.addAddressBook('a', { name: 'Personal' });
  const cal = server.addCalendar('a', { name: 'Calendar' });
  return { server, port: server.port(), book, cal };
}

describe('FakeJmapServer', () => {
  describe('session and ids', () => {
    it('lists the accounts with their capabilities and the primary accounts', () => {
      const server = new FakeJmapServer();
      server.addAccount('a', { name: 'alice@example.com' });
      server.addAccount('team', { name: 'Team', isPersonal: false, capabilities: ['contacts'] });

      const session = server.port().session();

      expect(session.username).toBe('alice@example.com');
      expect(session.primaryAccounts).toEqual({ [JMAP_CONTACTS]: 'a', [JMAP_CALENDARS]: 'a' });
      expect(session.accounts.team).toMatchObject({ name: 'Team', isPersonal: false, isReadOnly: false });
      expect(Object.keys(session.accounts.team.accountCapabilities)).toEqual([JMAP_CONTACTS]);
      expect(Object.keys(session.accounts.a.accountCapabilities)).toEqual([JMAP_CONTACTS, JMAP_CALENDARS]);
      expect(session.capabilities[JMAP_CORE]).toMatchObject({
        maxObjectsInGet: 500,
        maxObjectsInSet: 500,
        maxCallsInRequest: 16,
      });
      expect(server.port('alice').session().username).toBe('alice');
    });

    it('mints short ids per account and type and never reuses one', async () => {
      const server = new FakeJmapServer();
      server.addAccount('a', { name: 'alice@example.com' });
      server.addAccount('b', { name: 'bob@example.com' });

      expect(server.addAddressBook('a', { name: 'A' })).toBe('ab1');
      expect(server.addAddressBook('b', { name: 'B' })).toBe('ab1');
      expect(server.addCard('a', { uid: 'u1' })).toBe('c1');
      expect(server.addCard('b', { uid: 'u1' })).toBe('c1');
      const [, set] = await call(server.port(), 'ContactCard/set', {
        accountId: 'a',
        create: { n: { addressBookIds: { ab1: true } } },
      });
      expect(set.created).toEqual({ n: { id: 'c2' } });

      server.serverDestroy('ContactCard', 'a', 'c2');
      expect(() => server.addCard('a', { id: 'c2' })).toThrow(/never reused/);
    });

    it('stamps with an injected clock', () => {
      const t = Date.UTC(2026, 8, 27, 12, 0, 0);
      const server = new FakeJmapServer({ now: () => t });
      server.addAccount('a', { name: 'alice@example.com' });
      server.addCalendar('a', { name: 'C' });

      const id = server.addEvent('a', { title: 'x' });

      expect(server.get('CalendarEvent', 'a', id)?.updated).toBe('2026-09-27T12:00:00Z');
      expect(() => server.setTime(0)).toThrow();
    });
  });

  describe('AddressBook and Calendar', () => {
    it('returns containers with Stalwart defaults and a computed isDefault', async () => {
      const { server, port, book, cal } = setup();
      const shared = server.addAddressBook('a', {
        name: 'Shared',
        myRights: { mayRead: true, mayWrite: false, mayShare: false, mayDelete: false },
      });

      const [, books] = await call(port, 'AddressBook/get', { accountId: 'a', ids: null });
      const [, cals] = await call(port, 'Calendar/get', {
        accountId: 'a',
        ids: [cal],
        properties: ['name', 'defaultAlertsWithTime', 'nope'],
      });

      expect(books.list).toEqual([
        {
          id: book,
          name: 'Personal',
          description: null,
          sortOrder: 0,
          isDefault: true,
          isSubscribed: true,
          shareWith: null,
          myRights: { mayRead: true, mayWrite: true, mayShare: true, mayDelete: true },
        },
        expect.objectContaining({ id: shared, isDefault: false }),
      ]);
      expect(cals.list).toEqual([{ id: cal, name: 'Calendar', defaultAlertsWithTime: {}, nope: null }]);
    });

    it('forbids writes into an address book without mayWrite', async () => {
      const { server, port } = setup();
      const shared = server.addAddressBook('a', { name: 'Shared', myRights: { mayRead: true, mayWrite: false } });
      const inShared = server.addCard('a', { uid: 'u', addressBookIds: { [shared]: true } });

      const [, set] = await call(port, 'ContactCard/set', {
        accountId: 'a',
        create: { n: { addressBookIds: { [shared]: true } } },
        update: { [inShared]: { kind: 'org' } },
      });

      expect(set.notCreated.n).toEqual({
        type: 'forbidden',
        description: `You are not allowed to add contacts to address book ${shared}.`,
      });
      expect(set.notUpdated[inShared]).toEqual({
        type: 'forbidden',
        description: `You are not allowed to modify address book ${shared}.`,
      });
    });
  });

  describe('ContactCard', () => {
    it('answers a create with only the id and returns the card normalised like Stalwart', async () => {
      const { port, book } = setup();

      const [, set] = await call(port, 'ContactCard/set', {
        accountId: 'a',
        create: {
          new1: {
            addressBookIds: { [book]: true },
            uid: 'urn:uuid:1',
            name: { components: [{ kind: 'given', value: 'Jane' }, { kind: 'surname', value: 'Doe' }] },
            addresses: { home: { components: [{ kind: 'locality', value: 'Berlin' }], contexts: { private: true } } },
            titles: { t1: { name: 'CEO' } },
            anniversaries: { b: { kind: 'birth', date: { year: 1990, month: 5, day: 1 } } },
            media: { p: { kind: 'photo', uri: 'data:image/jpeg;base64,AAAA' } },
          },
        },
      });
      const [, get] = await call(port, 'ContactCard/get', { accountId: 'a', ids: ['c1'] });
      const [, update] = await call(port, 'ContactCard/set', {
        accountId: 'a',
        update: { c1: { 'name/full': 'J. Doe' } },
      });

      expect(set.created).toEqual({ new1: { id: 'c1' } });
      expect(get.list).toEqual([
        {
          id: 'c1',
          addressBookIds: { [book]: true },
          '@type': 'Card',
          version: '1.0',
          uid: 'urn:uuid:1',
          name: {
            components: [{ kind: 'given', value: 'Jane' }, { kind: 'surname', value: 'Doe' }],
            isOrdered: true,
            full: 'Jane Doe',
          },
          addresses: {
            home: { components: [{ kind: 'locality', value: 'Berlin' }], contexts: { private: true }, isOrdered: true },
          },
          titles: { t1: { name: 'CEO', kind: 'title' } },
          anniversaries: { b: { kind: 'birth', date: { '@type': 'PartialDate', year: 1990, month: 5, day: 1 } } },
          media: { p: { kind: 'photo', uri: 'data:image/jpeg;base64,AAAA' } },
        },
      ]);
      expect(update).toMatchObject({ updated: { c1: null } });
      expect(update).not.toHaveProperty('created');
    });

    it('returns only the listed properties, plus the id', async () => {
      const { server, port, book } = setup();
      const id = server.addCard('a', { uid: 'u1', kind: 'individual' });

      const [, get] = await call(port, 'ContactCard/get', {
        accountId: 'a',
        ids: [id, 'missing'],
        properties: ['uid', 'addressBookIds'],
      });

      expect(get.list).toEqual([{ id, uid: 'u1', addressBookIds: { [book]: true } }]);
      expect(get.notFound).toEqual(['missing']);
      expect(get.state).toBe(server.state('ContactCard', 'a'));
    });

    it('keeps map keys as written, slashes included, and resolves ~1 and ~0 in patch paths', async () => {
      const { server, port } = setup();
      const id = server.addCard('a', {
        emails: {
          'x/y': { address: 'a@example.com' },
          'm~n': { address: 'b@example.com' },
          e3: { address: 'c@example.com' },
        },
      });

      const [, set] = await call(port, 'ContactCard/set', {
        accountId: 'a',
        update: { [id]: { 'emails/x~1y/label': 'slash', 'emails/m~0n/label': 'tilde' } },
      });

      expect(set.updated).toEqual({ [id]: null });
      expect(server.get('ContactCard', 'a', id)?.emails).toEqual({
        'x/y': { address: 'a@example.com', label: 'slash' },
        'm~n': { address: 'b@example.com', label: 'tilde' },
        e3: { address: 'c@example.com' },
      });
    });

    it('fails a patch below a missing parent, also once the last entry of a map is gone', async () => {
      const { server, port } = setup();
      const id = server.addCard('a', { uid: 'u1' });
      const update = async (patch: Args) =>
        (await call(port, 'ContactCard/set', { accountId: 'a', update: { [id]: patch } }))[1];

      const first = await update({ 'emails/e1': { address: 'a@example.com' } });
      await update({ emails: { e1: { address: 'a@example.com' } } });
      await update({ emails: {} });
      const cardWithoutEmails = server.get('ContactCard', 'a', id);
      const again = await update({ 'emails/e2/address': 'b@example.com' });
      const wildcard = await update({ 'emails/*/label': 'x' });

      expect(first.notUpdated).toEqual({
        [id]: { type: 'invalidProperties', properties: ['emails/e1'], description: 'Patch operation failed.' },
      });
      expect(cardWithoutEmails).not.toHaveProperty('emails');
      expect(again.notUpdated[id]).toMatchObject({ properties: ['emails/e2/address'] });
      expect(wildcard.notUpdated[id]).toMatchObject({ description: 'Patch operation failed.' });
    });

    it('reads an all-digit segment as an index that can replace a member but never add one', async () => {
      const { server, port } = setup();
      const id = server.addCard('a', {
        name: { components: [{ kind: 'given', value: 'Jane' }], full: 'Jane' },
        emails: { '7': { address: 'seven@example.com' } },
      });
      const update = async (patch: Args) =>
        (await call(port, 'ContactCard/set', { accountId: 'a', update: { [id]: patch } }))[1];

      const replaced = await update({ 'name/components/0/value': 'Janet', 'emails/7/label': 'lucky' });
      const added = await update({ 'emails/8': { address: 'eight@example.com' } });
      const escaped = await update({ 'emails/a\\/b': { address: 'ab@example.com' } });

      expect(replaced.updated).toEqual({ [id]: null });
      expect(added.notUpdated[id]).toMatchObject({ properties: ['emails/8'], description: 'Patch operation failed.' });
      expect(escaped.updated).toEqual({ [id]: null });
      expect(server.get('ContactCard', 'a', id)).toMatchObject({
        name: { components: [{ kind: 'given', value: 'Janet' }] },
        emails: { '7': { address: 'seven@example.com', label: 'lucky' }, 'a/b': { address: 'ab@example.com' } },
      });
    });

    it('deletes a map entry or a property set to null', async () => {
      const { server, port } = setup();
      const id = server.addCard('a', {
        emails: { e1: { address: 'a@example.com' }, e2: { address: 'b@example.com' } },
        notes: { n1: { note: 'hi' } },
      });

      await call(port, 'ContactCard/set', { accountId: 'a', update: { [id]: { 'emails/e1': null, notes: null } } });

      const card = server.get('ContactCard', 'a', id);
      expect(card?.emails).toEqual({ e2: { address: 'b@example.com' } });
      expect(card).not.toHaveProperty('notes');
    });

    it('derives name.full once and keeps it through component patches until full is nulled', async () => {
      const { server, port } = setup();
      const id = server.addCard('a', {
        name: { components: [{ kind: 'given', value: 'Jane' }, { kind: 'surname', value: 'Doe' }] },
      });
      const separated = server.addCard('a', {
        name: {
          components: [
            { kind: 'surname', value: 'Doe' },
            { kind: 'separator', value: ', ' },
            { kind: 'given', value: 'Jane' },
          ],
        },
      });
      const renamed = [{ kind: 'given', value: 'Janet' }, { kind: 'surname', value: 'Doe' }];
      const name = () => server.get('ContactCard', 'a', id)?.name;

      const derived = name();
      await call(port, 'ContactCard/set', { accountId: 'a', update: { [id]: { 'name/components': renamed } } });
      const stale = name();
      await call(port, 'ContactCard/set', { accountId: 'a', update: { [id]: { 'name/full': null } } });

      expect(derived).toMatchObject({ full: 'Jane Doe', isOrdered: true });
      expect(stale).toMatchObject({ full: 'Jane Doe', components: renamed });
      expect(name()).toMatchObject({ full: 'Janet Doe' });
      expect(server.get('ContactCard', 'a', separated)?.name).toMatchObject({ full: 'Doe, Jane' });
    });

    it('rejects an unknown top-level property and names it', async () => {
      const { port, book } = setup();

      const [, set] = await call(port, 'ContactCard/set', {
        accountId: 'a',
        create: { n: { addressBookIds: { [book]: true }, 'example.com:foo': 1 } },
      });

      expect(set.notCreated.n).toEqual({
        type: 'invalidProperties',
        properties: ['example.com:foo'],
        description: 'Invalid property.',
      });
    });

    it('refuses a duplicate uid in the same address book and names the existing card', async () => {
      const { server, port, book } = setup();
      const work = server.addAddressBook('a', { name: 'Work' });
      const existing = server.addCard('a', { uid: 'u1' });

      const [, set] = await call(port, 'ContactCard/set', {
        accountId: 'a',
        create: {
          same: { addressBookIds: { [book]: true }, uid: 'u1' },
          elsewhere: { addressBookIds: { [work]: true }, uid: 'u1' },
        },
      });

      expect(set.notCreated).toEqual({
        same: {
          type: 'invalidProperties',
          properties: ['uid'],
          description: `Contact with UID u1 already exists with id ${existing}.`,
        },
      });
      expect(Object.keys(set.created)).toEqual(['elsewhere']);
    });

    it('checks uids against what was committed before the call, as Stalwart does', async () => {
      const { port, book } = setup();

      const [, set] = await call(port, 'ContactCard/set', {
        accountId: 'a',
        create: {
          one: { addressBookIds: { [book]: true }, uid: 'u1' },
          two: { addressBookIds: { [book]: true }, uid: 'u1' },
        },
      });

      expect(Object.keys(set.created)).toEqual(['one', 'two']);
    });

    it('lets a uid be stripped but not changed or added', async () => {
      const { server, port } = setup();
      const withUid = server.addCard('a', { uid: 'u1' });
      const without = server.addCard('a', {});

      const [, refused] = await call(port, 'ContactCard/set', {
        accountId: 'a',
        update: { [withUid]: { uid: 'u2' }, [without]: { uid: 'u3' } },
      });
      const [, stripped] = await call(port, 'ContactCard/set', { accountId: 'a', update: { [withUid]: { uid: null } } });

      expect(refused.notUpdated[withUid]).toEqual({
        type: 'invalidProperties',
        properties: ['uid'],
        description: 'You cannot change the UID of a contact.',
      });
      expect(refused.notUpdated[without]).toMatchObject({ properties: ['uid'] });
      expect(stripped.updated).toEqual({ [withUid]: null });
      expect(server.get('ContactCard', 'a', withUid)).not.toHaveProperty('uid');
    });
  });

  describe('CalendarEvent', () => {
    it('stamps updated on every write, inside overrides too', async () => {
      const { server, port, cal } = setup();
      server.setTime(Date.UTC(2026, 8, 27, 10, 0, 0));

      const [, created] = await call(port, 'CalendarEvent/set', {
        accountId: 'a',
        create: {
          e: {
            calendarIds: { [cal]: true },
            uid: 'ev-1',
            title: 'Standup',
            start: '2026-09-28T09:00:00',
            timeZone: 'Europe/Berlin',
            duration: 'PT15M',
            recurrenceRule: { frequency: 'daily' },
            updated: '2000-01-01T00:00:00Z',
          },
        },
      });
      const id = created.created.e.id;
      const afterCreate = server.get('CalendarEvent', 'a', id);
      server.advanceTime(60_000);
      await call(port, 'CalendarEvent/set', {
        accountId: 'a',
        update: {
          [id]: {
            recurrenceOverrides: {
              '2026-09-29T09:00:00': { title: 'Moved' },
              '2026-09-30T09:00:00': { excluded: true, title: 'ignored' },
            },
          },
        },
      });
      const afterOverride = server.get('CalendarEvent', 'a', id);
      server.advanceTime(60_000);
      await call(port, 'CalendarEvent/set', { accountId: 'a', update: { [id]: {} } });

      expect(created.created.e).toEqual({ id });
      expect(afterCreate).toMatchObject({
        '@type': 'Event',
        recurrenceRule: { frequency: 'daily' },
        updated: '2026-09-27T10:00:00Z',
      });
      expect(afterOverride?.updated).toBe('2026-09-27T10:01:00Z');
      expect(afterOverride?.recurrenceOverrides).toEqual({
        '2026-09-29T09:00:00': { title: 'Moved', updated: '2026-09-27T10:01:00Z' },
        '2026-09-30T09:00:00': { excluded: true },
      });
      expect(server.get('CalendarEvent', 'a', id)?.updated).toBe('2026-09-27T10:02:00Z');
    });

    it('drops empty maps inside overrides too, which an override VEVENT cannot hold', async () => {
      const { server, port, cal } = setup();
      const id = server.addEvent('a', {
        title: 'Standup',
        start: '2026-09-28T09:00:00',
        recurrenceRule: { frequency: 'daily' },
        alerts: { al1: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' } } },
        recurrenceOverrides: { '2026-09-29T09:00:00': { title: 'Late', alerts: { a2: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT1H' } } } } },
        calendarIds: { [cal]: true },
      });

      await call(port, 'CalendarEvent/set', {
        accountId: 'a',
        update: { [id]: { 'recurrenceOverrides/2026-09-29T09:00:00/alerts': {}, 'recurrenceOverrides/2026-09-29T09:00:00/locations': {} } },
      });

      // Read back without them, so the occurrence shows the series' alerts again, as on Stalwart.
      const override = (server.get('CalendarEvent', 'a', id)?.recurrenceOverrides as Record<string, Record<string, unknown>>)['2026-09-29T09:00:00'];
      expect(override).toMatchObject({ title: 'Late' });
      expect(override).not.toHaveProperty('alerts');
      expect(override).not.toHaveProperty('locations');
    });

    it('leaves useDefaultAlerts out of properties: null and returns it when listed', async () => {
      const { server, port, cal } = setup();
      const id = server.addEvent('a', { title: 'x', useDefaultAlerts: true, calendarIds: { [cal]: true } });

      const [, all] = await call(port, 'CalendarEvent/get', { accountId: 'a', ids: [id], properties: null });
      const [, listed] = await call(port, 'CalendarEvent/get', {
        accountId: 'a',
        ids: [id],
        properties: ['title', 'useDefaultAlerts'],
      });

      expect(all.list[0]).not.toHaveProperty('useDefaultAlerts');
      expect(all.list[0]).toMatchObject({ id, calendarIds: { [cal]: true }, isDraft: false, isOrigin: true, title: 'x' });
      expect(listed.list).toEqual([{ id, title: 'x', useDefaultAlerts: true }]);
    });

    it.each([
      ['recurrenceRules', [{ frequency: 'daily' }]],
      ['excludedRecurrenceRule', { frequency: 'daily' }],
      ['excludedRecurrenceRules', [{ frequency: 'daily' }]],
      ['timeZones', {}],
      ['progressUpdated', '2026-01-01T00:00:00Z'],
      ['isOrigin', true],
    ])('rejects %s on create and update', async (property, value) => {
      const { server, port, cal } = setup();
      const id = server.addEvent('a', { title: 'x' });

      const [, set] = await call(port, 'CalendarEvent/set', {
        accountId: 'a',
        create: { n: { calendarIds: { [cal]: true }, title: 'y', [property]: value } },
        update: { [id]: { [property]: value } },
      });

      expect(set.notCreated.n).toMatchObject({ type: 'invalidProperties', properties: [property] });
      expect(set.notUpdated[id]).toMatchObject({ type: 'invalidProperties', properties: [property] });
    });

    it('fails a recurrenceOverrides/<rid> patch until the event has overrides', async () => {
      const { server, port } = setup();
      const id = server.addEvent('a', {
        title: 'x',
        start: '2026-10-01T09:00:00',
        recurrenceRule: { frequency: 'weekly' },
      });
      const pointer = 'recurrenceOverrides/2026-10-08T09:00:00';
      const update = async (patch: Args) =>
        (await call(port, 'CalendarEvent/set', { accountId: 'a', update: { [id]: patch } }))[1];

      const refused = await update({ [pointer]: { excluded: true } });
      await update({ recurrenceOverrides: { '2026-10-08T09:00:00': { excluded: true } } });
      const accepted = await update({ 'recurrenceOverrides/2026-10-15T09:00:00': { excluded: true } });

      expect(refused.notUpdated[id]).toEqual({
        type: 'invalidProperties',
        properties: [pointer],
        description: 'Patch operation failed.',
      });
      expect(accepted.updated).toEqual({ [id]: null });
      expect(Object.keys(server.get('CalendarEvent', 'a', id)?.recurrenceOverrides as Args)).toEqual([
        '2026-10-08T09:00:00',
        '2026-10-15T09:00:00',
      ]);
    });

    it('refuses a duplicate uid anywhere in the account without naming the event', async () => {
      const { server, port } = setup();
      const other = server.addCalendar('a', { name: 'Other' });
      server.addEvent('a', { uid: 'ev-1', title: 'x' });

      const [, set] = await call(port, 'CalendarEvent/set', {
        accountId: 'a',
        create: { n: { calendarIds: { [other]: true }, uid: 'ev-1', title: 'y' } },
      });

      expect(set.notCreated.n).toEqual({
        type: 'invalidProperties',
        properties: ['uid'],
        description: 'An event with UID ev-1 already exists.',
      });
    });

    it('generates a uid when a create has none', async () => {
      const { server, port, cal } = setup();

      const [, set] = await call(port, 'CalendarEvent/set', {
        accountId: 'a',
        create: { n: { calendarIds: { [cal]: true }, title: 'x' } },
      });

      expect(server.get('CalendarEvent', 'a', set.created.n.id)?.uid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
    });

    it('returns tasks with @type Task', async () => {
      const { server, port } = setup();
      const id = server.addEvent('a', { '@type': 'Task', title: 'Pay rent', due: '2026-10-01T00:00:00' });

      const [, get] = await call(port, 'CalendarEvent/get', { accountId: 'a', ids: [id], properties: ['@type', 'title'] });

      expect(get.list).toEqual([{ id, '@type': 'Task', title: 'Pay rent' }]);
    });

    it('records sendSchedulingMessages without sending anything', async () => {
      const { server, port, cal } = setup();
      const id = server.addEvent('a', { title: 'x' });

      await call(port, 'CalendarEvent/set', {
        accountId: 'a',
        sendSchedulingMessages: true,
        create: { n: { calendarIds: { [cal]: true }, title: 'y' } },
        update: { [id]: { title: 'z' } },
      });
      await call(port, 'CalendarEvent/set', { accountId: 'a', destroy: [id] });

      expect(server.scheduling.map(({ op }) => op)).toEqual(['create', 'update']);
    });

    it('makes the account the organizer of an event created with attendees', async () => {
      const { server, port, cal } = setup();

      const [, set] = await call(port, 'CalendarEvent/set', {
        accountId: 'a',
        create: {
          n: {
            calendarIds: { [cal]: true },
            title: 'Meet',
            participants: { p1: { calendarAddress: 'mailto:bob@example.com', roles: { attendee: true } } },
          },
        },
      });

      const event = server.get('CalendarEvent', 'a', set.created.n.id);
      expect(event?.organizerCalendarAddress).toBe('mailto:alice@example.com');
      expect(event?.participants).toEqual({
        p1: { '@type': 'Participant', calendarAddress: 'mailto:bob@example.com', roles: { attendee: true } },
        [uuid5('mailto:alice@example.com')]: {
          '@type': 'Participant',
          calendarAddress: 'mailto:alice@example.com',
          roles: { owner: true },
        },
      });
    });

    it('copies the default alerts of the calendar into an event created with useDefaultAlerts', async () => {
      const { server, port } = setup();
      const cal = server.addCalendar('a', {
        name: 'With alerts',
        defaultAlertsWithTime: { d1: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' } } },
      });

      const [, set] = await call(port, 'CalendarEvent/set', {
        accountId: 'a',
        create: {
          n: { calendarIds: { [cal]: true }, title: 'x', useDefaultAlerts: true, alerts: { mine: { trigger: { offset: '-PT5M' } } } },
        },
      });

      expect(server.get('CalendarEvent', 'a', set.created.n.id)?.alerts).toEqual({
        mine: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT5M' } },
        k2: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' } },
      });
    });

    it('returns at most maxObjectsInGet objects for ids: null', async () => {
      const { server, port } = setup();
      for (let i = 0; i < 501; i++) server.addEvent('a', { title: `e${i}` });

      const [, get] = await call(port, 'CalendarEvent/get', { accountId: 'a', ids: null, properties: ['title'] });

      expect(get.list).toHaveLength(500);
      expect(get.list[0]).toEqual({ id: 'ev1', title: 'e0' });
    });
  });

  describe('/changes', () => {
    it('compacts a window like Stalwart and reports a no-op patch as an update', async () => {
      const { server, port } = setup();
      const kept = server.addCard('a', { uid: 'kept' });
      const doomed = server.addCard('a', { uid: 'doomed' });
      const since = server.state('ContactCard', 'a');

      const created = server.addCard('a', { uid: 'created' });
      server.serverUpdate('ContactCard', 'a', created, { kind: 'individual' });
      const flash = server.addCard('a', { uid: 'flash' });
      await call(port, 'ContactCard/set', { accountId: 'a', destroy: [flash] });
      server.serverUpdate('ContactCard', 'a', doomed, { kind: 'individual' });
      await call(port, 'ContactCard/set', { accountId: 'a', destroy: [doomed] });
      await call(port, 'ContactCard/set', { accountId: 'a', update: { [kept]: {} } });
      const [, changes] = await call(port, 'ContactCard/changes', { accountId: 'a', sinceState: since });

      expect(changes).toEqual({
        accountId: 'a',
        oldState: since,
        newState: server.state('ContactCard', 'a'),
        hasMoreChanges: false,
        created: [created],
        updated: [kept],
        destroyed: [doomed],
      });
    });

    it('reports a membership-only change as an update', async () => {
      const { server, port, book } = setup();
      const work = server.addAddressBook('a', { name: 'Work' });
      const id = server.addCard('a', { uid: 'u' });
      const since = server.state('ContactCard', 'a');

      await call(port, 'ContactCard/set', { accountId: 'a', update: { [id]: { [`addressBookIds/${work}`]: true } } });
      const [, changes] = await call(port, 'ContactCard/changes', { accountId: 'a', sinceState: since });

      expect(changes.updated).toEqual([id]);
      expect(server.get('ContactCard', 'a', id)?.addressBookIds).toEqual({ [book]: true, [work]: true });
    });

    it('keeps address books and cards in one log but reports each type on its own', async () => {
      const { server, port } = setup();
      const cardsSince = server.state('ContactCard', 'a');
      const booksSince = server.state('AddressBook', 'a');

      const book2 = server.addAddressBook('a', { name: 'Second' });
      const card = server.addCard('a', { uid: 'u' });
      const [, books] = await call(port, 'AddressBook/changes', { accountId: 'a', sinceState: booksSince });
      const [, cards] = await call(port, 'ContactCard/changes', { accountId: 'a', sinceState: cardsSince });

      expect(cardsSince).toBe('n');
      expect(booksSince).toMatch(/^s/);
      expect(books).toMatchObject({ created: [book2], updated: [], destroyed: [], newState: server.state('AddressBook', 'a') });
      expect(cards).toMatchObject({ created: [card], updated: [], destroyed: [], newState: server.state('ContactCard', 'a') });
      expect(books.newState).not.toBe(cards.newState);
      expect(server.state('CalendarEvent', 'a')).toBe('n');
    });

    it('pages with maxChanges through intermediate states', async () => {
      const { server, port } = setup();
      const ids = [1, 2, 3, 4, 5].map((n) => server.addCard('a', { uid: `u${n}` }));

      const pages: Args[] = [];
      let state = 'n';
      let late = '';
      for (;;) {
        const [, page] = await call(port, 'ContactCard/changes', { accountId: 'a', sinceState: state, maxChanges: 2 });
        pages.push(page);
        state = page.newState;
        if (!late) late = server.addCard('a', { uid: 'late' });
        if (!page.hasMoreChanges) break;
      }
      const [, rest] = await call(port, 'ContactCard/changes', { accountId: 'a', sinceState: state, maxChanges: 2 });

      expect(pages.map((p) => p.created)).toEqual([ids.slice(0, 2), ids.slice(2, 4), ids.slice(4)]);
      expect(pages.map((p) => p.hasMoreChanges)).toEqual([true, true, false]);
      expect(pages[0].newState).toMatch(/^r/);
      expect(pages[1].newState).toMatch(/^r/);
      expect(pages[2].newState).toMatch(/^s/);
      expect(rest).toMatchObject({ created: [late], hasMoreChanges: false, newState: server.state('ContactCard', 'a') });
    });

    it('answers cannotCalculateChanges from a state older than the truncated log', async () => {
      const { server, port } = setup();
      server.addCard('a', { uid: 'u1' });
      const old = server.state('ContactCard', 'a');
      server.addCard('a', { uid: 'u2' });
      const recent = server.state('ContactCard', 'a');
      const newest = server.addCard('a', { uid: 'u3' });
      const changesSince = async (sinceState: string) =>
        call(port, 'ContactCard/changes', { accountId: 'a', sinceState });

      server.truncateChangeLog('a', 'contacts', 1);
      const fromOld = await changesSince(old);
      const fromRecent = await changesSince(recent);
      server.truncateChangeLog('a', 'ContactCard');
      const fromRecentAgain = await changesSince(recent);
      const current = server.state('ContactCard', 'a');
      const fromCurrent = await changesSince(current);

      expect(fromOld).toEqual(['error', { type: 'cannotCalculateChanges', description: 'Change log is truncated' }]);
      expect(fromRecent[1].created).toEqual([newest]);
      expect(fromRecentAgain[1].type).toBe('cannotCalculateChanges');
      expect(fromCurrent[1]).toMatchObject({ created: [], updated: [], destroyed: [], newState: current });
    });

    it('answers cannotCalculateChanges for a state the log never reached', async () => {
      const busy = new FakeJmapServer();
      busy.addAccount('a', { name: 'alice@example.com' });
      busy.addAddressBook('a', { name: 'Personal' });
      for (let i = 0; i < 10; i++) busy.addCard('a', { uid: `u${i}` });
      const { server, port } = setup();
      server.addCard('a', { uid: 'u' });

      const [, error] = await call(port, 'ContactCard/changes', {
        accountId: 'a',
        sinceState: busy.state('ContactCard', 'a'),
      });

      expect(error).toEqual({ type: 'cannotCalculateChanges', description: 'Since state is invalid' });
    });
  });

  describe('ifInState', () => {
    it('refuses a /set unless ifInState is the current state', async () => {
      const { server, port } = setup();
      const id = server.addCard('a', { uid: 'u' });
      const stale = server.state('ContactCard', 'a');
      server.serverUpdate('ContactCard', 'a', id, { kind: 'individual' });
      const current = server.state('ContactCard', 'a');

      const refused = await call(port, 'ContactCard/set', { accountId: 'a', ifInState: stale, update: { [id]: { kind: 'org' } } });
      const unchanged = server.get('ContactCard', 'a', id)?.kind;
      const [, accepted] = await call(port, 'ContactCard/set', {
        accountId: 'a',
        ifInState: current,
        update: { [id]: { kind: 'org' } },
      });

      expect(refused).toEqual(['error', { type: 'stateMismatch' }]);
      expect(unchanged).toBe('individual');
      expect(accepted).toMatchObject({ oldState: current, updated: { [id]: null } });
      expect(accepted.newState).not.toBe(current);
      expect(accepted.newState).toBe(server.state('ContactCard', 'a'));
    });

    it('sees a concurrent change made while the request is in flight', async () => {
      const { server, port } = setup();
      const id = server.addCard('a', { uid: 'u' });
      const state = server.state('ContactCard', 'a');
      const stop = server.onBeforeRequest((request) => {
        if (request.methods.includes('ContactCard/set')) server.serverUpdate('ContactCard', 'a', id, { kind: 'org' });
      });

      const [, error] = await call(port, 'ContactCard/set', {
        accountId: 'a',
        ifInState: state,
        update: { [id]: { kind: 'individual' } },
      });
      stop();

      expect(error).toEqual({ type: 'stateMismatch' });
    });
  });

  describe('uid index', () => {
    it('finds a new object by uid only after the configured lag', async () => {
      const { server, port, book } = setup();
      server.setUidIndexLag(1);
      const [, set] = await call(port, 'ContactCard/set', {
        accountId: 'a',
        create: { n: { addressBookIds: { [book]: true }, uid: 'u1' } },
      });
      const id = set.created.n.id;
      const byUid = { accountId: 'a', filter: { uid: 'u1', inAddressBook: book } };

      const { methodResponses: next } = await port.request(
        [
          ['ContactCard/query', byUid, 'uid'],
          ['ContactCard/query', { accountId: 'a', filter: { inAddressBook: book } }, 'book'],
        ],
        USING,
      );
      const [, later] = await call(port, 'ContactCard/query', byUid);

      expect(next[0][1].ids).toEqual([]);
      expect(next[1][1].ids).toEqual([id]);
      expect(later.ids).toEqual([id]);
    });

    it('finds objects by uid at once without a lag', async () => {
      const { server, port, cal } = setup();
      const id = server.addEvent('a', { uid: 'ev-1', title: 'x' });

      const [, query] = await call(port, 'CalendarEvent/query', { accountId: 'a', filter: { uid: 'ev-1', inCalendar: cal } });

      expect(query.ids).toEqual([id]);
    });
  });

  describe('fault injection', () => {
    it.each([
      ['network', 'NetworkError'],
      ['timeout', 'RequestTimeoutError'],
      ['auth', 'AuthenticationError'],
      ['rateLimit', 'RateLimitError'],
    ] as const)('fails the next request with %s before anything runs', async (kind, name) => {
      const { server, port, book } = setup();
      server.failNextRequest(kind, { retryAfterMs: 7000 });
      const create: JmapInvocation[] = [
        ['ContactCard/set', { accountId: 'a', create: { n: { addressBookIds: { [book]: true } } } }, '0'],
      ];

      const error = await port.request(create, USING).catch((e: Error & { retryAfterMs?: number }) => e);
      const cardsAfterFailure = server.all('ContactCard', 'a');
      const record = server.requests.at(-1);
      await port.request(create, USING);

      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({ name });
      if (kind === 'rateLimit') expect(error).toMatchObject({ retryAfterMs: 7000 });
      expect(cardsAfterFailure).toEqual([]);
      expect(record).toMatchObject({ outcome: 'failed', fault: kind, responses: null });
      expect(server.all('ContactCard', 'a')).toHaveLength(1);
    });

    it('applies a request and then loses the response', async () => {
      const { server, port, book } = setup();
      server.setUidIndexLag(2);
      server.applyThenLoseResponse();
      const create: JmapInvocation[] = [
        ['ContactCard/set', { accountId: 'a', create: { n: { addressBookIds: { [book]: true }, uid: 'u1' } } }, '0'],
      ];

      await expect(port.request(create, USING)).rejects.toMatchObject({ name: 'NetworkError' });
      const [card] = server.all('ContactCard', 'a');
      const record = server.requests.at(-1);
      // The retry protocol: the uid query can miss the card, the duplicate check cannot.
      const [, query] = await call(port, 'ContactCard/query', { accountId: 'a', filter: { uid: 'u1', inAddressBook: book } });
      const { methodResponses } = await port.request(create, USING);

      expect(card).toMatchObject({ uid: 'u1' });
      expect(record).toMatchObject({ outcome: 'lost', fault: 'network' });
      expect(record?.responses?.[0][1]).toMatchObject({ created: { n: { id: card.id } } });
      expect(query.ids).toEqual([]);
      expect((methodResponses[0][1] as Args).notCreated.n.description).toBe(
        `Contact with UID u1 already exists with id ${card.id}.`,
      );
    });

    it('fails only a request that matches', async () => {
      const { server, port, book } = setup();
      server.failNextRequest('network', { match: 'ContactCard/set' });

      const get = await call(port, 'ContactCard/get', { accountId: 'a', ids: [] });
      const set = call(port, 'ContactCard/set', { accountId: 'a', create: { n: { addressBookIds: { [book]: true } } } });

      expect(get[0]).toBe('ContactCard/get');
      await expect(set).rejects.toMatchObject({ name: 'NetworkError' });
    });

    it('answers the next /set touching an object with an injected SetError, once', async () => {
      const { server, port, book } = setup();
      const id = server.addCard('a', { uid: 'u1' });
      server.setErrorFor('ContactCard', 'a', id, { type: 'forbidden', description: 'read-only' });
      server.setErrorFor('ContactCard', 'a', 'u2', { type: 'overQuota' });
      const args = {
        accountId: 'a',
        update: { [id]: { kind: 'org' } },
        create: { n: { addressBookIds: { [book]: true }, uid: 'u2' } },
      };

      const [, first] = await call(port, 'ContactCard/set', args);
      const untouched = server.get('ContactCard', 'a', id);
      const [, second] = await call(port, 'ContactCard/set', args);

      expect(first.notUpdated).toEqual({ [id]: { type: 'forbidden', description: 'read-only' } });
      expect(first.notCreated).toEqual({ n: { type: 'overQuota' } });
      expect(first.newState).toBe(first.oldState);
      expect(untouched).not.toHaveProperty('kind');
      expect(second.updated).toEqual({ [id]: null });
      expect(Object.keys(second.created)).toEqual(['n']);
    });

    it('answers the next call of a method with an injected method error', async () => {
      const { server, port } = setup();
      server.failNextMethod('ContactCard/set', { type: 'serverUnavailable' });

      const first = await call(port, 'ContactCard/set', { accountId: 'a', update: {} });
      const second = await call(port, 'ContactCard/set', { accountId: 'a', update: {} });

      expect(first).toEqual(['error', { type: 'serverUnavailable' }]);
      expect(second[0]).toBe('ContactCard/set');
    });

    it('serves blobs and can fail a download', async () => {
      const { server, port } = setup();
      const blobId = server.addBlob('a', 'photo-bytes');
      server.failNextDownload('timeout');

      await expect(port.downloadBlob('a', blobId)).rejects.toMatchObject({ name: 'RequestTimeoutError' });
      expect(new TextDecoder().decode(await port.downloadBlob('a', blobId))).toBe('photo-bytes');
      await expect(port.downloadBlob('a', 'missing')).rejects.toThrow('404');
    });
  });

  describe('positional re-keying', () => {
    it('gives card entries positional keys, as Stalwart does for a card written over CardDAV', async () => {
      const { server, port } = setup();
      const id = server.addCard('a', {
        emails: { work: { address: 'w@example.com' }, home: { address: 'h@example.com' } },
        organizations: { acme: { name: 'Acme' } },
        titles: { boss: { name: 'CEO', organizationId: 'acme' } },
        relatedTo: { 'urn:uuid:x': { relation: { friend: true } } },
      });
      const since = server.state('ContactCard', 'a');

      server.rekeyPositionally('a', id);
      const [, changes] = await call(port, 'ContactCard/changes', { accountId: 'a', sinceState: since });

      expect(server.get('ContactCard', 'a', id)).toMatchObject({
        emails: { k1: { address: 'w@example.com' }, k2: { address: 'h@example.com' } },
        organizations: { k1: { name: 'Acme' } },
        titles: { k1: { name: 'CEO', organizationId: 'k1', kind: 'title' } },
        relatedTo: { 'urn:uuid:x': { relation: { friend: true } } },
      });
      expect(Object.keys(server.get('ContactCard', 'a', id)?.emails as Args)).toEqual(['k1', 'k2']);
      expect(changes.updated).toEqual([id]);
    });

    it('keys event alerts by position and participants, locations and links by uuid5', () => {
      const { server } = setup();
      const id = server.addEvent('a', {
        title: 'x',
        alerts: { a1: { trigger: { offset: '-PT5M' } }, a2: { trigger: { offset: '-PT1H' } } },
        participants: { p1: { calendarAddress: 'mailto:foo@example.com', locationId: 'l1' } },
        locations: { l1: { name: 'Room 1' } },
        mainLocationId: 'l1',
        links: { x: { href: 'https://example.com/foo.pdf' } },
      });

      server.rekeyPositionally('a', id);

      const event = server.get('CalendarEvent', 'a', id) as Args;
      const room = uuid5('Room 1');
      expect(Object.keys(event.alerts)).toEqual(['k1', 'k2']);
      expect(event.participants).toEqual({
        '59eb121c-e8f2-558a-9049-ef750a5976bd': {
          '@type': 'Participant',
          calendarAddress: 'mailto:foo@example.com',
          locationId: room,
        },
      });
      expect(Object.keys(event.locations)).toEqual([room]);
      expect(event.mainLocationId).toBe(room);
      expect(Object.keys(event.links)).toEqual(['245708bf-8e07-5d3b-a5da-2974a63c3b91']);
    });

    it('computes uuid5 keys as calcard does', () => {
      expect(uuid5('mailto:hcabot@example.com')).toBe('0b235cc4-f04d-5fc4-98a3-c066650b3fbf');
      expect(uuid5('mailto:organizer@example.com')).toBe('251d3e9f-d83f-534c-8c45-c2896c75670c');
      expect(uuid5('mailto:bar@example.com')).toBe('5b6f4fa0-3695-53a7-904b-d0a6f8bc326f');
    });
  });

  describe('result references', () => {
    it('resolves #ids from /query and /changes results', async () => {
      const { server, port, book } = setup();
      const c0 = server.addCard('a', { uid: 'u0' });
      const since = server.state('ContactCard', 'a');
      server.serverUpdate('ContactCard', 'a', c0, { kind: 'org' });
      const c1 = server.addCard('a', { uid: 'u1' });

      const { methodResponses } = await port.request(
        [
          ['ContactCard/query', { accountId: 'a', filter: { inAddressBook: book } }, 'q'],
          ['ContactCard/get', { accountId: 'a', '#ids': { resultOf: 'q', name: 'ContactCard/query', path: '/ids' }, properties: ['uid'] }, 'g'],
          ['ContactCard/changes', { accountId: 'a', sinceState: since }, 'c'],
          ['ContactCard/get', { accountId: 'a', '#ids': { resultOf: 'c', name: 'ContactCard/changes', path: '/created' }, properties: ['uid'] }, 'gc'],
          ['ContactCard/get', { accountId: 'a', '#ids': { resultOf: 'c', name: 'ContactCard/changes', path: '/updated' }, properties: ['uid'] }, 'gu'],
        ],
        USING,
      );

      expect(methodResponses[1][1].list).toEqual([{ id: c0, uid: 'u0' }, { id: c1, uid: 'u1' }]);
      expect(methodResponses[3][1].list).toEqual([{ id: c1, uid: 'u1' }]);
      expect(methodResponses[4][1].list).toEqual([{ id: c0, uid: 'u0' }]);
    });

    it('refuses a reference to a /set result or to a call that is not there', async () => {
      const { port, book } = setup();

      const { methodResponses } = await port.request(
        [
          ['ContactCard/set', { accountId: 'a', create: { n: { addressBookIds: { [book]: true } } } }, 's'],
          ['ContactCard/get', { accountId: 'a', '#ids': { resultOf: 's', name: 'ContactCard/set', path: '/created/n/id' } }, 'g'],
          ['ContactCard/get', { accountId: 'a', '#ids': { resultOf: 'missing', name: 'ContactCard/query', path: '/ids' } }, 'm'],
        ],
        USING,
      );

      expect(methodResponses[0][0]).toBe('ContactCard/set');
      expect(methodResponses[1]).toEqual([
        'error',
        { type: 'invalidResultReference', description: 'Result reference to s#ContactCard/set not found.' },
        'g',
      ]);
      expect(methodResponses[2][1]).toMatchObject({ type: 'invalidResultReference' });
    });
  });

  describe('limits and method errors', () => {
    it('rejects a request with too many calls before running any of them', async () => {
      const { server, port, book } = setup();
      server.setLimits({ maxCallsInRequest: 2 });
      const calls: JmapInvocation[] = [
        ['ContactCard/set', { accountId: 'a', create: { n: { addressBookIds: { [book]: true } } } }, '0'],
        ['Core/echo', {}, '1'],
        ['Core/echo', {}, '2'],
      ];

      await expect(port.request(calls, USING)).rejects.toThrow(/maxCallsInRequest/);

      expect(port.session().capabilities[JMAP_CORE]).toMatchObject({ maxCallsInRequest: 2 });
      expect(server.all('ContactCard', 'a')).toEqual([]);
      expect(server.requests.at(-1)?.outcome).toBe('rejected');
    });

    it('counts how many requests were in flight at once', async () => {
      const { server, port } = setup();

      await call(port, 'Core/echo', {});
      await call(port, 'Core/echo', {});
      const sequential = server.maxInFlight;
      await Promise.all([call(port, 'Core/echo', {}), call(port, 'Core/echo', {})]);

      expect(sequential).toBe(1);
      expect(server.maxInFlight).toBe(2);
    });

    it('answers requestTooLarge for too many ids in /get or objects in /set', async () => {
      const { server, port, book } = setup();
      server.setLimits({ maxObjectsInGet: 2, maxObjectsInSet: 1 });
      for (let i = 0; i < 3; i++) server.addCard('a', { uid: `u${i}` });

      const get = await call(port, 'ContactCard/get', { accountId: 'a', ids: ['x', 'y', 'z'] });
      const set = await call(port, 'ContactCard/set', {
        accountId: 'a',
        create: { one: { addressBookIds: { [book]: true } }, two: { addressBookIds: { [book]: true } } },
      });
      const [, all] = await call(port, 'ContactCard/get', { accountId: 'a', ids: null });

      expect(get).toEqual(['error', { type: 'requestTooLarge' }]);
      expect(set).toEqual(['error', { type: 'requestTooLarge' }]);
      expect(all.list).toHaveLength(2);
    });

    it('answers unknownMethod for unknown methods and for capabilities missing from using', async () => {
      const { port } = setup();

      const { methodResponses } = await port.request(
        [
          ['Foo/get', {}, 'f'],
          ['ContactCard/get', { accountId: 'a', ids: [] }, 'c'],
          ['Core/echo', { hello: 1 }, 'e'],
          ['CalendarEvent/get', { accountId: 'nobody', ids: [] }, 'x'],
        ],
        [JMAP_CORE, JMAP_CALENDARS],
      );

      expect(methodResponses[0]).toEqual(['error', expect.objectContaining({ type: 'unknownMethod' }), 'f']);
      expect(methodResponses[1][1]).toMatchObject({ type: 'unknownMethod' });
      expect(methodResponses[2]).toEqual(['Core/echo', { hello: 1 }, 'e']);
      expect(methodResponses[3]).toEqual(['error', { type: 'accountNotFound' }, 'x']);
    });
  });

  describe('/query', () => {
    it('filters by address book and pages by position and limit, in id order', async () => {
      const { server, port, book } = setup();
      const other = server.addAddressBook('a', { name: 'Other' });
      const ids = Array.from({ length: 7 }, (_, i) => server.addCard('a', { uid: `u${i}` }));
      server.addCard('a', { uid: 'elsewhere', addressBookIds: { [other]: true } });
      const page = async (position: number) =>
        (
          await call(port, 'ContactCard/query', {
            accountId: 'a',
            filter: { inAddressBook: book },
            position,
            limit: 3,
            calculateTotal: true,
          })
        )[1];

      const first = await page(0);
      const second = await page(3);
      const third = await page(6);
      server.setLimits({ maxQueryResults: 4 });
      const [, capped] = await call(port, 'ContactCard/query', { accountId: 'a', limit: 10 });

      expect(first).toMatchObject({ ids: ids.slice(0, 3), position: 0, total: 7, limit: 3 });
      expect(first.queryState).toBe(server.state('ContactCard', 'a'));
      expect(second.ids).toEqual(ids.slice(3, 6));
      expect(third.ids).toEqual(ids.slice(6));
      expect(capped).toMatchObject({ ids: ids.slice(0, 4), limit: 4 });
    });

    it('refuses a filter it does not emulate', async () => {
      const { port } = setup();

      const [, error] = await call(port, 'ContactCard/query', { accountId: 'a', filter: { text: 'x' } });

      expect(error.type).toBe('unsupportedFilter');
    });
  });

  describe('edits by another client', () => {
    it('destroys an address book with the cards only it holds', async () => {
      const { server, port, book } = setup();
      const other = server.addAddressBook('a', { name: 'Other' });
      const only = server.addCard('a', { uid: 'only' });
      const both = server.addCard('a', { uid: 'both', addressBookIds: { [book]: true, [other]: true } });
      const cardsSince = server.state('ContactCard', 'a');
      const booksSince = server.state('AddressBook', 'a');

      server.serverDestroy('AddressBook', 'a', book);
      const [, cards] = await call(port, 'ContactCard/changes', { accountId: 'a', sinceState: cardsSince });
      const [, books] = await call(port, 'AddressBook/changes', { accountId: 'a', sinceState: booksSince });

      expect(cards).toMatchObject({ created: [], updated: [both], destroyed: [only] });
      expect(books).toMatchObject({ created: [], updated: [], destroyed: [book] });
      expect(server.get('ContactCard', 'a', both)?.addressBookIds).toEqual({ [other]: true });
      expect(server.get('AddressBook', 'a', other)?.isDefault).toBe(true);
    });

    it('patches with JSON Pointers and stamps events unless the patch sets updated', () => {
      const { server } = setup();
      server.setTime(Date.UTC(2026, 0, 2));
      const id = server.addEvent('a', { title: 'x', locations: { l1: { name: 'Old' } } });

      server.advanceTime(1000);
      server.serverUpdate('CalendarEvent', 'a', id, { 'locations/l1/name': 'New' });
      const stamped = server.get('CalendarEvent', 'a', id);
      server.serverUpdate('CalendarEvent', 'a', id, { title: 'y', updated: '2020-01-01T00:00:00Z' });

      expect(stamped).toMatchObject({ locations: { l1: { name: 'New' } }, updated: '2026-01-02T00:00:01Z' });
      expect(server.get('CalendarEvent', 'a', id)?.updated).toBe('2020-01-01T00:00:00Z');
      expect(() => server.serverUpdate('CalendarEvent', 'a', id, { 'alerts/k1': {} })).toThrow(/Patch operation failed/);
    });
  });
});
