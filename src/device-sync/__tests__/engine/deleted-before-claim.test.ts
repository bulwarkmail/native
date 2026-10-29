// Items created on the device and deleted before any run claimed them.
// ContactsProvider soft-deletes every raw contact and group of a sync account
// (DELETED=1, SOURCE_ID NULL), CalendarProvider hard-deletes an event without
// `_SYNC_ID` at once. Such an item never reached the server: it is purged,
// nothing uploads, and it never counts as a change waiting for an upload.

import { describe, expect, it } from 'vitest';
import { calendarPlanner } from '../../calendar/planner';
import { contactsPlanner } from '../../contacts/planner';
import {
  addDeviceContact,
  addServerCards,
  ANDROID_ACCOUNT,
  CALENDAR_AUTHORITY,
  CONTACTS_AUTHORITY,
  createHarness,
  type Harness,
} from './harness';

function real(): Harness {
  const h = createHarness();
  h.deps.planners = { contacts: contactsPlanner, calendar: calendarPlanner };
  return h;
}

/** Synced once, then a contact and a group created on the device and deleted again. */
async function createdAndDeleted(): Promise<{ h: Harness; contact: number; group: number }> {
  const h = real();
  addServerCards(h, ['Ada Lovelace']);
  expect((await h.run()).outcome).toBe('ok');
  const contact = addDeviceContact(h, 'Hedy Lamarr');
  h.device.user.deleteContact(contact);
  const group = h.device.user.insertGroup(ANDROID_ACCOUNT, 'Friends');
  h.device.user.deleteGroup(group);
  return { h, contact, group };
}

function offline(h: Harness): void {
  h.deps.jmap = async () => {
    const error = new Error('Network request failed');
    error.name = 'NetworkError';
    throw error;
  };
}

describe('device sync engine: an item deleted on the device before it was claimed', () => {
  it('purges a contact and a group, and uploads nothing', async () => {
    const { h, contact, group } = await createdAndDeleted();

    const report = await h.run();

    expect(report).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { created: 0, updated: 0, deleted: 0 } } });
    expect(h.device.row('raw_contacts', contact)).toBeUndefined();
    expect(h.device.rows('data', 'raw_contact_id = ?', [contact])).toEqual([]);
    expect(h.device.row('groups', group)).toBeUndefined();
    expect(h.server.all('ContactCard', 'a').map((c) => c.name)).toEqual([{ full: 'Ada Lovelace' }]);
  });

  it('does not turn an upload-only sync into a full one', async () => {
    const { h } = await createdAndDeleted();
    const requests = h.server.requests.length;

    expect((await h.run(CONTACTS_AUTHORITY, { upload: true })).outcome).toBe('ok');

    expect(h.server.requests.length).toBe(requests);
  });

  it('is no change that turning sync off would lose, also while offline', async () => {
    const { h } = await createdAndDeleted();
    offline(h);

    expect(await h.teardown(CONTACTS_AUTHORITY)).toEqual({ pending: 0 });

    expect(h.device.rows('raw_contacts')).toEqual([]);
    expect(h.device.rows('groups')).toEqual([]);
  });

  it('leaves nothing behind for an event: CalendarProvider removes it at once', async () => {
    const h = real();
    expect((await h.run(CALENDAR_AUTHORITY)).outcome).toBe('ok');
    const calendarRow = Number(h.device.rows('calendars')[0]._id);
    const event = h.device.user.insertEvent(calendarRow, {
      title: 'Dentist',
      dtstart: Date.UTC(2026, 9, 1, 8),
      dtend: Date.UTC(2026, 9, 1, 9),
      eventTimezone: 'Europe/Berlin',
    });
    h.device.user.deleteEvent(event);
    expect(h.events()).toEqual([]);
    const requests = h.server.requests.length;

    expect((await h.run(CALENDAR_AUTHORITY, { upload: true })).outcome).toBe('ok');
    expect(h.server.requests.length).toBe(requests);
    offline(h);
    expect(await h.teardown(CALENDAR_AUTHORITY)).toEqual({ pending: 0 });
  });
});
