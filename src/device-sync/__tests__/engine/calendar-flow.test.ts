// Engine runs for calendars, and the teardown the app calls when sync is
// turned off (docs/device-sync.md, "Calendar mapping", "App integration").

import { describe, expect, it, vi } from 'vitest';
import { Events } from '../../android-columns';
import { parseJsonColumn } from '../../common/json';
import { teardownAuthority } from '../../engine/teardown';
import type { PoisonMarker } from '../../planner';
import {
  addDeviceContact,
  addServerCards,
  ANDROID_ACCOUNT,
  CALENDAR_AUTHORITY,
  CONTACTS_AUTHORITY,
  createHarness,
  REGISTRY_ID,
  renameDeviceContact,
  type Harness,
} from './harness';

const START = '2026-09-28T09:00:00';

function addServerEvent(h: Harness, title: string, calendarId = h.calendar, extra: Record<string, unknown> = {}): string {
  return h.server.addEvent('a', {
    uid: `uid-${title}`,
    title,
    start: START,
    duration: 'PT1H',
    timeZone: 'Etc/UTC',
    calendarIds: { [calendarId]: true },
    ...extra,
  });
}

function calendarRow(h: Harness, calendarId: string) {
  return h.device.rows('calendars').find((c) => c._sync_id === `a/${calendarId}`);
}

function titles(h: Harness): string[] {
  return h.events().map((e) => String(e[Events.TITLE])).sort();
}

describe('device sync engine: calendar', () => {
  it('writes calendar rows for the synced calendars and downloads their events, never tasks', async () => {
    const h = createHarness();
    const standup = addServerEvent(h, 'Standup');
    h.server.addEvent('a', { uid: 't1', '@type': 'Task', title: 'Buy milk', calendarIds: { [h.calendar]: true } });

    const report = await h.run(CALENDAR_AUTHORITY);

    expect(report).toMatchObject({ outcome: 'ok', stats: { downloaded: { created: 1 } } });
    expect(calendarRow(h, h.calendar)).toMatchObject({ ownerAccount: 'alice@example.com', sync_events: 1, name: 'Calendar' });
    expect(h.events()).toEqual([expect.objectContaining({ title: 'Standup', _sync_id: `a/${standup}`, uid2445: 'uid-Standup' })]);
    expect(h.state(CALENDAR_AUTHORITY)).toMatchObject({
      accounts: { a: { selected: [`a/${h.calendar}`], reconcile: null } },
      deviceZone: 'Europe/Berlin',
      reminderOwner: 'device',
    });
  });

  it('uploads a new device event, an edit and a deletion', async () => {
    const h = createHarness();
    const standup = addServerEvent(h, 'Standup');
    const retro = addServerEvent(h, 'Retro');
    await h.run(CALENDAR_AUTHORITY);
    const rowId = Number(calendarRow(h, h.calendar)!._id);
    const byTitle = (t: string) => h.events().find((e) => e.title === t)!;

    h.device.user.insertEvent(rowId, { title: 'Lunch', dtstart: Date.UTC(2026, 8, 28, 12), dtend: Date.UTC(2026, 8, 28, 13), eventTimezone: 'UTC' });
    h.device.user.updateEvent(Number(byTitle('Standup')._id), { title: 'Daily standup' });
    h.device.user.deleteEvent(Number(byTitle('Retro')._id));
    const report = await h.run(CALENDAR_AUTHORITY);

    expect(report).toMatchObject({ outcome: 'ok', stats: { uploaded: { created: 1, updated: 1, deleted: 1 } } });
    expect(h.server.get('CalendarEvent', 'a', standup)).toMatchObject({ title: 'Daily standup' });
    expect(h.server.get('CalendarEvent', 'a', retro)).toBeUndefined();
    const lunch = h.server.all('CalendarEvent', 'a').find((e) => e.title === 'Lunch')!;
    expect(lunch).toMatchObject({ start: '2026-09-28T12:00:00', calendarIds: { [h.calendar]: true } });
    expect(titles(h)).toEqual(['Daily standup', 'Lunch']);
    expect(byTitle('Lunch')).toMatchObject({ _sync_id: `a/${lunch.id}`, dirty: 0 });
  });

  it('gives a calendar that holds only tasks no row', async () => {
    const h = createHarness();
    const todo = h.server.addCalendar('a', { name: 'To do' });
    for (let i = 0; i < 3; i++) h.server.addEvent('a', { uid: `t${i}`, '@type': 'Task', title: `Task ${i}`, calendarIds: { [todo]: true } });
    addServerEvent(h, 'Standup');

    await h.run(CALENDAR_AUTHORITY);

    expect(calendarRow(h, todo)).toBeUndefined();
    expect(h.state(CALENDAR_AUTHORITY)?.accounts.a.taskOnly).toEqual([todo]);
    expect(titles(h)).toEqual(['Standup']);
  });

  it('drops a deselected calendar once its events are uploaded, keeping the others', async () => {
    const h = createHarness();
    const work = h.server.addCalendar('a', { name: 'Work' });
    addServerEvent(h, 'Standup');
    const review = addServerEvent(h, 'Review', work);
    addServerEvent(h, 'Planning', work);
    await h.run(CALENDAR_AUTHORITY);
    expect(titles(h)).toEqual(['Planning', 'Review', 'Standup']);

    h.device.user.updateEvent(Number(h.events().find((e) => e.title === 'Review')!._id), { title: 'Code review' });
    h.prefs.calendarSelection[`a/${work}`] = false;
    await h.run(CALENDAR_AUTHORITY);

    expect(h.server.get('CalendarEvent', 'a', review)).toMatchObject({ title: 'Code review' });
    expect(calendarRow(h, work)).toBeUndefined();
    expect(titles(h)).toEqual(['Standup']);
    expect(h.state(CALENDAR_AUTHORITY)?.accounts.a.selected).toEqual([`a/${h.calendar}`]);
  });

  it('keeps a deselected calendar while one of its events could not be uploaded', async () => {
    const h = createHarness();
    const work = h.server.addCalendar('a', { name: 'Work' });
    const review = addServerEvent(h, 'Review', work);
    addServerEvent(h, 'Planning', work);
    await h.run(CALENDAR_AUTHORITY);
    h.device.user.updateEvent(Number(h.events().find((e) => e.title === 'Review')!._id), { title: 'Code review' });
    h.server.setErrorFor('CalendarEvent', 'a', review, { type: 'tooLarge' });
    h.prefs.calendarSelection[`a/${work}`] = false;

    const report = await h.run(CALENDAR_AUTHORITY);

    expect(report.itemErrors).toEqual([expect.objectContaining({ ref: `a/${review}`, type: 'tooLarge' })]);
    expect(calendarRow(h, work)).toBeDefined();
    expect(titles(h)).toEqual(['Code review']);
    // Not complete any more (selected again, it is loaded again); its row is dropped again next run.
    expect(h.state(CALENDAR_AUTHORITY)?.accounts.a.selected).toEqual([`a/${h.calendar}`]);

    h.clock.now += 2 * 3_600_000;
    await h.run(CALENDAR_AUTHORITY);

    expect(h.server.get('CalendarEvent', 'a', review)).toMatchObject({ title: 'Code review' });
    expect(calendarRow(h, work)).toBeUndefined();
  });

  it('marks a calendar that mirrors a feed subscription read-only', async () => {
    const h = createHarness();
    const feed = h.server.addCalendar('a', { name: 'Holidays' });
    h.deps.subscriptionCalendars = async () => [{ jmapAccountId: null, calendarId: feed }];

    await h.run(CALENDAR_AUTHORITY);

    expect(calendarRow(h, feed)).toMatchObject({ calendar_access_level: 200 });
    expect(calendarRow(h, h.calendar)).toMatchObject({ calendar_access_level: 700 });
  });

  it('never gives a device event the identity of an unrelated event that has its uid (event uids are unique per account)', async () => {
    const h = createHarness();
    const hidden = h.server.addCalendar('a', { name: 'Hidden' });
    h.prefs.calendarSelection[`a/${hidden}`] = false;
    const other = addServerEvent(h, 'Other', hidden, { uid: 'dup' });
    await h.run(CALENDAR_AUTHORITY);
    const rowId = Number(calendarRow(h, h.calendar)!._id);
    const id = h.device.user.insertEvent(rowId, { title: 'Mine', dtstart: Date.UTC(2026, 8, 28, 12), dtend: Date.UTC(2026, 8, 28, 13), eventTimezone: 'UTC' });
    // An app wrote the uid, and the claim keeps it.
    await h.device.port(ANDROID_ACCOUNT, CALENDAR_AUTHORITY).applyBatch([
      {
        op: 'update',
        table: 'events',
        id,
        values: { _sync_id: '~pending/dup', uid2445: 'dup', sync_data3: JSON.stringify({ uid: 'dup', target: `a/${h.calendar}` }) },
      },
    ]);

    const report = await h.run(CALENDAR_AUTHORITY);

    expect(report.itemErrors).toEqual([expect.objectContaining({ type: 'uidConflict' })]);
    expect(h.server.get('CalendarEvent', 'a', other)).toMatchObject({ title: 'Other', calendarIds: { [hidden]: true } });
    const row = h.events().find((e) => Number(e._id) === id)!;
    expect(row).toMatchObject({ title: 'Mine', _sync_id: '~pending/dup' });
    expect(parseJsonColumn<PoisonMarker>(row.sync_data5)).toMatchObject({ type: 'uidConflict', n: 1 });
  });

  it('adopts an event its lost create left on the server, with a lagging uid index', async () => {
    const h = createHarness();
    addServerEvent(h, 'Standup');
    await h.run(CALENDAR_AUTHORITY);
    h.server.setUidIndexLag(3);
    const rowId = Number(calendarRow(h, h.calendar)!._id);
    const id = h.device.user.insertEvent(rowId, { title: 'Lunch', dtstart: Date.UTC(2026, 8, 28, 12), dtend: Date.UTC(2026, 8, 28, 13), eventTimezone: 'UTC' });
    h.server.applyThenLoseResponse({ match: 'CalendarEvent/set' });

    expect((await h.run(CALENDAR_AUTHORITY)).outcome).toBe('io');
    expect((await h.run(CALENDAR_AUTHORITY)).outcome).toBe('ok');

    expect(h.server.all('CalendarEvent', 'a').map((e) => e.title).sort()).toEqual(['Lunch', 'Standup']);
    expect(h.events()).toHaveLength(2);
    expect(h.events().find((e) => Number(e._id) === id)).toMatchObject({ dirty: 0, _sync_id: expect.stringMatching(/^a\//) });
  });
});

describe('device sync engine: teardown', () => {
  it('uploads waiting changes, then removes every row and the SyncState of the authority', async () => {
    const h = createHarness();
    const [ada] = addServerCards(h, ['Ada']);
    await h.run();
    renameDeviceContact(h, h.contactNamed('Ada')!.id, 'Ada King');
    addDeviceContact(h, 'Hedy');

    const result = await h.teardown(CONTACTS_AUTHORITY);

    expect(result).toEqual({ pending: 0 });
    expect(h.server.get('ContactCard', 'a', ada)).toMatchObject({ name: { full: 'Ada King' } });
    expect(h.serverNames()).toEqual(['Ada King', 'Hedy']);
    expect(h.device.rows('raw_contacts')).toEqual([]);
    expect(h.device.rows('groups')).toEqual([]);
    expect(h.device.rows('settings')).toEqual([]);
    expect(h.device.readSyncState(ANDROID_ACCOUNT, CONTACTS_AUTHORITY)).toBe('');
  });

  it('deletes nothing while changes could not be uploaded, unless forced', async () => {
    const h = createHarness();
    addServerCards(h, ['Ada']);
    await h.run();
    addDeviceContact(h, 'Hedy');
    h.deps.jmap = async () => {
      const error = new Error('Network request failed');
      error.name = 'NetworkError';
      throw error;
    };

    expect(await h.teardown(CONTACTS_AUTHORITY)).toEqual({ pending: 1 });
    expect(h.contacts()).toHaveLength(2);

    expect(await h.teardown(CONTACTS_AUTHORITY, { force: true })).toEqual({ pending: 0 });
    expect(h.contacts()).toHaveLength(0);
    expect(h.serverNames()).toEqual(['Ada']);
  });

  it('holds mass deletions back like a sync run, and asks', async () => {
    const h = createHarness();
    addServerCards(h, Array.from({ length: 80 }, (_, i) => `P${i}`));
    await h.run();
    for (const contact of h.contacts().slice(0, 60)) h.device.user.deleteContact(contact.id);

    expect(await h.teardown(CONTACTS_AUTHORITY)).toEqual({ pending: 60 });
    expect(h.serverNames()).toHaveLength(80);
  });

  it("finishes while JS timers are paused (the UI's teardown with the app in the background)", async () => {
    const h = createHarness();
    const [ada] = addServerCards(h, ['Ada']);
    await h.run();
    renameDeviceContact(h, h.contactNamed('Ada')!.id, 'Ada King');
    // The app passes neither a yield nor a sleep: the engine's own must not need a timer here.
    const { yieldThread: _yield, sleep: _sleep, ...deps } = h.deps;
    vi.useFakeTimers();
    try {
      await expect(teardownAuthority(deps, REGISTRY_ID, ANDROID_ACCOUNT, CONTACTS_AUTHORITY)).resolves.toEqual({ pending: 0 });
    } finally {
      vi.useRealTimers();
    }

    expect(h.server.get('ContactCard', 'a', ada)).toMatchObject({ name: { full: 'Ada King' } });
    expect(h.contacts()).toEqual([]);
  }, 3_000);

  it('removes the calendar rows, and their events with them', async () => {
    const h = createHarness();
    addServerEvent(h, 'Standup');
    await h.run(CALENDAR_AUTHORITY);

    expect(await h.teardown(CALENDAR_AUTHORITY)).toEqual({ pending: 0 });
    expect(h.device.rows('calendars')).toEqual([]);
    expect(h.device.rows('events')).toEqual([]);
  });

  it('stops a running sync of the account and waits for it', async () => {
    const h = createHarness();
    addServerCards(h, Array.from({ length: 200 }, (_, i) => `P${i}`));
    let teardown: Promise<{ pending: number }> | null = null;
    h.checkpoints.onCheckpoint = (n) => {
      if (n === 3) teardown = h.teardown(CONTACTS_AUTHORITY);
    };

    const report = await h.run();

    expect(report).toMatchObject({ outcome: 'cancelled' });
    expect(await teardown).toEqual({ pending: 0 });
    expect(h.contacts()).toHaveLength(0);
  });
});
