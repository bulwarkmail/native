import { describe, expect, it } from 'vitest';
import { Attendees, Calendars, Events, Reminders } from '../../android-columns';
import { calendarPlanner } from '../../calendar/planner';
import { cssColorToArgb } from '../../calendar/values';
import { ACCT, CALENDARS, Harness, ME, single, utc, weekly } from './harness';
import type { CalendarEventWire } from '../../wire';

describe('calendar planner: downloads', () => {
  it('writes a recurring event with its exception, exclusion, attendees and reminders', async () => {
    const h = await new Harness().setup();
    const plan = await h.download(weekly());
    expect(plan.effect).toBe('insert');
    const master = h.masterRow('bl');
    expect(master).toMatchObject({
      [Events.TITLE]: 'Probe weekly',
      [Events.DESCRIPTION]: 'desc',
      [Events.EVENT_LOCATION]: 'Room 1',
      [Events.STATUS]: 0,
      [Events.AVAILABILITY]: 1,
      [Events.ACCESS_LEVEL]: 2,
      [Events.EVENT_COLOR]: cssColorToArgb('steelblue'),
      [Events.DTSTART]: utc('2026-10-05T13:00:00Z'),
      [Events.DTEND]: null,
      [Events.DURATION]: 'P5400S',
      [Events.EVENT_TIMEZONE]: 'America/New_York',
      [Events.ALL_DAY]: 0,
      [Events.RRULE]: 'FREQ=WEEKLY;COUNT=10;BYDAY=MO,WE',
      [Events.EXDATE]: '20261012T130000Z',
      [Events.RDATE]: null,
      [Events.UID_2445]: 'probe-rec@example.org',
      [Events.ORGANIZER]: ME,
      [Events.HAS_ATTENDEE_DATA]: 1,
      [Events.DIRTY]: 0,
    });
    expect(JSON.parse(String(master[Events.SYNC_DATA1]))).toEqual(weekly());
    expect(master[Events.SELF_ATTENDEE_STATUS] ?? null).toBeNull();

    const exceptions = h.fake.rows('events', `${Events.ORIGINAL_SYNC_ID} = ?`, [`${ACCT}/bl`]);
    expect(exceptions).toHaveLength(1);
    expect(exceptions[0]).toMatchObject({
      [Events._SYNC_ID]: `${ACCT}/bl#2026-10-07T09:00:00`,
      [Events.SYNC_DATA2]: '2026-10-07T09:00:00',
      [Events.ORIGINAL_ID]: master._id,
      // Exact to the millisecond, or the provider shows the original instance as well.
      [Events.ORIGINAL_INSTANCE_TIME]: utc('2026-10-07T13:00:00Z'),
      [Events.ORIGINAL_ALL_DAY]: 0,
      [Events.TITLE]: 'Moved Wednesday',
      [Events.DTSTART]: utc('2026-10-07T15:00:00Z'),
      [Events.DTEND]: utc('2026-10-07T16:30:00Z'),
      [Events.DURATION]: null,
      [Events.RRULE]: null,
      [Events.STATUS]: 0,
    });

    const attendees = h.fake.rows('attendees', `${Attendees.EVENT_ID} = ?`, [Number(master._id)]);
    expect(attendees.map((a) => [a[Attendees.ATTENDEE_EMAIL], a[Attendees.ATTENDEE_RELATIONSHIP], a[Attendees.ATTENDEE_STATUS]])).toEqual([
      [ME, 2, 1],
      ['guest@example.net', 1, 3],
    ]);
    const reminders = h.fake.rows('reminders', `${Reminders.EVENT_ID} = ?`, [Number(master._id)]);
    // Only the start-relative offset alert has a Reminders row; the others stay on the server.
    expect(reminders.map((r) => [r[Reminders.MINUTES], r[Reminders.METHOD]])).toEqual([[15, 1]]);
  });

  it('writes nothing for an echo of what the rows already hold', async () => {
    const h = await new Harness().setup();
    await h.download(weekly());
    const batches = h.fake.batches.length;
    const plan = calendarPlanner.planDownload(weekly(), await h.local('bl'), h.ctx);
    expect(plan).toMatchObject({ effect: 'none', writes: 0, conflicts: 0, stillDirty: false });
    expect(plan.ops.ops).toEqual([]);
    expect(h.fake.batches.length).toBe(batches);
  });

  it('writes only what the server changed, behind asserts', async () => {
    const h = await new Harness().setup();
    await h.download(weekly());
    const plan = await h.download({ ...weekly(), title: 'Renamed', updated: '2026-09-27T08:00:00Z' });
    expect(plan.effect).toBe('update');
    const ops = plan.ops.ops;
    const firstWrite = ops.findIndex((op) => op.op !== 'assert');
    expect(ops.slice(0, firstWrite).every((op) => op.op === 'assert')).toBe(true);
    expect(ops.slice(firstWrite).every((op) => op.op !== 'assert')).toBe(true);
    const updates = ops.filter((op) => op.op === 'update');
    expect(updates).toHaveLength(1);
    expect(Object.keys((updates[0] as { values: object }).values).sort()).toEqual([Events.SYNC_DATA1, Events.SYNC_DATA4, Events.TITLE].sort());
    expect(h.masterRow('bl')[Events.TITLE]).toBe('Renamed');
  });

  it('updates only the shadow when the server changed a property the device does not show', async () => {
    const h = await new Harness().setup();
    await h.download(weekly());
    const plan = await h.download({ ...weekly(), priority: 1, keywords: { other: true } });
    expect(plan).toMatchObject({ effect: 'update', writes: 1 });
    expect(JSON.parse(String(h.masterRow('bl')[Events.SYNC_DATA1])).priority).toBe(1);
  });

  it('keeps floating events on the wall clock of the device zone', async () => {
    const h = await new Harness({ deviceZone: 'America/New_York' }).setup();
    await h.download(single({ id: 'f1', timeZone: null, start: '2026-10-06T14:00:00', duration: 'PT45M' }));
    expect(h.masterRow('f1')).toMatchObject({
      [Events.EVENT_TIMEZONE]: 'America/New_York',
      [Events.DTSTART]: utc('2026-10-06T18:00:00Z'),
      [Events.DTEND]: utc('2026-10-06T18:45:00Z'),
    });
  });

  it('writes a timed event in its own zone, not the device one', async () => {
    const h = await new Harness({ deviceZone: 'Europe/Berlin' }).setup();
    await h.download(single({ id: 'tk', timeZone: 'Asia/Tokyo', start: '2026-10-06T09:00:00' }));
    expect(h.masterRow('tk')).toMatchObject({ [Events.EVENT_TIMEZONE]: 'Asia/Tokyo', [Events.DTSTART]: utc('2026-10-06T00:00:00Z') });
  });

  it('writes all-day events as UTC midnights, multi-day and in weeks too', async () => {
    const h = await new Harness({ deviceZone: 'Pacific/Auckland' }).setup();
    await h.download(single({ id: 'ad', start: '2026-10-08T00:00:00', timeZone: null, showWithoutTime: true, duration: 'P2D' }));
    expect(h.masterRow('ad')).toMatchObject({
      [Events.ALL_DAY]: 1,
      [Events.EVENT_TIMEZONE]: 'UTC',
      [Events.DTSTART]: utc('2026-10-08T00:00:00Z'),
      [Events.DTEND]: utc('2026-10-10T00:00:00Z'),
    });
    // CalDAV DTENDs arrive as weeks.
    await h.download(single({ id: 'wk', start: '2026-10-12T00:00:00', timeZone: null, showWithoutTime: true, duration: 'P1W' }));
    expect(h.masterRow('wk')[Events.DTEND]).toBe(utc('2026-10-19T00:00:00Z'));
    // A recurring all-day event gets a DURATION in days (the provider throws on seconds).
    await h.download(single({ id: 'ar', start: '2026-10-12T00:00:00', timeZone: null, showWithoutTime: true, duration: 'P1D', recurrenceRule: { frequency: 'yearly' } }));
    expect(h.masterRow('ar')).toMatchObject({ [Events.DURATION]: 'P1D', [Events.DTEND]: null, [Events.RRULE]: 'FREQ=YEARLY' });
    // A time part on an all-day duration rounds up.
    await h.download(single({ id: 'ap', start: '2026-10-12T00:00:00', timeZone: null, showWithoutTime: true, duration: 'P1DT2H' }));
    expect(h.masterRow('ap')[Events.DTEND]).toBe(utc('2026-10-14T00:00:00Z'));
  });

  it('writes the calendar defaults as reminders when the event uses them', async () => {
    const h = await new Harness().setup();
    await h.download(single({ id: 'da', useDefaultAlerts: true, alerts: { own: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT1H' } } } }));
    const master = h.masterRow('da');
    const reminders = h.fake.rows('reminders', `${Reminders.EVENT_ID} = ?`, [Number(master._id)]);
    expect(reminders.map((r) => r[Reminders.MINUTES])).toEqual([10]);
  });

  it('writes no reminders when Bulwark owns them, and leaves the ones an app adds', async () => {
    const h = await new Harness({ reminderOwner: 'bulwark' }).setup();
    const cal = (await h.calendars()).find((c) => c.syncId === `${ACCT}/b`)!;
    expect(cal.cells[Calendars.MAX_REMINDERS]).toBe(0);
    await h.download(weekly());
    const master = h.masterRow('bl');
    expect(h.fake.rows('reminders', `${Reminders.EVENT_ID} = ?`, [Number(master._id)])).toHaveLength(0);
    h.fake.user.setReminders(Number(master._id), [{ minutes: 5 }]);
    // Neither uploaded nor deleted: the edit only clears DIRTY.
    const upload = calendarPlanner.planUpload((await h.local('bl'))!, h.ctx);
    expect(upload.kind).toBe('clean');
    if (upload.kind === 'clean') await h.apply(upload.ops);
    await h.download({ ...weekly(), title: 'Again' });
    expect(h.fake.rows('reminders', `${Reminders.EVENT_ID} = ?`, [Number(master._id)])).toHaveLength(1);
  });

  it('normalises the user\'s own address, under any alias, to OWNER_ACCOUNT', async () => {
    const h = await new Harness().setup();
    const event = single({
      id: 'inv',
      organizerCalendarAddress: 'mailto:boss@example.net',
      participants: {
        boss: { calendarAddress: 'mailto:boss@example.net', roles: { owner: true } },
        me: { calendarAddress: 'mailto:ALIAS@Example.org', roles: { attendee: true }, participationStatus: 'tentative' },
        room: { calendarAddress: 'mailto:room@example.net', kind: 'resource', roles: { attendee: true } },
        opt: { calendarAddress: 'mailto:opt@example.net', roles: { attendee: true, optional: true }, participationStatus: 'declined' },
        noMail: { name: 'Phone only', roles: { attendee: true } },
      },
    } as Partial<CalendarEventWire>);
    await h.download(event);
    const master = h.masterRow('inv');
    expect(master[Events.ORGANIZER]).toBe('boss@example.net');
    const rows = h.fake.rows('attendees', `${Attendees.EVENT_ID} = ?`, [Number(master._id)]);
    expect(rows.map((a) => [a[Attendees.ATTENDEE_EMAIL], a[Attendees.ATTENDEE_RELATIONSHIP], a[Attendees.ATTENDEE_TYPE], a[Attendees.ATTENDEE_STATUS]])).toEqual([
      ['boss@example.net', 2, 1, 3],
      [ME, 1, 1, 4],
      ['room@example.net', 1, 3, 3],
      ['opt@example.net', 1, 2, 2],
    ]);
  });

  it('leaves ORGANIZER to the provider for events without participants', async () => {
    const h = await new Harness().setup();
    const plan = await h.download(single());
    const insert = plan.ops.ops.find((op) => op.op === 'insert' && op.table === 'events') as { values: Record<string, unknown> };
    expect(Events.ORGANIZER in insert.values).toBe(false);
    expect(Events.SELF_ATTENDEE_STATUS in insert.values).toBe(false);
    expect(h.masterRow('e1')[Events.ORGANIZER]).toBe(ME);
    // The baseline predicted the provider's value, so there is nothing to heal and an echo writes nothing.
    expect(calendarPlanner.planBaselineHeal((await h.local('e1'))!)).toBeNull();
    expect(calendarPlanner.planDownload(single(), await h.local('e1'), h.ctx).effect).toBe('none');
  });

  it('never writes a NULL STATUS', async () => {
    const h = await new Harness().setup();
    await h.download(single({ status: undefined }));
    expect(h.masterRow('e1')[Events.STATUS]).toBe(1);
    await h.download(single({ status: 'cancelled' }));
    expect(h.masterRow('e1')[Events.STATUS]).toBe(2);
  });

  it('removes and adds exception rows as overrides come and go', async () => {
    const h = await new Harness().setup();
    await h.download(weekly());
    const next = weekly();
    next.recurrenceOverrides = {
      '2026-10-12T09:00:00': { excluded: true },
      '2026-10-14T09:00:00': { excluded: true },
      '2026-10-19T09:00:00': { title: 'Other' },
    };
    const plan = await h.download(next);
    expect(plan.effect).toBe('update');
    const exceptions = h.fake.rows('events', `${Events.ORIGINAL_SYNC_ID} = ?`, [`${ACCT}/bl`]);
    expect(exceptions.map((x) => x[Events.SYNC_DATA2])).toEqual(['2026-10-19T09:00:00']);
    expect(exceptions[0][Events.TITLE]).toBe('Other');
    expect(h.masterRow('bl')[Events.EXDATE]).toBe('20261012T130000Z,20261014T130000Z');
  });

  it('replaces the rows of a different object under a reused id', async () => {
    const h = await new Harness().setup();
    await h.download(weekly());
    const other = single({ id: 'bl', uid: 'other-uid', title: 'Someone else' });
    const plan = await h.download(other);
    expect(plan.effect).toBe('update');
    const events = await h.events();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ syncId: `${ACCT}/bl`, exceptions: [] });
    expect(events[0].cells[Events.TITLE]).toBe('Someone else');
  });

  it('refuses tasks', async () => {
    const h = await new Harness().setup();
    expect(() => calendarPlanner.planDownload({ ...single(), '@type': 'Task' } as CalendarEventWire, null, h.ctx)).toThrow(/tasks/);
    expect(() => calendarPlanner.planDownload({ ...single(), '@type': undefined, due: '2026-10-01T00:00:00' } as unknown as CalendarEventWire, null, h.ctx)).toThrow(/tasks/);
  });

  it('merges an edited event another client moved out of every synced calendar where its rows are', async () => {
    const h = await new Harness().setup();
    await h.download(single());
    const id = Number(h.masterRow('e1')._id);
    h.fake.user.updateEvent(id, { [Events.TITLE]: 'Team lunch' });
    // Filed in a calendar this device does not sync, with a new description.
    const moved = single({ calendarIds: { archive: true }, description: 'Bring salad' });

    const plan = calendarPlanner.planDownload(moved, await h.local('e1'), h.ctx);
    await h.apply(plan.ops);

    expect(plan).toMatchObject({ effect: 'update', stillDirty: true, conflicts: 0 });
    expect(h.masterRow('e1')).toMatchObject({ [Events.CALENDAR_ID]: h.rowIds.get('b'), [Events.TITLE]: 'Team lunch', [Events.DESCRIPTION]: 'Bring salad', [Events.DIRTY]: 1 });
    const local = (await h.local('e1'))!;
    expect(local.shadow).toEqual(moved);
    // Only the device's edit goes up (no calendar move), and the accepted version takes the rows away.
    const plan2 = calendarPlanner.planUpload(local, h.ctx);
    expect(plan2.kind === 'upload' && plan2.actions).toEqual([{ kind: 'update', id: 'e1', patch: { title: 'Team lunch' } }]);
    await h.apply(calendarPlanner.planAccepted(local, { ...moved, title: 'Team lunch' }, h.ctx).ops);
    expect(await h.events()).toEqual([]);
  });

  it('places an event in several calendars in the first selected one, and keeps it where it is', async () => {
    const h = await new Harness().setup();
    await h.download(single({ calendarIds: { w: true, b: true } }));
    expect(h.masterRow('e1')[Events.CALENDAR_ID]).toBe(h.rowIds.get('b'));
    await h.download(single({ calendarIds: { w: true } }));
    expect(h.masterRow('e1')[Events.CALENDAR_ID]).toBe(h.rowIds.get('w'));
    await h.download(single({ calendarIds: { w: true, b: true }, title: 'x' }));
    expect(h.masterRow('e1')[Events.CALENDAR_ID]).toBe(h.rowIds.get('w'));
    expect(CALENDARS.w.name).toBe('Work');
  });
});
