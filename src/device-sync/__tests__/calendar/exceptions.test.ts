import { describe, expect, it } from 'vitest';
import { Attendees, Events, Reminders } from '../../android-columns';
import { calendarPlanner } from '../../calendar/planner';
import { cssColorToArgb } from '../../calendar/values';
import type { LocalEvent, UploadPlan } from '../../planner';
import type { CalendarEventWire } from '../../wire';
import { ACCT, Harness, ME, serverApply, single, utc, weekly } from './harness';

type Plan = UploadPlan<CalendarEventWire>;

function patchOf(plan: Plan) {
  expect(plan.kind).toBe('upload');
  if (plan.kind !== 'upload' || plan.actions[0].kind !== 'update') throw new Error(JSON.stringify(plan));
  return plan.actions[0];
}

async function synced(event: CalendarEventWire) {
  const h = await new Harness().setup();
  await h.download(event);
  return { h, id: Number(h.masterRow(event.id)._id) };
}

/** Uploads, lets the server apply the patch, applies the accepted plan and returns the new server object. */
async function accept(h: Harness, event: CalendarEventWire, local: LocalEvent, plan: Plan): Promise<CalendarEventWire> {
  const action = patchOf(plan);
  const server = serverApply(event, action.patch);
  const accepted = calendarPlanner.planAccepted(local, server, h.ctx);
  await h.apply(accepted.ops);
  return server;
}

const NO_FORBIDDEN = ['@type', 'organizerCalendarAddress', 'privacy', 'uid', 'recurrenceRule', 'recurrenceOverrides', 'recurrenceId', 'method', 'prodId', 'sentBy'];

describe('calendar planner: recurrence edits made on the device', () => {
  it('uploads an Etar "this event" edit as a new override carrying the master\'s details', async () => {
    const { h, id } = await synced(weekly());
    h.fake.user.insertException(id, utc('2026-10-14T13:00:00Z'), {
      [Events.TITLE]: 'Only this Wednesday',
      [Events.DTSTART]: utc('2026-10-14T14:00:00Z'),
      [Events.DTEND]: utc('2026-10-14T15:30:00Z'),
    });
    const local = (await h.local('bl'))!;
    expect(local.exceptions.find((x) => !x.cells[Events.SYNC_DATA2])?.recurrenceId).toBe('2026-10-14T09:00:00');
    const plan = calendarPlanner.planUpload(local, h.ctx);
    const action = patchOf(plan);
    expect(Object.keys(action.patch)).toEqual(['recurrenceOverrides/2026-10-14T09:00:00']);
    const override = action.patch['recurrenceOverrides/2026-10-14T09:00:00'] as Record<string, unknown>;
    expect(override).toMatchObject({
      title: 'Only this Wednesday',
      start: '2026-10-14T10:00:00',
      duration: 'PT1H30M',
      locations: weekly().locations,
      participants: weekly().participants,
      description: 'desc',
    });
    for (const key of NO_FORBIDDEN) expect(override).not.toHaveProperty(key);
    // The organizer changed an instance: attendees are told.
    expect(action.sendSchedulingMessages).toBe(true);

    const server = await accept(h, weekly(), local, plan);
    const after = (await h.local('bl'))!;
    expect(after.dirty).toBe(false);
    expect(after.exceptions.map((x) => [x.syncId, x.dirty])).toEqual([
      [`${ACCT}/bl#2026-10-07T09:00:00`, false],
      [`${ACCT}/bl#2026-10-14T09:00:00`, false],
    ]);
    // The download of our own change writes nothing.
    expect(calendarPlanner.planDownload(server, after, h.ctx).effect).toBe('none');
  });

  it('sends the whole overrides map for the first override of a series', async () => {
    const event = single({ recurrenceRule: { frequency: 'daily', count: 5 } });
    const { h, id } = await synced(event);
    h.fake.user.insertException(id, utc('2026-10-07T10:00:00Z'), { [Events.TITLE]: 'Tuesday lunch', [Events.DTSTART]: utc('2026-10-07T10:00:00Z'), [Events.DTEND]: utc('2026-10-07T11:00:00Z') });
    const action = patchOf(calendarPlanner.planUpload((await h.local('e1'))!, h.ctx));
    expect(Object.keys(action.patch)).toEqual(['recurrenceOverrides']);
    expect(action.patch.recurrenceOverrides).toEqual({
      '2026-10-07T12:00:00': { title: 'Tuesday lunch', start: '2026-10-07T12:00:00', duration: 'PT1H' },
    });
  });

  it('uploads "delete this event" (a cancelled exception) as an exclusion and cleans up after', async () => {
    const { h, id } = await synced(weekly());
    h.fake.user.cancelInstance(id, utc('2026-10-14T13:00:00Z'), utc('2026-10-14T14:30:00Z'));
    const local = (await h.local('bl'))!;
    const plan = calendarPlanner.planUpload(local, h.ctx);
    expect(patchOf(plan).patch).toEqual({ 'recurrenceOverrides/2026-10-14T09:00:00': { excluded: true } });
    const server = await accept(h, weekly(), local, plan);
    expect(h.masterRow('bl')[Events.EXDATE]).toBe('20261012T130000Z,20261014T130000Z');
    const after = (await h.local('bl'))!;
    expect(after.exceptions.map((x) => x.recurrenceId)).toEqual(['2026-10-07T09:00:00']);
    expect(calendarPlanner.planDownload(server, after, h.ctx).effect).toBe('none');
  });

  it('excludes an instance whose synced exception row was deleted', async () => {
    const { h } = await synced(weekly());
    const x = (await h.local('bl'))!.exceptions[0];
    h.fake.user.deleteEvent(x.eventId);
    expect(h.row(x.eventId)).toMatchObject({ [Events.DELETED]: 1, [Events.DIRTY]: 1 });
    const local = (await h.local('bl'))!;
    const plan = calendarPlanner.planUpload(local, h.ctx);
    expect(patchOf(plan).patch).toEqual({ 'recurrenceOverrides/2026-10-07T09:00:00': { excluded: true } });
    await accept(h, weekly(), local, plan);
    expect(h.row(x.eventId)).toBeUndefined();
  });

  it('does not make an occurrence an app left without a status (Google Calendar\'s "this event") tentative', async () => {
    const event = single({ recurrenceRule: { frequency: 'weekly', count: 5 } });
    const { h, id } = await synced(event);
    h.fake.user.insertException(id, utc('2026-10-13T10:00:00Z'), {
      [Events.TITLE]: 'Only this Tuesday', [Events.DTSTART]: utc('2026-10-13T10:00:00Z'), [Events.DTEND]: utc('2026-10-13T11:00:00Z'), [Events.STATUS]: null,
    });
    const local = (await h.local('e1'))!;
    const plan = calendarPlanner.planUpload(local, h.ctx);
    const overrides = patchOf(plan).patch.recurrenceOverrides as Record<string, Record<string, unknown>>;
    expect(overrides['2026-10-13T12:00:00']).toEqual({ title: 'Only this Tuesday', start: '2026-10-13T12:00:00', duration: 'PT1H' });
    await accept(h, event, local, plan);
    const [x] = (await h.local('e1'))!.exceptions;
    expect(x.cells).toMatchObject({ [Events.STATUS]: 1, [Events.DIRTY]: 0 });
  });

  it('clears an occurrence\'s own description and location instead of letting the series\' come back', async () => {
    const event = weekly();
    event.description = 'Daily agenda';
    event.recurrenceOverrides!['2026-10-07T09:00:00'] = {
      ...event.recurrenceOverrides!['2026-10-07T09:00:00'],
      description: 'Special agenda',
      locations: { locB: { '@type': 'Location', name: 'Room 2' } },
    };
    const { h } = await synced(event);
    const x = (await h.local('bl'))!.exceptions[0];
    expect(h.row(x.eventId)).toMatchObject({ [Events.DESCRIPTION]: 'Special agenda', [Events.EVENT_LOCATION]: 'Room 2' });
    h.fake.user.updateEvent(x.eventId, { [Events.DESCRIPTION]: null, [Events.EVENT_LOCATION]: null });
    const local = (await h.local('bl'))!;
    const plan = calendarPlanner.planUpload(local, h.ctx);
    const server = await accept(h, event, local, plan);
    expect(h.row(x.eventId)).toMatchObject({ [Events.DESCRIPTION]: null, [Events.EVENT_LOCATION]: null, [Events.DIRTY]: 0 });
    expect(calendarPlanner.planDownload(server, (await h.local('bl'))!, h.ctx).effect).toBe('none');
    // Without a value of its own the override would show the series' "Daily agenda" and "Room 1" again, so it
    // gets the empty ones Stalwart keeps (an empty map would read back as no locations, i.e. the series' ones).
    expect(patchOf(plan).patch).toEqual({
      'recurrenceOverrides/2026-10-07T09:00:00/description': '',
      'recurrenceOverrides/2026-10-07T09:00:00/locations': { locB: { '@type': 'Location', name: '' } },
    });
  });

  it('removes an occurrence\'s own description and location when the series has none to show instead', async () => {
    const event = weekly();
    delete event.description;
    delete event.locations;
    event.recurrenceOverrides!['2026-10-07T09:00:00'] = {
      ...event.recurrenceOverrides!['2026-10-07T09:00:00'],
      description: 'Special agenda',
      locations: { locB: { '@type': 'Location', name: 'Room 2' } },
    };
    const { h } = await synced(event);
    const x = (await h.local('bl'))!.exceptions[0];
    h.fake.user.updateEvent(x.eventId, { [Events.DESCRIPTION]: null, [Events.EVENT_LOCATION]: null });
    expect(patchOf(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx)).patch).toEqual({
      'recurrenceOverrides/2026-10-07T09:00:00/description': null,
      'recurrenceOverrides/2026-10-07T09:00:00/locations': null,
    });
  });

  it('keeps a reminder changed on one occurrence of a series that uses the calendar\'s default alerts', async () => {
    const event = weekly();
    delete event.alerts;
    event.useDefaultAlerts = true;
    const { h, id } = await synced(event);
    const minutes = (eventId: number) => h.fake.rows('reminders', `${Reminders.EVENT_ID} = ?`, [eventId]).map((r) => Number(r[Reminders.MINUTES]));
    const x = (await h.local('bl'))!.exceptions[0];
    // The calendar's default (10 minutes) on the series and on its occurrences.
    expect([minutes(id), minutes(x.eventId)]).toEqual([[10], [10]]);
    h.fake.user.setReminders(x.eventId, [{ minutes: 60 }]);
    // A new occurrence edit with its own reminder, too (Etar "this event").
    const added = h.fake.user.insertException(id, utc('2026-10-14T13:00:00Z'), {
      [Events.TITLE]: 'Probe weekly', [Events.DTSTART]: utc('2026-10-14T13:00:00Z'), [Events.DTEND]: utc('2026-10-14T14:30:00Z'),
    });
    h.fake.user.setReminders(added, [{ minutes: 5 }]);
    const local = (await h.local('bl'))!;
    const plan = calendarPlanner.planUpload(local, h.ctx);
    const server = await accept(h, event, local, plan);
    const after = (await h.local('bl'))!;
    expect(after.exceptions.map((e) => [e.recurrenceId, minutes(e.eventId), e.dirty])).toEqual([
      ['2026-10-07T09:00:00', [60], false],
      ['2026-10-14T09:00:00', [5], false],
    ]);
    // The series and its other occurrences keep the calendar's defaults.
    expect(server.useDefaultAlerts).toBe(true);
    expect(minutes(id)).toEqual([10]);
    expect(calendarPlanner.planDownload(server, after, h.ctx).effect).toBe('none');
    // Only the occurrences leave the defaults: `useDefaultAlerts` is a property an override can patch.
    const patch = patchOf(plan).patch;
    expect(patch['recurrenceOverrides/2026-10-07T09:00:00/useDefaultAlerts']).toBe(false);
    expect(patch['recurrenceOverrides/2026-10-14T09:00:00']).toMatchObject({ useDefaultAlerts: false });
  });

  it('clears an occurrence\'s own colour instead of letting the series\' come back', async () => {
    const event = weekly();
    event.recurrenceOverrides!['2026-10-07T09:00:00'] = { ...event.recurrenceOverrides!['2026-10-07T09:00:00'], color: 'red' };
    const { h } = await synced(event);
    const x = (await h.local('bl'))!.exceptions[0];
    expect(h.row(x.eventId)[Events.EVENT_COLOR]).toBe(cssColorToArgb('red'));
    h.fake.user.updateEvent(x.eventId, { [Events.EVENT_COLOR]: null });
    const local = (await h.local('bl'))!;

    const plan = calendarPlanner.planUpload(local, h.ctx);

    // Without a colour of its own the occurrence would show the series' steelblue again: an empty one, which Stalwart keeps.
    expect(patchOf(plan).patch).toEqual({ 'recurrenceOverrides/2026-10-07T09:00:00/color': '' });
    const server = await accept(h, event, local, plan);
    expect(h.row(x.eventId)).toMatchObject({ [Events.EVENT_COLOR]: null, [Events.DIRTY]: 0 });
    expect(calendarPlanner.planDownload(server, (await h.local('bl'))!, h.ctx).effect).toBe('none');

    // A series without a colour has none to show: the occurrence's own is removed.
    const plain = weekly();
    delete plain.color;
    plain.recurrenceOverrides!['2026-10-07T09:00:00'] = { ...plain.recurrenceOverrides!['2026-10-07T09:00:00'], color: 'red' };
    const p = await synced(plain);
    const px = (await p.h.local('bl'))!.exceptions[0];
    p.h.fake.user.updateEvent(px.eventId, { [Events.EVENT_COLOR]: null });
    expect(patchOf(calendarPlanner.planUpload((await p.h.local('bl'))!, p.h.ctx)).patch).toEqual({ 'recurrenceOverrides/2026-10-07T09:00:00/color': null });
  });

  it('removes every reminder of one occurrence of a series on the calendar\'s defaults', async () => {
    const event = weekly();
    delete event.alerts;
    event.useDefaultAlerts = true;
    event.recurrenceOverrides!['2026-10-07T09:00:00'] = {
      ...event.recurrenceOverrides!['2026-10-07T09:00:00'],
      useDefaultAlerts: false,
      alerts: { a60: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT1H', relativeTo: 'start' }, action: 'display' } },
    };
    const { h } = await synced(event);
    const x = (await h.local('bl'))!.exceptions[0];
    h.fake.user.setReminders(x.eventId, []);
    const local = (await h.local('bl'))!;

    const plan = calendarPlanner.planUpload(local, h.ctx);
    const server = await accept(h, event, local, plan);

    // Stalwart drops the empty map, but the series has no alerts of its own to show instead.
    expect(server.recurrenceOverrides!['2026-10-07T09:00:00']).toMatchObject({ useDefaultAlerts: false });
    expect(server.recurrenceOverrides!['2026-10-07T09:00:00']).not.toHaveProperty('alerts');
    expect(h.fake.rows('reminders', `${Reminders.EVENT_ID} = ?`, [x.eventId])).toEqual([]);
    expect(h.row(x.eventId)[Events.DIRTY]).toBe(0);
    expect(calendarPlanner.planDownload(server, (await h.local('bl'))!, h.ctx).effect).toBe('none');
  });

  it('puts back and reports the removal of every reminder of one occurrence whose series would show its own again', async () => {
    const event = weekly();
    event.alerts = { al1: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M', relativeTo: 'start' }, action: 'display' } };
    const { h } = await synced(event);
    const minutes = (eventId: number) => h.fake.rows('reminders', `${Reminders.EVENT_ID} = ?`, [eventId]).map((r) => Number(r[Reminders.MINUTES]));
    const x = (await h.local('bl'))!.exceptions[0];
    expect(minutes(x.eventId)).toEqual([15]);
    h.fake.user.setReminders(x.eventId, []);

    // An override without alerts shows the series' (Stalwart writes no VALARM for an empty map): none can't be stored.
    const plan = calendarPlanner.planUpload((await h.local('bl'))!, h.ctx);
    expect(plan).toMatchObject({ kind: 'revert', reason: 'remindersNotRepresentable' });
    if (plan.kind === 'revert') await h.apply(plan.ops);
    expect(minutes(x.eventId)).toEqual([15]);
    expect(h.row(x.eventId)[Events.DIRTY]).toBe(0);

    // With another edit, that one goes up alone.
    h.fake.user.setReminders(x.eventId, []);
    h.fake.user.updateEvent(x.eventId, { [Events.TITLE]: 'Moved again' });
    expect(patchOf(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx)).patch).toEqual({ 'recurrenceOverrides/2026-10-07T09:00:00/title': 'Moved again' });
  });

  it('patches an existing override one level deep, never deeper', async () => {
    const { h } = await synced(weekly());
    const x = (await h.local('bl'))!.exceptions[0];
    h.fake.user.updateEvent(x.eventId, { [Events.TITLE]: 'Moved again', [Events.EVENT_LOCATION]: 'Annex' });
    const action = patchOf(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx));
    expect(action.patch).toEqual({
      'recurrenceOverrides/2026-10-07T09:00:00/title': 'Moved again',
      'recurrenceOverrides/2026-10-07T09:00:00/locations': { locA: { name: 'Annex', '@type': 'Location' } },
    });
  });

  it('answers one instance (CONTENT_EXCEPTION_URI) with the override\'s whole participants map', async () => {
    const invite = weekly();
    invite.organizerCalendarAddress = 'mailto:boss@example.net';
    invite.participants = {
      boss: { calendarAddress: 'mailto:boss@example.net', roles: { owner: true }, participationStatus: 'accepted' },
      me: { calendarAddress: 'mailto:usera@example.org', roles: { attendee: true }, participationStatus: 'needs-action' },
      other: { calendarAddress: 'mailto:other@example.net', roles: { attendee: true }, participationStatus: 'accepted' },
    };
    const { h, id } = await synced(invite);
    h.fake.user.exceptionViaUri(id, utc('2026-10-19T13:00:00Z'), { [Events.SELF_ATTENDEE_STATUS]: 1, [Events.STATUS]: 1 });
    const action = patchOf(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx));
    const override = action.patch['recurrenceOverrides/2026-10-19T09:00:00'] as Record<string, unknown>;
    expect(override.participants).toEqual({ ...invite.participants, me: { ...invite.participants!.me, participationStatus: 'accepted' } });
    // Etar's STATUS_CONFIRMED on the instance is not the attendee's to upload: the series' status is kept.
    expect(override).toMatchObject({ status: 'tentative', start: '2026-10-19T09:00:00', duration: 'PT1H30M', title: 'Probe weekly' });
    for (const key of NO_FORBIDDEN) expect(override).not.toHaveProperty(key);
    // An attendee's RSVP sends the REPLY.
    expect(action.sendSchedulingMessages).toBe(true);
  });

  it('lets an answer to one occurrence through in a calendar that grants only RSVP, and nothing more', async () => {
    const invite = weekly();
    invite.calendarIds = { r: true };
    invite.organizerCalendarAddress = 'mailto:boss@example.net';
    invite.participants = {
      boss: { calendarAddress: 'mailto:boss@example.net', roles: { owner: true }, participationStatus: 'accepted' },
      me: { calendarAddress: 'mailto:usera@example.org', roles: { attendee: true }, participationStatus: 'needs-action' },
    };
    const { h, id } = await synced(invite);
    // Etar answers Oct 19 through CONTENT_EXCEPTION_URI (a new override)...
    const added = h.fake.user.exceptionViaUri(id, utc('2026-10-19T13:00:00Z'), { [Events.SELF_ATTENDEE_STATUS]: 2, [Events.STATUS]: 1 });
    // ... and another app answers the existing override of Oct 7 on its row.
    const existing = (await h.local('bl'))!.exceptions.find((x) => x.recurrenceId === '2026-10-07T09:00:00')!;
    h.fake.table('attendees').forEach((a) => {
      if (a.event_id === existing.eventId && a[Attendees.ATTENDEE_EMAIL] === ME) a[Attendees.ATTENDEE_STATUS] = 1;
    });
    h.fake.user.updateEvent(existing.eventId, {});
    const action = patchOf(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx));
    type Answer = { participants: Record<string, { participationStatus?: string }> };
    expect((action.patch['recurrenceOverrides/2026-10-19T09:00:00'] as Answer).participants.me.participationStatus).toBe('declined');
    expect((action.patch['recurrenceOverrides/2026-10-07T09:00:00/participants'] as Answer['participants']).me.participationStatus).toBe('accepted');
    expect(action.sendSchedulingMessages).toBe(true);
    // Anything more than the answer is still the calendar owner's to change.
    h.fake.user.updateEvent(added, { [Events.TITLE]: 'Mine now' });
    expect(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx)).toMatchObject({ kind: 'revert', reason: 'readOnly' });
  });

  it('turns EXDATE entries an app adds or removes into exclusions and re-inclusions', async () => {
    const { h, id } = await synced(weekly());
    h.fake.user.updateEvent(id, { [Events.EXDATE]: '20261012T130000Z\nAmerica/New_York;20261021T090000' });
    expect(patchOf(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx)).patch).toEqual({
      'recurrenceOverrides/2026-10-21T09:00:00': { excluded: true },
    });
    h.fake.user.updateEvent(id, { [Events.EXDATE]: null });
    expect(patchOf(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx)).patch).toEqual({
      'recurrenceOverrides/2026-10-12T09:00:00': null,
    });
  });

  it('uploads Etar\'s "this and following" as a capped rule, prunes later overrides, and creates the new series', async () => {
    const event = weekly();
    event.recurrenceRule = { frequency: 'weekly', byDay: [{ day: 'mo' }, { day: 'we' }] };
    event.recurrenceOverrides = {
      '2026-10-07T09:00:00': { title: 'Moved Wednesday', start: '2026-10-07T11:00:00' },
      '2026-10-21T09:00:00': { title: 'Later one' },
      '2026-10-26T09:00:00': { excluded: true },
    };
    const { h, id } = await synced(event);
    // Split at Mon 2026-10-19 09:00 New York: UNTIL = the instance minus one second, in UTC.
    h.fake.user.updateEvent(id, { [Events.RRULE]: 'FREQ=WEEKLY;UNTIL=20261019T125959Z;BYDAY=MO,WE' });
    const fresh = h.fake.user.insertEvent(h.rowIds.get('b')!, {
      [Events.TITLE]: 'Probe weekly (new time)',
      [Events.DTSTART]: utc('2026-10-19T14:00:00Z'),
      [Events.DURATION]: 'P5400S',
      [Events.RRULE]: 'FREQ=WEEKLY;BYDAY=MO,WE',
      [Events.EVENT_TIMEZONE]: 'America/New_York',
      [Events.STATUS]: 1,
    });
    const action = patchOf(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx));
    expect(action.patch).toEqual({
      recurrenceRule: { frequency: 'weekly', until: '2026-10-19T08:59:59', byDay: [{ day: 'mo' }, { day: 'we' }] },
      'recurrenceOverrides/2026-10-21T09:00:00': null,
      'recurrenceOverrides/2026-10-26T09:00:00': null,
    });

    // The new series is a new event: claimed with a fresh uid, then created.
    const newRow = await h.byRow(fresh);
    const claim = calendarPlanner.planUpload(newRow, h.ctx);
    expect(claim.kind).toBe('claim');
    if (claim.kind === 'claim') await h.apply(claim.ops);
    const claimed = await h.byRow(fresh);
    expect(claimed.syncId).toMatch(/^~pending\//);
    expect(claimed.pending).toEqual({ uid: claimed.cells[Events.UID_2445], target: `${ACCT}/b` });
    const create = calendarPlanner.planUpload(claimed, h.ctx);
    expect(create.kind).toBe('upload');
    if (create.kind !== 'upload' || create.actions[0].kind !== 'create') throw new Error('no create');
    expect(create.actions[0]).toMatchObject({
      kind: 'create',
      uid: claimed.pending!.uid,
      collectionId: 'b',
      object: {
        '@type': 'Event',
        uid: claimed.pending!.uid,
        calendarIds: { b: true },
        title: 'Probe weekly (new time)',
        start: '2026-10-19T10:00:00',
        timeZone: 'America/New_York',
        duration: 'PT1H30M',
        recurrenceRule: { frequency: 'weekly', byDay: [{ day: 'mo' }, { day: 'we' }] },
      },
    });
  });

  it('prunes overrides after a series Etar capped with a lower COUNT, using the provider\'s LAST_DATE', async () => {
    const { h, id } = await synced(weekly());
    // COUNT 10 → 3 (Mon 5, Wed 7, Mon 12); the provider computed LAST_DATE = last start + duration.
    h.fake.user.updateEvent(id, { [Events.RRULE]: 'FREQ=WEEKLY;COUNT=3;BYDAY=MO,WE' });
    h.fake.table('events').get(id)![Events.LAST_DATE] = utc('2026-10-12T13:00:00Z') + 5_400_000;
    const event = weekly();
    event.recurrenceOverrides!['2026-10-14T09:00:00'] = { title: 'x' };
    const local = (await h.local('bl'))!;
    local.shadow = event;
    expect(patchOf(calendarPlanner.planUpload(local, h.ctx)).patch).toEqual({
      recurrenceRule: { frequency: 'weekly', count: 3, byDay: [{ day: 'mo' }, { day: 'we' }] },
      'recurrenceOverrides/2026-10-14T09:00:00': null,
    });
  });

  it('moves every recurrence id with an "all events" start change', async () => {
    const { h, id } = await synced(weekly());
    h.fake.user.updateEvent(id, { [Events.DTSTART]: utc('2026-10-05T14:00:00Z') });
    const action = patchOf(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx));
    expect(action.patch).toEqual({
      start: '2026-10-05T10:00:00',
      recurrenceOverrides: {
        '2026-10-12T10:00:00': { excluded: true },
        // Its own start was a move elsewhere: it stays.
        '2026-10-07T10:00:00': { updated: '2026-09-26T22:57:38Z', title: 'Moved Wednesday', start: '2026-10-07T11:00:00' },
      },
    });
  });

  it('resolves a CONTENT_EXCEPTION_URI split: the clone becomes a new event, the source uploads its capped rule', async () => {
    const event = weekly();
    event.recurrenceRule = { frequency: 'weekly', byDay: [{ day: 'mo' }, { day: 'we' }] };
    event.recurrenceOverrides = { '2026-10-07T09:00:00': { title: 'Moved Wednesday', start: '2026-10-07T11:00:00' }, '2026-10-21T09:00:00': { title: 'Later' } };
    const { h, id } = await synced(event);
    const clone = h.fake.user.splitViaUri(id, utc('2026-10-19T13:00:00Z'), '20261019T125959Z', { [Events.TITLE]: 'New series' });
    const all = await h.events();
    const source = all.find((e) => e.eventId === id)!;
    const cloneEvent = all.find((e) => e.eventId === clone)!;
    expect([source.split, cloneEvent.split]).toEqual(['source', 'clone']);
    expect(source.dirty).toBe(false);

    // The source's rule was capped without DIRTY; it uploads as it stands.
    expect(patchOf(calendarPlanner.planUpload(source, h.ctx)).patch).toEqual({
      recurrenceRule: { frequency: 'weekly', until: '2026-10-19T08:59:59', byDay: [{ day: 'mo' }, { day: 'we' }] },
      'recurrenceOverrides/2026-10-21T09:00:00': null,
    });

    // The clone is claimed under a fresh uid, drops the source's sync data and marks the source dirty.
    const claim = calendarPlanner.planUpload(cloneEvent, h.ctx);
    expect(claim.kind).toBe('claim');
    if (claim.kind === 'claim') await h.apply(claim.ops);
    const after = await h.events();
    const claimed = after.find((e) => e.eventId === clone)!;
    expect(claimed.syncId).toMatch(/^~pending\//);
    expect(claimed.cells[Events.UID_2445]).not.toBe(event.uid);
    expect(claimed.shadow).toBeNull();
    expect(claimed.split).toBeUndefined();
    const sourceAfter = after.find((e) => e.eventId === id)!;
    expect(sourceAfter.dirty).toBe(true);
    // The source keeps its exceptions (and their link) whatever the provider's trigger did.
    expect(sourceAfter.exceptions.map((x) => x.cells[Events.ORIGINAL_SYNC_ID])).toEqual([`${ACCT}/bl`, `${ACCT}/bl`]);
    expect(patchOf(calendarPlanner.planUpload(sourceAfter, h.ctx)).patch.recurrenceRule).toMatchObject({ until: '2026-10-19T08:59:59' });
  });

  it('keeps a local exception edit through a download that changed another instance', async () => {
    const { h } = await synced(weekly());
    const x = (await h.local('bl'))!.exceptions[0];
    h.fake.user.updateEvent(x.eventId, { [Events.TITLE]: 'Local title' });
    const remote = weekly();
    remote.recurrenceOverrides!['2026-10-19T09:00:00'] = { title: 'Remote added' };
    const plan = await h.download(remote);
    expect(plan).toMatchObject({ conflicts: 0, stillDirty: true });
    const after = (await h.local('bl'))!;
    expect(after.exceptions.map((e) => [e.recurrenceId, e.cells[Events.TITLE], e.dirty])).toEqual([
      ['2026-10-07T09:00:00', 'Local title', true],
      ['2026-10-19T09:00:00', 'Remote added', false],
    ]);
    expect(patchOf(calendarPlanner.planUpload(after, h.ctx)).patch).toEqual({ 'recurrenceOverrides/2026-10-07T09:00:00/title': 'Local title' });
  });

  it('lets a server removal of an override win over a local edit of it', async () => {
    const { h } = await synced(weekly());
    const x = (await h.local('bl'))!.exceptions[0];
    h.fake.user.updateEvent(x.eventId, { [Events.TITLE]: 'Local title' });
    const remote = weekly();
    delete remote.recurrenceOverrides!['2026-10-07T09:00:00'];
    const plan = await h.download(remote);
    expect(plan.conflicts).toBe(1);
    expect(h.row(x.eventId)).toBeUndefined();
  });

  it('lets a device deletion of an instance win over a server edit of it', async () => {
    const { h } = await synced(weekly());
    const x = (await h.local('bl'))!.exceptions[0];
    h.fake.user.deleteEvent(x.eventId);
    const remote = weekly();
    remote.recurrenceOverrides!['2026-10-07T09:00:00'] = { title: 'Remote title', start: '2026-10-07T11:00:00' };
    const plan = await h.download(remote);
    expect(plan).toMatchObject({ conflicts: 0, stillDirty: true });
    expect(patchOf(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx)).patch).toEqual({
      'recurrenceOverrides/2026-10-07T09:00:00': { excluded: true },
    });
  });

  it('writes an all-day series\' exceptions at UTC midnight and keys them by date', async () => {
    const event = single({
      id: 'ad',
      start: '2026-10-05T00:00:00',
      timeZone: null,
      showWithoutTime: true,
      duration: 'P1D',
      recurrenceRule: { frequency: 'daily', count: 5 },
      recurrenceOverrides: { '2026-10-06T00:00:00': { title: 'Day two' }, '2026-10-07T00:00:00': { excluded: true } },
    });
    const { h, id } = await synced(event);
    expect(h.row(id)).toMatchObject({ [Events.EXDATE]: '20261007', [Events.DURATION]: 'P1D' });
    const [x] = (await h.local('ad'))!.exceptions;
    expect(x.cells).toMatchObject({ [Events.ORIGINAL_INSTANCE_TIME]: utc('2026-10-06T00:00:00Z'), [Events.ORIGINAL_ALL_DAY]: 1, [Events.DTSTART]: utc('2026-10-06T00:00:00Z'), [Events.DTEND]: utc('2026-10-07T00:00:00Z') });
    // Etar cancels day four.
    h.fake.user.cancelInstance(id, utc('2026-10-08T00:00:00Z'), utc('2026-10-09T00:00:00Z'));
    expect(patchOf(calendarPlanner.planUpload((await h.local('ad'))!, h.ctx)).patch).toEqual({ 'recurrenceOverrides/2026-10-08T00:00:00': { excluded: true } });
  });

  it('skips a series whose instance to change is a repeated wall time', async () => {
    const event = single({ id: 'n', start: '2026-10-20T02:30:00', recurrenceRule: { frequency: 'daily' } });
    const { h, id } = await synced(event);
    // Etar "this event" on the 25th: 02:30 happens twice that night in Berlin.
    h.fake.user.insertException(id, utc('2026-10-25T00:30:00Z'), { [Events.TITLE]: 'x', [Events.DTSTART]: utc('2026-10-25T00:30:00Z'), [Events.DTEND]: utc('2026-10-25T01:30:00Z') });
    expect(calendarPlanner.planUpload((await h.local('n'))!, h.ctx)).toEqual({ kind: 'skip', reason: 'dstAmbiguous' });
  });

  it('moves an UNTIL that falls into a DST gap or overlap one hour later', async () => {
    const { h, id } = await synced(single({ recurrenceRule: { frequency: 'daily' } }));
    // Until 2026-10-25 00:30Z = 02:30 CEST, a repeated wall time Stalwart would drop.
    h.fake.user.updateEvent(id, { [Events.RRULE]: 'FREQ=DAILY;UNTIL=20261025T003000Z' });
    expect(patchOf(calendarPlanner.planUpload((await h.local('e1'))!, h.ctx)).patch).toEqual({
      recurrenceRule: { frequency: 'daily', until: '2026-10-25T03:30:00' },
    });
  });

  it('keeps the organizer and other attendees on the instance a pointer RSVP would have dropped', async () => {
    const { h, id } = await synced(weekly());
    const x = (await h.local('bl'))!.exceptions[0];
    h.fake.table('attendees').forEach((a) => {
      if (a.event_id === x.eventId && a[Attendees.ATTENDEE_EMAIL] === ME) a[Attendees.ATTENDEE_STATUS] = 2;
    });
    h.fake.user.updateEvent(x.eventId, {});
    const action = patchOf(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx));
    expect(Object.keys(action.patch)).toEqual(['recurrenceOverrides/2026-10-07T09:00:00/participants']);
    expect(Object.keys(action.patch['recurrenceOverrides/2026-10-07T09:00:00/participants'] as object)).toEqual(['me1', 'guestX']);
    expect(id).toBeGreaterThan(0);
  });
});
