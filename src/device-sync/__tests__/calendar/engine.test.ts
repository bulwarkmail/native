// The calendar planner through the engine and the fake JMAP server: device
// edits reach the server as the user made them and the rows stay as the user
// left them, end to end. Mapping details are the planner's own tests.

import { describe, expect, it } from 'vitest';
import { Events, Reminders } from '../../android-columns';
import { calendarPlanner } from '../../calendar/planner';
import { contactsPlanner } from '../../contacts/planner';
import { CALENDAR_AUTHORITY, createHarness, type Harness } from '../engine/harness';

function real(options: Parameters<typeof createHarness>[0] = {}): Harness {
  const h = createHarness(options);
  h.deps.planners = { contacts: contactsPlanner, calendar: calendarPlanner };
  return h;
}

type Overrides = Record<string, Record<string, unknown>>;

describe('calendar device edits through the engine', () => {
  it('creates an event and an occurrence edit an app left without a status as confirmed ones', async () => {
    const h = real();
    const series = h.server.addEvent('a', {
      uid: 'weekly-uid',
      title: 'Weekly',
      start: '2026-10-05T08:00:00',
      duration: 'PT1H',
      timeZone: 'Europe/Berlin',
      recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly', count: 8 },
      calendarIds: { [h.calendar]: true },
    });
    await h.run(CALENDAR_AUTHORITY);
    const master = h.events().find((e) => e[Events._SYNC_ID] === `a/${series}`)!;
    const rowId = Number(master[Events.CALENDAR_ID]);

    // Google Calendar leaves STATUS NULL on the events and exceptions it inserts.
    const created = h.device.user.insertEvent(rowId, {
      [Events.TITLE]: 'New from Google Calendar',
      [Events.DTSTART]: Date.UTC(2026, 9, 14, 13),
      [Events.DTEND]: Date.UTC(2026, 9, 14, 14),
      [Events.EVENT_TIMEZONE]: 'Europe/Berlin',
      [Events.STATUS]: null,
    });
    h.device.user.insertException(Number(master._id), Date.UTC(2026, 10, 9, 7), {
      [Events.TITLE]: 'Only Nov 9',
      [Events.DTSTART]: Date.UTC(2026, 10, 9, 7),
      [Events.DTEND]: Date.UTC(2026, 10, 9, 8),
      [Events.STATUS]: null,
    });
    expect(await h.run(CALENDAR_AUTHORITY)).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { created: 1, updated: 1 } } });

    const event = h.server.all('CalendarEvent', 'a').find((e) => e.title === 'New from Google Calendar')!;
    expect(event.status).toBeUndefined();
    const overrides = h.server.get('CalendarEvent', 'a', series)!.recurrenceOverrides as Overrides;
    expect(overrides['2026-11-09T08:00:00']).toMatchObject({ title: 'Only Nov 9' });
    expect(overrides['2026-11-09T08:00:00'].status).toBeUndefined();
    // The rows hold the default, confirmed, and are clean.
    expect(h.events().find((e) => Number(e._id) === created)).toMatchObject({ [Events.STATUS]: 1, [Events.DIRTY]: 0 });
    expect(h.events().filter((e) => e[Events.ORIGINAL_SYNC_ID] === `a/${series}`).map((e) => [e[Events.STATUS], e[Events.DIRTY]])).toEqual([[1, 0]]);
  });

  it('keeps a reminder changed on one occurrence of a series on the calendar\'s default alerts', async () => {
    const h = real();
    h.server.serverUpdate('Calendar', 'a', h.calendar, {
      defaultAlertsWithTime: { d1: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' }, action: 'display' } },
    });
    const id = h.server.addEvent('a', {
      uid: 'standup-uid',
      title: 'Standup',
      start: '2026-09-28T09:00:00',
      duration: 'PT15M',
      timeZone: 'Europe/Berlin',
      recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily', count: 5 },
      recurrenceOverrides: { '2026-09-29T09:00:00': { title: 'Standup (late)', start: '2026-09-29T10:00:00' } },
      useDefaultAlerts: true,
      calendarIds: { [h.calendar]: true },
    });
    await h.run(CALENDAR_AUTHORITY);
    const minutes = (eventId: unknown) => h.device.rows('reminders').filter((r) => r[Reminders.EVENT_ID] === Number(eventId)).map((r) => Number(r[Reminders.MINUTES]));
    const master = h.events().find((e) => e[Events._SYNC_ID] === `a/${id}`)!;
    const exception = () => h.events().find((e) => e[Events.ORIGINAL_SYNC_ID] === `a/${id}`)!;
    expect([minutes(master._id), minutes(exception()._id)]).toEqual([[15], [15]]);

    h.device.user.setReminders(Number(exception()._id), [{ minutes: 60 }]);
    expect(await h.run(CALENDAR_AUTHORITY)).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { updated: 1 } } });

    expect(exception()[Events.DIRTY]).toBe(0);
    expect([minutes(master._id), minutes(exception()._id)]).toEqual([[15], [60]]);
    const event = h.server.get('CalendarEvent', 'a', id)!;
    expect(event.useDefaultAlerts).toBe(true);
    expect((event.recurrenceOverrides as Overrides)['2026-09-29T09:00:00']).toMatchObject({ useDefaultAlerts: false });
    // Its echo writes nothing.
    const before = h.batches.log.length;
    await h.run(CALENDAR_AUTHORITY);
    expect(h.batches.log.slice(before).filter((ops) => ops.some((op) => op.op !== 'syncState' && op.op !== 'assert'))).toEqual([]);
  });

  it('sends an answer to one occurrence in a calendar that grants only RSVP, and reports a refusal', async () => {
    const h = real({ accounts: 'withShared' });
    const team = h.server.addCalendar('team', {
      name: 'Team events',
      myRights: { mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: false, mayWriteOwn: false, mayUpdatePrivate: false, mayRSVP: true, mayShare: false, mayDelete: false },
    });
    h.prefs.calendarSelection[`team/${team}`] = true;
    const id = h.server.addEvent('team', {
      uid: 'team-weekly',
      title: 'Team weekly',
      start: '2026-10-05T09:00:00',
      duration: 'PT1H',
      timeZone: 'Europe/Berlin',
      recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'weekly', count: 5 },
      organizerCalendarAddress: 'mailto:boss@example.net',
      participants: {
        boss: { '@type': 'Participant', calendarAddress: 'mailto:boss@example.net', roles: { owner: true }, participationStatus: 'accepted' },
        me: { '@type': 'Participant', calendarAddress: 'mailto:alice@example.com', roles: { attendee: true }, participationStatus: 'needs-action' },
      },
      calendarIds: { [team]: true },
    });
    await h.run(CALENDAR_AUTHORITY);
    const master = h.events().find((e) => e[Events._SYNC_ID] === `team/${id}`)!;

    // Etar answers the Oct 12 occurrence through CONTENT_EXCEPTION_URI.
    h.device.user.exceptionViaUri(Number(master._id), Date.UTC(2026, 9, 12, 7), { [Events.SELF_ATTENDEE_STATUS]: 2, [Events.STATUS]: 1 });
    const sets = () => h.server.requests.filter((r) => r.methods.includes('CalendarEvent/set')).length;
    const before = sets();
    const report = await h.run(CALENDAR_AUTHORITY);

    // The answer was sent (this server takes no RSVP without write rights), the refusal is reported and the row put back.
    expect(sets()).toBeGreaterThan(before);
    expect(report.itemErrors).toEqual([expect.objectContaining({ ref: `team/${id}`, side: 'upload', type: 'forbidden' })]);
    expect(h.events().filter((e) => e[Events.ORIGINAL_SYNC_ID] === `team/${id}`)).toEqual([]);
    expect(h.events().every((e) => Number(e[Events.DIRTY] ?? 0) === 0)).toBe(true);
    // Nothing was stored at all: the report does not claim it was, without invitations.
    expect(report.message ?? '').not.toContain('invitations not sent');
  });

  it('notes that invitations were not sent only when the change was stored without them', async () => {
    const h = real();
    const id = h.server.addEvent('a', {
      uid: 'review-uid',
      title: 'Review',
      start: '2026-10-06T12:00:00',
      duration: 'PT1H',
      timeZone: 'Europe/Berlin',
      organizerCalendarAddress: 'mailto:alice@example.com',
      participants: {
        me: { '@type': 'Participant', calendarAddress: 'mailto:alice@example.com', roles: { owner: true, attendee: true }, participationStatus: 'accepted' },
        bob: { '@type': 'Participant', calendarAddress: 'mailto:bob@example.com', roles: { attendee: true }, participationStatus: 'needs-action' },
      },
      calendarIds: { [h.calendar]: true },
    });
    await h.run(CALENDAR_AUTHORITY);
    const row = Number(h.events().find((e) => e[Events._SYNC_ID] === `a/${id}`)!._id);
    h.device.user.updateEvent(row, { [Events.TITLE]: 'Design review' });
    // The server refuses the scheduling messages once (e.g. scheduling turned off): the change goes up without them.
    h.server.setErrorFor('CalendarEvent', 'a', id, { type: 'forbidden' });

    const report = await h.run(CALENDAR_AUTHORITY);

    expect(report).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { updated: 1 } } });
    expect(report.message).toContain('invitations not sent');
    expect(h.server.get('CalendarEvent', 'a', id)).toMatchObject({ title: 'Design review' });
  });

  it('puts an event an app moved in place to a calendar of another account back into its calendar', async () => {
    const h = real({ accounts: 'withShared' });
    const team = String(h.server.all('Calendar', 'team')[0].id);
    h.prefs.calendarSelection[`team/${team}`] = true;
    const id = h.server.addEvent('a', {
      uid: 'lunch-uid',
      title: 'Lunch',
      start: '2026-10-06T12:00:00',
      duration: 'PT1H',
      timeZone: 'Europe/Berlin',
      calendarIds: { [h.calendar]: true },
    });
    await h.run(CALENDAR_AUTHORITY);
    const calendarRow = (key: string) => Number(h.device.rows('calendars').find((c) => c._sync_id === key)!._id);
    const row = () => h.events().find((e) => e[Events._SYNC_ID] === `a/${id}`)!;
    expect(row()[Events.CALENDAR_ID]).toBe(calendarRow(`a/${h.calendar}`));

    // An app moves it by changing CALENDAR_ID in place (a move across JMAP accounts can't be a patch).
    h.device.user.updateEvent(Number(row()._id), { [Events.CALENDAR_ID]: calendarRow(`team/${team}`) });
    const report = await h.run(CALENDAR_AUTHORITY);

    expect(row()).toMatchObject({ [Events.CALENDAR_ID]: calendarRow(`a/${h.calendar}`), [Events.DIRTY]: 0 });
    expect(h.server.get('CalendarEvent', 'a', id)!.calendarIds).toEqual({ [h.calendar]: true });
    expect(h.server.all('CalendarEvent', 'team')).toEqual([]);
    // Nothing was sent; the change counts as skipped, and the report says why.
    expect(report).toMatchObject({ outcome: 'ok', stats: { uploaded: { created: 0, updated: 0, deleted: 0 }, skipped: 1 } });
    expect(report.itemErrors).toEqual([expect.objectContaining({ ref: `a/${id}`, side: 'upload', type: 'crossAccountMove' })]);

    // Together with another edit: that one uploads, and the row goes back all the same.
    h.device.user.updateEvent(Number(row()._id), { [Events.CALENDAR_ID]: calendarRow(`team/${team}`), [Events.TITLE]: 'Team lunch' });
    expect(await h.run(CALENDAR_AUTHORITY)).toMatchObject({ outcome: 'ok', stats: { uploaded: { updated: 1 } } });
    expect(h.server.get('CalendarEvent', 'a', id)).toMatchObject({ title: 'Team lunch', calendarIds: { [h.calendar]: true } });
    expect(row()).toMatchObject({ [Events.CALENDAR_ID]: calendarRow(`a/${h.calendar}`), [Events.TITLE]: 'Team lunch', [Events.DIRTY]: 0 });
    expect(h.server.all('CalendarEvent', 'team')).toEqual([]);
  });

  describe("Etar's move (delete + insert) with other edits", () => {
    /** The event columns Etar copies into the row it inserts when it moves an event. */
    const ETAR_COPY = [
      Events.TITLE, Events.DESCRIPTION, Events.EVENT_LOCATION, Events.STATUS, Events.AVAILABILITY, Events.ACCESS_LEVEL,
      Events.EVENT_COLOR, Events.DTSTART, Events.DTEND, Events.DURATION, Events.EVENT_TIMEZONE, Events.ALL_DAY, Events.RRULE, Events.EXDATE,
    ];
    function etarMove(h: Harness, masterId: number, calendarRowId: number, reminders: Array<{ minutes: number }>): number {
      const old = h.events().find((e) => Number(e._id) === masterId)!;
      const values = Object.fromEntries(ETAR_COPY.filter((c) => old[c] !== undefined).map((c) => [c, old[c]]));
      h.device.user.deleteEvent(masterId);
      return h.device.user.insertEvent(calendarRowId, values, {
        reminders: reminders.map((r) => ({ [Reminders.MINUTES]: r.minutes, [Reminders.METHOD]: 1 })),
      });
    }
    const minutes = (h: Harness, eventId: number) =>
      h.device.rows('reminders').filter((r) => Number(r[Reminders.EVENT_ID]) === eventId).map((r) => Number(r[Reminders.MINUTES]));

    it('uploads a reminder saved with the move, and keeps the event', async () => {
      const h = real();
      const work = h.server.addCalendar('a', { name: 'Work' });
      const id = h.server.addEvent('a', {
        uid: 'lunch-uid',
        title: 'Lunch',
        start: '2026-10-06T12:00:00',
        duration: 'PT1H',
        timeZone: 'Europe/Berlin',
        keywords: { important: true },
        alerts: { al1: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' }, action: 'display' } },
        calendarIds: { [h.calendar]: true },
      });
      await h.run(CALENDAR_AUTHORITY);
      const master = Number(h.events().find((e) => e[Events._SYNC_ID] === `a/${id}`)!._id);
      const workRow = Number(h.device.rows('calendars').find((c) => c._sync_id === `a/${work}`)!._id);

      const moved = etarMove(h, master, workRow, [{ minutes: 60 }]);
      const report = await h.run(CALENDAR_AUTHORITY);

      expect(report).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { created: 0, deleted: 0 } } });
      const event = h.server.get('CalendarEvent', 'a', id)!;
      expect(event).toMatchObject({ uid: 'lunch-uid', calendarIds: { [work]: true }, keywords: { important: true } });
      const alerts = Object.values(event.alerts as Record<string, { trigger: { offset: string } }>).map((a) => a.trigger.offset);
      expect(alerts).toEqual(['-PT1H']);
      expect(h.events()).toEqual([expect.objectContaining({ _id: moved, _sync_id: `a/${id}`, [Events.DIRTY]: 0 })]);
      expect(minutes(h, moved)).toEqual([60]);

      const before = h.batches.log.length;
      await h.run(CALENDAR_AUTHORITY);
      expect(h.batches.log.slice(before).filter((ops) => ops.some((op) => op.op !== 'syncState' && op.op !== 'assert'))).toEqual([]);
    });

    describe('when the server deleted the event meanwhile', () => {
      async function movedLunch() {
        const h = real();
        const work = h.server.addCalendar('a', { name: 'Work' });
        const id = h.server.addEvent('a', {
          uid: 'lunch-uid',
          title: 'Lunch',
          start: '2026-10-06T12:00:00',
          duration: 'PT1H',
          timeZone: 'Europe/Berlin',
          calendarIds: { [h.calendar]: true },
        });
        await h.run(CALENDAR_AUTHORITY);
        const master = Number(h.events().find((e) => e[Events._SYNC_ID] === `a/${id}`)!._id);
        const workRow = Number(h.device.rows('calendars').find((c) => c._sync_id === `a/${work}`)!._id);
        etarMove(h, master, workRow, [{ minutes: 30 }]);
        return { h, id };
      }
      const creates = (h: Harness) =>
        h.server.calls('CalendarEvent/set').filter(([, args]) => Object.keys((args as { create?: object }).create ?? {}).length);

      it('removes the moved event when the patch of the move finds it gone', async () => {
        const { h, id } = await movedLunch();
        h.server.setErrorFor('CalendarEvent', 'a', id, { type: 'notFound' });

        const report = await h.run(CALENDAR_AUTHORITY);

        expect(report).toMatchObject({ outcome: 'ok', conflicts: 1, stats: { uploaded: { created: 0 } } });
        expect(creates(h)).toEqual([]);
        expect(h.events()).toEqual([]);
      });

      it('removes the moved event when the download finds it destroyed', async () => {
        const { h, id } = await movedLunch();
        h.server.serverDestroy('CalendarEvent', 'a', id);

        const report = await h.run(CALENDAR_AUTHORITY);

        expect(report).toMatchObject({ outcome: 'ok', itemErrors: [], conflicts: 1, stats: { uploaded: { created: 0 } } });
        expect(h.server.all('CalendarEvent', 'a')).toEqual([]);
        expect(h.events()).toEqual([]);
      });

      it('removes the moved event when it is destroyed while the move is on its way', async () => {
        const { h, id } = await movedLunch();
        const stop = h.server.onBeforeRequest((request) => {
          if (!request.methods.includes('CalendarEvent/set')) return;
          stop();
          h.server.serverDestroy('CalendarEvent', 'a', id);
        });

        const report = await h.run(CALENDAR_AUTHORITY);

        expect(report).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { created: 0 } } });
        expect(h.server.all('CalendarEvent', 'a')).toEqual([]);
        expect(h.events()).toEqual([]);
      });
    });

    it('keeps an occurrence edit that had not reached the server when the series moves', async () => {
      const h = real();
      const work = h.server.addCalendar('a', { name: 'Work' });
      const id = h.server.addEvent('a', {
        uid: 'standup-uid',
        title: 'Standup',
        start: '2026-09-28T09:00:00',
        duration: 'PT15M',
        timeZone: 'Europe/Berlin',
        recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily', count: 5 },
        recurrenceOverrides: { '2026-09-29T09:00:00': { title: 'Planning' } },
        calendarIds: { [h.calendar]: true },
      });
      await h.run(CALENDAR_AUTHORITY);
      const master = Number(h.events().find((e) => e[Events._SYNC_ID] === `a/${id}`)!._id);
      const exception = Number(h.events().find((e) => e[Events.ORIGINAL_SYNC_ID] === `a/${id}`)!._id);
      const workRow = Number(h.device.rows('calendars').find((c) => c._sync_id === `a/${work}`)!._id);
      // The occurrence is renamed on the device; before it syncs, Etar moves the series (it copies only unsynced exceptions).
      h.device.user.updateEvent(exception, { [Events.TITLE]: 'Sprint planning' });

      const moved = etarMove(h, master, workRow, []);
      const report = await h.run(CALENDAR_AUTHORITY);

      expect(report).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { created: 0, deleted: 0 } } });
      const event = h.server.get('CalendarEvent', 'a', id)!;
      expect(event.calendarIds).toEqual({ [work]: true });
      expect((event.recurrenceOverrides as Overrides)['2026-09-29T09:00:00']).toMatchObject({ title: 'Sprint planning' });
      const rows = h.events();
      expect(rows.filter((e) => e[Events.ORIGINAL_ID] === null)).toEqual([expect.objectContaining({ _id: moved, _sync_id: `a/${id}`, [Events.DIRTY]: 0 })]);
      expect(rows.filter((e) => e[Events.ORIGINAL_ID] !== null)).toEqual([
        expect.objectContaining({ [Events.ORIGINAL_ID]: moved, [Events.CALENDAR_ID]: workRow, [Events.TITLE]: 'Sprint planning', [Events.DIRTY]: 0 }),
      ]);
    });
  });

  it('removes an event created in a read-only calendar and reports it', async () => {
    const h = real({ accounts: 'withShared' });
    const team = h.server.addCalendar('team', {
      name: 'Team events',
      myRights: { mayReadFreeBusy: true, mayReadItems: true, mayWriteAll: false, mayWriteOwn: false, mayUpdatePrivate: false, mayRSVP: false, mayShare: false, mayDelete: false },
    });
    h.prefs.calendarSelection[`team/${team}`] = true;
    await h.run(CALENDAR_AUTHORITY);
    const teamRow = Number(h.device.rows('calendars').find((c) => c._sync_id === `team/${team}`)!._id);

    const id = h.device.user.insertEvent(teamRow, {
      [Events.TITLE]: 'Mine',
      [Events.DTSTART]: Date.UTC(2026, 9, 14, 13),
      [Events.DTEND]: Date.UTC(2026, 9, 14, 14),
      [Events.EVENT_TIMEZONE]: 'Europe/Berlin',
    });
    const report = await h.run(CALENDAR_AUTHORITY);

    expect(report).toMatchObject({ outcome: 'ok', stats: { uploaded: { created: 0 }, skipped: 1 } });
    expect(report.itemErrors).toEqual([expect.objectContaining({ ref: `row:${id}`, side: 'upload', type: 'readOnly' })]);
    expect(h.events().find((e) => Number(e._id) === id)).toBeUndefined();
    expect(h.server.all('CalendarEvent', 'team')).toEqual([]);
    // Nothing is left waiting: the next run has nothing to say about it.
    expect((await h.run(CALENDAR_AUTHORITY)).itemErrors).toEqual([]);
  });

  it('leaves nothing waiting for turning sync off after an event was created in a read-only calendar', async () => {
    const h = real({ accounts: 'withShared' });
    const team = h.server.addCalendar('team', { name: 'Team events', myRights: { mayReadItems: true, mayWriteAll: false, mayWriteOwn: false, mayRSVP: false } });
    h.prefs.calendarSelection[`team/${team}`] = true;
    await h.run(CALENDAR_AUTHORITY);
    const teamRow = Number(h.device.rows('calendars').find((c) => c._sync_id === `team/${team}`)!._id);
    h.device.user.insertEvent(teamRow, { [Events.TITLE]: 'Mine', [Events.DTSTART]: Date.UTC(2026, 9, 14, 13), [Events.DTEND]: Date.UTC(2026, 9, 14, 14), [Events.EVENT_TIMEZONE]: 'Europe/Berlin' });

    expect(await h.teardown(CALENDAR_AUTHORITY)).toEqual({ pending: 0 });
    expect(h.server.all('CalendarEvent', 'team')).toEqual([]);
  });

  describe('an occurrence\'s own colour and reminders removed on the device', () => {
    async function standup(extra: Record<string, unknown>, override: Record<string, unknown>) {
      const h = real();
      const id = h.server.addEvent('a', {
        uid: 'standup-uid',
        title: 'Standup',
        start: '2026-09-28T09:00:00',
        duration: 'PT15M',
        timeZone: 'Europe/Berlin',
        recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily', count: 5 },
        recurrenceOverrides: { '2026-09-29T09:00:00': { title: 'Standup (late)', ...override } },
        calendarIds: { [h.calendar]: true },
        ...extra,
      });
      await h.run(CALENDAR_AUTHORITY);
      const exception = () => h.events().find((e) => e[Events.ORIGINAL_SYNC_ID] === `a/${id}`)!;
      const minutes = () => h.device.rows('reminders').filter((r) => Number(r[Reminders.EVENT_ID]) === Number(exception()._id)).map((r) => Number(r[Reminders.MINUTES]));
      return { h, id, exception, minutes };
    }

    it('keeps a colour cleared on one occurrence cleared', async () => {
      const { h, id, exception } = await standup({ color: 'steelblue' }, { color: 'red' });

      h.device.user.updateEvent(Number(exception()._id), { [Events.EVENT_COLOR]: null });
      expect(await h.run(CALENDAR_AUTHORITY)).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { updated: 1 } } });

      expect(exception()).toMatchObject({ [Events.EVENT_COLOR]: null, [Events.DIRTY]: 0 });
      expect((h.server.get('CalendarEvent', 'a', id)!.recurrenceOverrides as Overrides)['2026-09-29T09:00:00']).toMatchObject({ color: '' });
    });

    it('puts back the removal of every reminder of an occurrence whose series shows its own, and reports it', async () => {
      const alert = { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M' }, action: 'display' };
      const { h, id, exception, minutes } = await standup({ alerts: { al1: alert } }, {});
      expect(minutes()).toEqual([15]);
      const sets = () => h.server.requests.filter((r) => r.methods.includes('CalendarEvent/set')).length;
      const before = sets();

      h.device.user.setReminders(Number(exception()._id), []);
      const report = await h.run(CALENDAR_AUTHORITY);

      expect(report.itemErrors).toEqual([expect.objectContaining({ ref: `a/${id}`, side: 'upload', type: 'remindersNotRepresentable' })]);
      expect(sets()).toBe(before);
      expect(minutes()).toEqual([15]);
      expect(exception()[Events.DIRTY]).toBe(0);
    });
  });

  it('keeps a description and location cleared on one occurrence cleared', async () => {
    const h = real();
    const id = h.server.addEvent('a', {
      uid: 'standup-uid',
      title: 'Standup',
      description: 'Daily agenda',
      start: '2026-09-28T09:00:00',
      duration: 'PT15M',
      timeZone: 'Europe/Berlin',
      recurrenceRule: { '@type': 'RecurrenceRule', frequency: 'daily', count: 5 },
      locations: { locA: { '@type': 'Location', name: 'Room 1' } },
      recurrenceOverrides: {
        '2026-09-29T09:00:00': { title: 'Standup', description: 'Special agenda', locations: { locB: { '@type': 'Location', name: 'Room 2' } } },
      },
      calendarIds: { [h.calendar]: true },
    });
    await h.run(CALENDAR_AUTHORITY);
    const exception = () => h.events().find((e) => e[Events.ORIGINAL_SYNC_ID] === `a/${id}`)!;
    expect(exception()).toMatchObject({ [Events.DESCRIPTION]: 'Special agenda', [Events.EVENT_LOCATION]: 'Room 2' });

    h.device.user.updateEvent(Number(exception()._id), { [Events.DESCRIPTION]: null, [Events.EVENT_LOCATION]: null });
    expect(await h.run(CALENDAR_AUTHORITY)).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { uploaded: { updated: 1 } } });

    expect(exception()).toMatchObject({ [Events.DESCRIPTION]: null, [Events.EVENT_LOCATION]: null, [Events.DIRTY]: 0 });
    const overrides = h.server.get('CalendarEvent', 'a', id)!.recurrenceOverrides as Overrides;
    expect(overrides['2026-09-29T09:00:00']).toMatchObject({ description: '', locations: { locB: { name: '' } } });
  });
});
