/**
 * Upload → server → accepted plan → the server's echo: after every kind of
 * device edit, the rows must already be what the server's next download
 * describes, so that echo writes nothing (docs/device-sync.md, invariant 4).
 */
import { describe, expect, it } from 'vitest';
import { Attendees, Events } from '../../android-columns';
import { calendarPlanner } from '../../calendar/planner';
import type { CalendarEventWire } from '../../wire';
import { ACCT, Harness, ME, serverApply, single, utc, weekly } from './harness';

async function roundTrip(event: CalendarEventWire, edit: (h: Harness, id: number) => void | Promise<void>) {
  const h = await new Harness().setup();
  await h.download(event);
  const id = Number(h.masterRow(event.id)._id);
  await edit(h, id);
  const local = (await h.local(event.id))!;
  const plan = calendarPlanner.planUpload(local, h.ctx);
  if (plan.kind !== 'upload' || plan.actions[0].kind !== 'update') throw new Error(`expected an update: ${JSON.stringify(plan)}`);
  const server = { ...serverApply(event, plan.actions[0].patch), updated: '2026-09-27T13:00:00Z' };
  await h.apply(calendarPlanner.planAccepted(local, server, h.ctx).ops);
  const after = (await h.local(event.id))!;
  return { h, id, server, after, patch: plan.actions[0].patch };
}

const EDITS: Array<[string, () => CalendarEventWire, (h: Harness, id: number) => void | Promise<void>]> = [
  ['a title', weekly, (h, id) => h.fake.user.updateEvent(id, { [Events.TITLE]: 'T' })],
  ['a start of a single event', () => single(), (h, id) => h.fake.user.updateEvent(id, { [Events.DTSTART]: utc('2026-10-06T11:00:00Z'), [Events.DTEND]: utc('2026-10-06T12:00:00Z') })],
  ['a DST-ambiguous start (fixed-offset zone)', () => single(), (h, id) => h.fake.user.updateEvent(id, { [Events.DTSTART]: utc('2026-10-25T00:30:00Z'), [Events.DTEND]: utc('2026-10-25T01:30:00Z') })],
  ['an "all events" move', weekly, (h, id) => h.fake.user.updateEvent(id, { [Events.DTSTART]: utc('2026-10-05T14:00:00Z') })],
  ['a "this event" edit', weekly, (h, id) => void h.fake.user.insertException(id, utc('2026-10-14T13:00:00Z'), { [Events.TITLE]: 'Only this', [Events.DTSTART]: utc('2026-10-14T13:00:00Z'), [Events.DTEND]: utc('2026-10-14T14:30:00Z') })],
  ['a cancelled instance', weekly, (h, id) => void h.fake.user.cancelInstance(id, utc('2026-10-19T13:00:00Z'), utc('2026-10-19T14:30:00Z'))],
  ['a capped rule', weekly, (h, id) => h.fake.user.updateEvent(id, { [Events.RRULE]: 'FREQ=WEEKLY;UNTIL=20261010T000000Z;BYDAY=MO,WE' })],
  ['an RSVP', weekly, (h, id) => h.fake.user.setAttendeeStatus(id, ME, 4)],
  ['an added attendee', weekly, (h, id) => void h.fake.user.addAttendee(id, { [Attendees.ATTENDEE_EMAIL]: 'x@example.net', [Attendees.ATTENDEE_TYPE]: 1, [Attendees.ATTENDEE_STATUS]: 3, [Attendees.ATTENDEE_RELATIONSHIP]: 1 })],
  ['reminders', weekly, (h, id) => h.fake.user.setReminders(id, [{ minutes: 5 }, { minutes: 1440, method: 2 }])],
  ['a location on an event without one', () => single(), (h, id) => h.fake.user.updateEvent(id, { [Events.EVENT_LOCATION]: 'Hall' })],
  ['an all-day event\'s dates', () => single({ id: 'a', start: '2026-10-08T00:00:00', timeZone: null, showWithoutTime: true, duration: 'P1D' }), (h, id) => h.fake.user.updateEvent(id, { [Events.DTSTART]: utc('2026-10-09T00:00:00Z'), [Events.DTEND]: utc('2026-10-12T00:00:00Z') })],
];

describe('calendar planner: accepted uploads leave nothing for the echo', () => {
  it.each(EDITS)('%s', async (_name, make, edit) => {
    const { h, server, after } = await roundTrip(make(), edit);
    expect(after.dirty).toBe(false);
    expect(after.exceptions.every((x) => !x.dirty)).toBe(true);
    const echo = calendarPlanner.planDownload(server, after, h.ctx);
    expect(echo).toMatchObject({ effect: 'none', writes: 0 });
    expect(calendarPlanner.planBaselineHeal(after)).toBeNull();
  });

  it('re-keys the exception rows with the series after an "all events" move', async () => {
    const { after, patch } = await roundTrip(weekly(), (h, id) => h.fake.user.updateEvent(id, { [Events.DTSTART]: utc('2026-10-05T14:00:00Z') }));
    expect(Object.keys(patch.recurrenceOverrides as object).sort()).toEqual(['2026-10-07T10:00:00', '2026-10-12T10:00:00']);
    expect(after.exceptions.map((x) => [x.syncId, x.cells[Events.ORIGINAL_INSTANCE_TIME]])).toEqual([
      [`${ACCT}/bl#2026-10-07T10:00:00`, utc('2026-10-07T14:00:00Z')],
    ]);
  });

  it('drops the exception rows of overrides a "this and following" cut pruned', async () => {
    const event = weekly();
    event.recurrenceRule = { frequency: 'weekly', byDay: [{ day: 'mo' }, { day: 'we' }] };
    event.recurrenceOverrides = { '2026-10-07T09:00:00': { title: 'Early' }, '2026-10-21T09:00:00': { title: 'Late' } };
    const { after } = await roundTrip(event, (h, id) => h.fake.user.updateEvent(id, { [Events.RRULE]: 'FREQ=WEEKLY;UNTIL=20261019T125959Z;BYDAY=MO,WE' }));
    expect(after.exceptions.map((x) => x.recurrenceId)).toEqual(['2026-10-07T09:00:00']);
  });
});
