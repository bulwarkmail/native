// Objects our uploads created. The stored state stays where the download left
// it, and `/changes` omits an object created and destroyed after its
// `sinceState` (Stalwart does, RFC 8620 allows it): such an object must still
// leave the device when another client destroys it before the next download.

import { describe, expect, it } from 'vitest';
import { calendarPlanner } from '../../calendar/planner';
import { contactsPlanner } from '../../contacts/planner';
import { addDeviceContact, addServerCards, CALENDAR_AUTHORITY, createHarness, type Harness } from './harness';

function real(): Harness {
  const h = createHarness();
  h.deps.planners = { contacts: contactsPlanner, calendar: calendarPlanner };
  return h;
}

describe('device sync engine: objects our uploads created', () => {
  it('removes a device-created contact that another client destroyed before the next download', async () => {
    const h = real();
    addServerCards(h, ['Ada Lovelace']);
    await h.run();
    const id = addDeviceContact(h, 'Hedy Lamarr');
    expect((await h.run()).stats.uploaded.created).toBe(1);
    const hedy = h.contacts().find((c) => c.id === id)!.sourceId!.split('/')[1];
    h.server.serverDestroy('ContactCard', 'a', hedy);

    const report = await h.run();

    expect(report).toMatchObject({ outcome: 'ok', stats: { downloaded: { deleted: 1 } } });
    expect(h.contacts().map((c) => c.name)).toEqual(['Ada Lovelace']);
    expect(h.state()?.accounts.a.created ?? []).toEqual([]);
  });

  it('removes a device-created event that another client destroyed before the next download', async () => {
    const h = real();
    await h.run(CALENDAR_AUTHORITY);
    const rowId = Number(h.device.rows('calendars')[0]._id);
    const id = h.device.user.insertEvent(rowId, { title: 'Dentist', dtstart: Date.UTC(2026, 9, 1, 8), dtend: Date.UTC(2026, 9, 1, 9), eventTimezone: 'Europe/Berlin' });
    expect((await h.run(CALENDAR_AUTHORITY)).stats.uploaded.created).toBe(1);
    const created = String(h.events().find((e) => Number(e._id) === id)!._sync_id).split('/')[1];
    h.server.serverDestroy('CalendarEvent', 'a', created);

    const report = await h.run(CALENDAR_AUTHORITY);

    expect(report).toMatchObject({ outcome: 'ok', stats: { downloaded: { deleted: 1 } } });
    expect(h.events()).toEqual([]);
  });

  it('fetches a created object once, and writes nothing when it is unchanged', async () => {
    const h = real();
    await h.run();
    addDeviceContact(h, 'Hedy Lamarr');
    await h.run();
    expect(h.state()?.accounts.a.created).toHaveLength(1);

    const before = h.batches.log.length;
    expect((await h.run()).outcome).toBe('ok');

    expect(h.state()?.accounts.a.created).toEqual([]);
    expect(h.batches.log.slice(before).flat().filter((op) => op.op !== 'syncState')).toEqual([]);
    expect(h.contacts().map((c) => c.name)).toEqual(['Hedy Lamarr']);
  });

  it('turns an upload-only sync into a full one while a created object waits to be checked', async () => {
    const h = real();
    await h.run();
    const id = addDeviceContact(h, 'Hedy Lamarr');
    await h.run();
    const hedy = h.contacts().find((c) => c.id === id)!.sourceId!.split('/')[1];
    h.server.serverDestroy('ContactCard', 'a', hedy);

    // Android's upload sync 30 s after an app wrote anything, with nothing dirty in this account.
    expect((await h.run(undefined, { upload: true })).outcome).toBe('ok');

    expect(h.contacts()).toEqual([]);
  });
});
