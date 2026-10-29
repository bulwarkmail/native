import { describe, expect, it } from 'vitest';
import { Attendees, Events, Reminders } from '../../android-columns';
import { calendarPlanner } from '../../calendar/planner';
import type { UploadPlan } from '../../planner';
import type { CalendarEventWire } from '../../wire';
import type { Row } from '../../types';
import { cssColorToArgb } from '../../calendar/values';
import { Harness, ME, serverApply, single, utc, weekly } from './harness';

type Plan = UploadPlan<CalendarEventWire>;

function updateOf(plan: Plan) {
  expect(plan.kind).toBe('upload');
  if (plan.kind !== 'upload') throw new Error('not an upload');
  expect(plan.actions).toHaveLength(1);
  const action = plan.actions[0];
  if (action.kind !== 'update') throw new Error(`not an update: ${action.kind}`);
  return action;
}

async function synced(event: CalendarEventWire, options = {}) {
  const h = await new Harness(options).setup();
  await h.download(event);
  const id = Number(h.masterRow(event.id)._id);
  return { h, id };
}

const FIXTURES: Array<[string, () => CalendarEventWire]> = [
  ['a recurring event with overrides', weekly],
  ['a single timed event', () => single()],
  ['a floating event', () => single({ id: 'f', timeZone: null })],
  ['an all-day event', () => single({ id: 'a', start: '2026-10-08T00:00:00', timeZone: null, showWithoutTime: true, duration: 'P3D' })],
  ['a recurring all-day event', () => single({ id: 'y', start: '2026-10-08T00:00:00', timeZone: null, showWithoutTime: true, duration: 'P1D', recurrenceRule: { frequency: 'yearly' } })],
  ['an HTML description and a CSS colour name', () => single({ id: 'h', description: '<p>Hi <b>there</b></p>', descriptionContentType: 'text/html', color: 'rebeccapurple' })],
];

describe('calendar planner: uploads of edited events', () => {
  it.each(FIXTURES)('round-trips %s: rows untouched → clean', async (_name, make) => {
    const event = make();
    const { h, id } = await synced(event);
    // An app saving the event without changing anything.
    h.fake.user.updateEvent(id, {});
    const plan = calendarPlanner.planUpload((await h.local(event.id))!, h.ctx);
    expect(plan.kind).toBe('clean');
    if (plan.kind !== 'clean') return;
    await h.apply(plan.ops);
    expect(h.row(id)[Events.DIRTY]).toBe(0);
    // And the next download of the same event writes nothing.
    expect(calendarPlanner.planDownload(event, await h.local(event.id), h.ctx).effect).toBe('none');
  });

  it.each<[string, Row, Record<string, unknown>]>([
    ['title', { [Events.TITLE]: 'New title' }, { title: 'New title' }],
    ['description', { [Events.DESCRIPTION]: 'New text' }, { description: 'New text' }],
    ['a cleared description', { [Events.DESCRIPTION]: '' }, { description: null }],
    ['location', { [Events.EVENT_LOCATION]: 'Room 2' }, { 'locations/locA/name': 'Room 2' }],
    ['a cleared location', { [Events.EVENT_LOCATION]: null }, { 'locations/locA': null }],
    ['status', { [Events.STATUS]: 1 }, { status: 'confirmed' }],
    ['availability', { [Events.AVAILABILITY]: 0 }, { freeBusyStatus: 'busy' }],
    ['tentative availability (busy)', { [Events.AVAILABILITY]: 2 }, { freeBusyStatus: 'busy' }],
    ['privacy', { [Events.ACCESS_LEVEL]: 3 }, { privacy: 'public' }],
    ['default privacy', { [Events.ACCESS_LEVEL]: 0 }, { privacy: null }],
    ['colour', { [Events.EVENT_COLOR]: cssColorToArgb('#ff8800') }, { color: '#ff8800' }],
    ['duration', { [Events.DURATION]: 'P7200S' }, { duration: 'PT2H' }],
  ])('uploads one edited field of a series as a patch of only that field: %s', async (_name, values, patch) => {
    const { h, id } = await synced(weekly());
    h.fake.user.updateEvent(id, values);
    const action = updateOf(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx));
    expect(action.id).toBe('bl');
    expect(action.patch).toEqual(patch);
  });

  it('adds the first location as a whole map', async () => {
    const { h, id } = await synced(single());
    h.fake.user.updateEvent(id, { [Events.EVENT_LOCATION]: 'Café' });
    const action = updateOf(calendarPlanner.planUpload((await h.local('e1'))!, h.ctx));
    const [[key, value]] = Object.entries(action.patch.locations as Record<string, unknown>);
    expect(Object.keys(action.patch)).toEqual(['locations']);
    expect(key).toMatch(/^b[0-9a-z]{8}$/);
    expect(value).toEqual({ '@type': 'Location', name: 'Café' });
  });

  it('uploads an HTML description as text/plain only when it was edited', async () => {
    const { h, id } = await synced(single({ description: '<p>Hi <b>there</b></p>', descriptionContentType: 'text/html' }));
    expect(h.row(id)[Events.DESCRIPTION]).toBe('Hi there');
    h.fake.user.updateEvent(id, { [Events.DESCRIPTION]: 'Hi there!' });
    expect(updateOf(calendarPlanner.planUpload((await h.local('e1'))!, h.ctx)).patch).toEqual({
      description: 'Hi there!',
      descriptionContentType: 'text/plain',
    });
  });

  it('never uploads an edit of a description that was written truncated', async () => {
    const long = 'x'.repeat(70_000);
    const { h, id } = await synced(single({ description: long }));
    expect(String(h.row(id)[Events.DESCRIPTION]).length).toBe(65_536);
    h.fake.user.updateEvent(id, { [Events.DESCRIPTION]: 'short now', [Events.TITLE]: 'T' });
    expect(updateOf(calendarPlanner.planUpload((await h.local('e1'))!, h.ctx)).patch).toEqual({ title: 'T' });
  });

  it('moves a single event: start in its zone, the length unchanged', async () => {
    const { h, id } = await synced(single());
    h.fake.user.updateEvent(id, { [Events.DTSTART]: utc('2026-10-06T12:30:00Z'), [Events.DTEND]: utc('2026-10-06T13:30:00Z') });
    expect(updateOf(calendarPlanner.planUpload((await h.local('e1'))!, h.ctx)).patch).toEqual({ start: '2026-10-06T14:30:00' });
  });

  it('keeps a floating event floating, and takes a zone the user picked', async () => {
    const { h, id } = await synced(single({ id: 'f', timeZone: null }));
    h.fake.user.updateEvent(id, { [Events.DTSTART]: utc('2026-10-06T11:00:00Z'), [Events.DTEND]: utc('2026-10-06T12:00:00Z') });
    expect(updateOf(calendarPlanner.planUpload((await h.local('f'))!, h.ctx)).patch).toEqual({ start: '2026-10-06T13:00:00' });
    h.fake.user.updateEvent(id, { [Events.EVENT_TIMEZONE]: 'Asia/Tokyo' });
    expect(updateOf(calendarPlanner.planUpload((await h.local('f'))!, h.ctx)).patch).toEqual({ start: '2026-10-06T20:00:00', timeZone: 'Asia/Tokyo' });
  });

  it('keeps all-day events dates and turns timed ones into all-day ones', async () => {
    const { h, id } = await synced(single({ id: 'a', start: '2026-10-08T00:00:00', timeZone: null, showWithoutTime: true, duration: 'P1D' }));
    h.fake.user.updateEvent(id, { [Events.DTSTART]: utc('2026-10-09T00:00:00Z'), [Events.DTEND]: utc('2026-10-11T00:00:00Z') });
    expect(updateOf(calendarPlanner.planUpload((await h.local('a'))!, h.ctx)).patch).toEqual({ start: '2026-10-09T00:00:00', duration: 'P2D' });

    const t = await synced(single());
    t.h.fake.user.updateEvent(t.id, {
      [Events.ALL_DAY]: 1,
      [Events.EVENT_TIMEZONE]: 'UTC',
      [Events.DTSTART]: utc('2026-10-06T00:00:00Z'),
      [Events.DTEND]: utc('2026-10-07T00:00:00Z'),
    });
    expect(updateOf(calendarPlanner.planUpload((await t.h.local('e1'))!, t.h.ctx)).patch).toEqual({
      start: '2026-10-06T00:00:00',
      duration: 'P1D',
      timeZone: null,
      showWithoutTime: true,
    });
  });

  it('sends a single event whose new start is a repeated wall time in a fixed-offset zone', async () => {
    const { h, id } = await synced(single());
    // 02:30 CEST on the night the clocks go back: Stalwart would drop it in Europe/Berlin.
    h.fake.user.updateEvent(id, { [Events.DTSTART]: utc('2026-10-25T00:30:00Z'), [Events.DTEND]: utc('2026-10-25T01:30:00Z') });
    expect(updateOf(calendarPlanner.planUpload((await h.local('e1'))!, h.ctx)).patch).toEqual({ start: '2026-10-25T02:30:00', timeZone: 'Etc/GMT-2' });
    // The second 02:30 (CET) is the same wall time an hour later.
    h.fake.user.updateEvent(id, { [Events.DTSTART]: utc('2026-10-25T01:30:00Z'), [Events.DTEND]: utc('2026-10-25T02:30:00Z') });
    expect(updateOf(calendarPlanner.planUpload((await h.local('e1'))!, h.ctx)).patch).toEqual({ start: '2026-10-25T02:30:00', timeZone: 'Etc/GMT-1' });
  });

  it('skips a series whose new start is a repeated wall time', async () => {
    const { h, id } = await synced(single({ recurrenceRule: { frequency: 'daily' } }));
    h.fake.user.updateEvent(id, { [Events.DTSTART]: utc('2026-10-25T00:30:00Z') });
    expect(calendarPlanner.planUpload((await h.local('e1'))!, h.ctx)).toEqual({ kind: 'skip', reason: 'dstAmbiguous' });
  });

  it('never uploads the timing of a rule Android cannot represent', async () => {
    const event = single({ recurrenceRule: { frequency: 'yearly', rscale: 'chinese', byMonth: ['5L'] } });
    const { h, id } = await synced(event);
    expect(h.row(id)[Events.RRULE]).toBe('FREQ=YEARLY');
    h.fake.user.updateEvent(id, { [Events.DTSTART]: utc('2026-10-06T11:00:00Z') });
    expect(calendarPlanner.planUpload((await h.local('e1'))!, h.ctx)).toEqual({ kind: 'skip', reason: 'ruleNotRepresentable' });
    h.fake.user.updateEvent(id, { [Events.TITLE]: 'Festival' });
    expect(updateOf(calendarPlanner.planUpload((await h.local('e1'))!, h.ctx)).patch).toEqual({ title: 'Festival' });
  });

  it('uploads the user\'s RSVP with scheduling messages', async () => {
    const event = single({
      organizerCalendarAddress: 'mailto:boss@example.net',
      participants: {
        boss: { calendarAddress: 'mailto:boss@example.net', roles: { owner: true } },
        me: { calendarAddress: 'mailto:usera@example.org', roles: { attendee: true }, participationStatus: 'needs-action' },
      },
    } as Partial<CalendarEventWire>);
    const { h, id } = await synced(event);
    h.fake.user.setAttendeeStatus(id, ME, 1);
    const action = updateOf(calendarPlanner.planUpload((await h.local('e1'))!, h.ctx));
    expect(action).toMatchObject({ patch: { 'participants/me/participationStatus': 'accepted' }, sendSchedulingMessages: true });
  });

  it('adds and removes attendees; the organizer notifies them', async () => {
    const { h, id } = await synced(weekly());
    const guest = h.fake.rows('attendees', `${Attendees.EVENT_ID} = ? AND ${Attendees.ATTENDEE_EMAIL} = ?`, [id, 'guest@example.net'])[0];
    h.fake.user.removeAttendee(Number(guest._id));
    h.fake.user.addAttendee(id, {
      [Attendees.ATTENDEE_EMAIL]: 'new@example.net',
      [Attendees.ATTENDEE_NAME]: 'New',
      [Attendees.ATTENDEE_TYPE]: 2,
      [Attendees.ATTENDEE_RELATIONSHIP]: 1,
      [Attendees.ATTENDEE_STATUS]: 3,
    });
    const action = updateOf(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx));
    expect(action.sendSchedulingMessages).toBe(true);
    const added = Object.entries(action.patch).find(([k, v]) => k.startsWith('participants/') && v);
    expect(added![1]).toEqual({
      '@type': 'Participant',
      calendarAddress: 'mailto:new@example.net',
      name: 'New',
      roles: { attendee: true, optional: true },
      participationStatus: 'needs-action',
      expectReply: true,
    });
    expect(action.patch['participants/guestX']).toBeNull();
  });

  it('sends the whole participants map for the first attendee', async () => {
    const { h, id } = await synced(single());
    h.fake.user.addAttendee(id, { [Attendees.ATTENDEE_EMAIL]: 'guest@example.net', [Attendees.ATTENDEE_TYPE]: 1, [Attendees.ATTENDEE_STATUS]: 3 });
    const action = updateOf(calendarPlanner.planUpload((await h.local('e1'))!, h.ctx));
    expect(Object.keys(action.patch)).toEqual(['participants']);
    expect(Object.values(action.patch.participants as object)).toHaveLength(1);
    expect(action.sendSchedulingMessages).toBe(true);
  });

  it('replaces the reminders it can show, keeping the matching keys and the others', async () => {
    const { h, id } = await synced(weekly());
    h.fake.user.setReminders(id, [{ minutes: 15 }, { minutes: 60, method: 2 }]);
    const action = updateOf(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx));
    const keys = Object.keys(action.patch);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^alerts\/b[0-9a-z]{8}$/);
    expect(action.patch[keys[0]]).toEqual({ '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT1H', relativeTo: 'start' }, action: 'email' });
    // Reminders alone notify nobody.
    expect(action.sendSchedulingMessages).toBeUndefined();

    h.fake.user.setReminders(id, []);
    expect(updateOf(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx)).patch).toEqual({ 'alerts/al1': null });
  });

  it('switches off the calendar defaults when reminders of an event that used them change', async () => {
    const { h, id } = await synced(single({ useDefaultAlerts: true }));
    h.fake.user.setReminders(id, [{ minutes: 10 }, { minutes: 30 }]);
    const patch = updateOf(calendarPlanner.planUpload((await h.local('e1'))!, h.ctx)).patch;
    expect(patch.useDefaultAlerts).toBe(false);
    const alerts = patch.alerts as Record<string, { trigger: { offset: string } }>;
    // The default's key is kept for the reminder that matches it.
    expect(alerts.d1.trigger.offset).toBe('-PT10M');
    expect(Object.values(alerts).map((a) => a.trigger.offset).sort()).toEqual(['-PT10M', '-PT30M']);
  });

  it('does not upload reminders when Bulwark owns them', async () => {
    const { h, id } = await synced(weekly(), { reminderOwner: 'bulwark' });
    h.fake.user.setReminders(id, [{ minutes: 5 }]);
    expect(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx).kind).toBe('clean');
  });

  it('ignores attendee types and relationships a lossy editor rewrote, and merges its rule part by part', async () => {
    const event = weekly();
    event.recurrenceRule = { frequency: 'monthly', byDay: [{ day: 'mo' }, { day: 'tu' }], bySetPosition: [-1], count: 10 };
    const { h, id } = await synced(event);
    const attendees = h.fake.rows('attendees', `${Attendees.EVENT_ID} = ?`, [id]).map((a) => ({
      [Attendees.ATTENDEE_EMAIL]: a[Attendees.ATTENDEE_EMAIL],
      [Attendees.ATTENDEE_NAME]: a[Attendees.ATTENDEE_NAME],
      [Attendees.ATTENDEE_RELATIONSHIP]: 1,
      [Attendees.ATTENDEE_TYPE]: 1,
      [Attendees.ATTENDEE_STATUS]: a[Attendees.ATTENDEE_STATUS],
    }));
    const reminders = h.fake.rows('reminders', `${Reminders.EVENT_ID} = ?`, [id]).map((r) => ({ minutes: Number(r[Reminders.MINUTES]) }));
    // Fossify rebuilds the rule without BYSETPOS and changes the count.
    h.fake.user.fossifySaveEvent(id, { [Events.RRULE]: 'FREQ=MONTHLY;COUNT=12;BYDAY=MO,TU' }, attendees, reminders);
    h.fake.table('events').get(id)![Events.MUTATORS] = 'org.fossify.calendar';
    const action = updateOf(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx));
    expect(action.patch).toEqual({
      recurrenceRule: { frequency: 'monthly', count: 12, byDay: [{ day: 'mo' }, { day: 'tu' }], bySetPosition: [-1] },
    });
  });

  it('turns a series into a single event in place', async () => {
    const { h, id } = await synced(weekly());
    h.fake.user.updateEvent(id, { [Events.RRULE]: null, [Events.DURATION]: null, [Events.DTEND]: utc('2026-10-05T14:30:00Z') });
    const action = updateOf(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx));
    expect(action.patch).toEqual({ recurrenceRule: null, recurrenceOverrides: null });
    expect(action.sendSchedulingMessages).toBe(true);
  });

  it('moves an event between calendars of its account by swapping calendarIds', async () => {
    const { h, id } = await synced(single());
    h.fake.user.updateEvent(id, { [Events.CALENDAR_ID]: h.rowIds.get('w')! });
    expect(updateOf(calendarPlanner.planUpload((await h.local('e1'))!, h.ctx)).patch).toEqual({ 'calendarIds/b': null, 'calendarIds/w': true });
  });

  it('reverts edits in a read-only calendar, but lets an RSVP through', async () => {
    const event = single({
      calendarIds: { r: true },
      organizerCalendarAddress: 'mailto:boss@example.net',
      participants: {
        boss: { calendarAddress: 'mailto:boss@example.net', roles: { owner: true } },
        me: { calendarAddress: 'mailto:usera@example.org', roles: { attendee: true }, participationStatus: 'needs-action' },
      },
    } as Partial<CalendarEventWire>);
    const { h, id } = await synced(event);
    h.fake.user.updateEvent(id, { [Events.TITLE]: 'Mine now' });
    const plan = calendarPlanner.planUpload((await h.local('e1'))!, h.ctx);
    expect(plan).toMatchObject({ kind: 'revert', reason: 'readOnly' });
    if (plan.kind === 'revert') await h.apply(plan.ops);
    expect(h.row(id)).toMatchObject({ [Events.TITLE]: 'Lunch', [Events.DIRTY]: 0 });

    h.fake.user.setAttendeeStatus(id, ME, 2);
    expect(updateOf(calendarPlanner.planUpload((await h.local('e1'))!, h.ctx)).patch).toEqual({ 'participants/me/participationStatus': 'declined' });

    // Without mayRSVP, the answer is put back too, and says why.
    const noRsvp = { ...h.ctx, calendar: (cid: string) => (cid === 'r' ? { ...h.ctx.calendar(cid)!, myRights: { mayReadItems: true } } : h.ctx.calendar(cid)) };
    expect(calendarPlanner.planUpload((await h.local('e1'))!, noRsvp)).toMatchObject({ kind: 'revert', reason: 'rsvpRefused' });
  });

  it('skips a poisoned item until it changes or the back-off ends', async () => {
    const { h, id } = await synced(single());
    h.fake.user.updateEvent(id, { [Events.TITLE]: 'Bad' });
    const local = (await h.local('e1'))!;
    const { poisonFingerprint, poisonOps } = await import('../../calendar/planner');
    const { nextMarker } = await import('../../engine/poison');
    // The marker as the engine writes it after an invalidProperties SetError.
    const marker = nextMarker(null, poisonFingerprint(local), { type: 'invalidProperties' }, h.ctx.now, { firstMs: 3_600_000, maxMs: 86_400_000 });
    await h.apply(poisonOps(local, marker));
    expect(calendarPlanner.planUpload((await h.local('e1'))!, h.ctx)).toEqual({ kind: 'skip', reason: 'invalidProperties' });
    expect(calendarPlanner.planUpload((await h.local('e1'))!, { ...h.ctx, now: h.ctx.now + 7_200_000 }).kind).toBe('upload');
    h.fake.user.updateEvent(id, { [Events.TITLE]: 'Better' });
    expect(calendarPlanner.planUpload((await h.local('e1'))!, h.ctx).kind).toBe('upload');
  });

  it('applies a patch the server accepts (round trip through serverApply)', async () => {
    const { h, id } = await synced(weekly());
    h.fake.user.updateEvent(id, { [Events.TITLE]: 'Renamed', [Events.EVENT_LOCATION]: 'Hall' });
    const action = updateOf(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx));
    const server = serverApply(weekly(), action.patch);
    expect(server.title).toBe('Renamed');
    expect(server.locations).toEqual({ locA: { name: 'Hall', '@type': 'Location' } });
    expect(server.participants).toEqual(weekly().participants);
  });
});
