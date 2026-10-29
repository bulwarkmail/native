import { describe, expect, it } from 'vitest';
import { Events } from '../../android-columns';
import { calendarPlanner } from '../../calendar/planner';
import type { CalendarEventWire } from '../../wire';
import { ACCT, Harness, single, utc, weekly } from './harness';

async function synced(event: CalendarEventWire) {
  const h = await new Harness().setup();
  await h.download(event);
  return { h, id: Number(h.masterRow(event.id)._id) };
}

describe('calendar planner: edge cases', () => {
  it('undoes a deletion in a read-only calendar by purging and refetching', async () => {
    const { h, id } = await synced(single({ calendarIds: { r: true } }));
    h.fake.user.deleteEvent(id);
    const plan = calendarPlanner.planUpload((await h.local('e1'))!, h.ctx);
    expect(plan).toMatchObject({ kind: 'revert', refetch: true, reason: 'readOnly' });
    if (plan.kind === 'revert') await h.apply(plan.ops);
    expect(await h.events()).toEqual([]);
  });

  it('treats an instance Stalwart holds without its series as read-only', async () => {
    const { h, id } = await synced(single({ recurrenceId: '2026-10-06T12:00:00', recurrenceIdTimeZone: 'Europe/Berlin' }));
    h.fake.user.updateEvent(id, { [Events.TITLE]: 'Mine' });
    const plan = calendarPlanner.planUpload((await h.local('e1'))!, h.ctx);
    expect(plan).toMatchObject({ kind: 'revert', reason: 'instanceOnly' });
    if (plan.kind === 'revert') await h.apply(plan.ops);
    expect(h.row(id)).toMatchObject({ [Events.TITLE]: 'Lunch', [Events.DIRTY]: 0 });
  });

  it('pairs Etar\'s move of a series with its copied exceptions and adopts them', async () => {
    const { h, id } = await synced(weekly());
    h.fake.user.deleteEvent(id);
    const fresh = h.fake.user.insertEvent(h.rowIds.get('w')!, {
      [Events.TITLE]: 'Probe weekly', [Events.DESCRIPTION]: 'desc', [Events.EVENT_LOCATION]: 'Room 1', [Events.DTSTART]: utc('2026-10-05T13:00:00Z'),
      [Events.DURATION]: 'P5400S', [Events.RRULE]: 'FREQ=WEEKLY;COUNT=10;BYDAY=MO,WE', [Events.EVENT_TIMEZONE]: 'America/New_York',
      [Events.STATUS]: 0, [Events.AVAILABILITY]: 1, [Events.ACCESS_LEVEL]: 2, [Events.EVENT_COLOR]: h.row(id)[Events.EVENT_COLOR],
    });
    for (const a of h.fake.rows('attendees', 'event_id = ?', [id])) {
      h.fake.table('attendees').set(h.fake.allocId(), { ...a, _id: null, event_id: fresh });
    }
    // Etar copies the exception too (API 30+).
    h.fake.user.insertException(fresh, utc('2026-10-07T13:00:00Z'), { [Events.TITLE]: 'Moved Wednesday', [Events.DTSTART]: utc('2026-10-07T15:00:00Z'), [Events.DTEND]: utc('2026-10-07T16:30:00Z') });
    const events = await h.events();
    const pairs = calendarPlanner.planPairs(events.filter((e) => e.deleted), events.filter((e) => !e.syncId && !e.deleted), h.ctx);
    expect(pairs.map((p) => p.actions)).toEqual([[{ kind: 'update', id: 'bl', patch: { 'calendarIds/b': null, 'calendarIds/w': true } }]]);
    await h.apply(pairs[0].ops);
    const after = (await h.local('bl'))!;
    expect(after.eventId).toBe(fresh);
    expect(after.exceptions.map((x) => [x.syncId, x.dirty])).toEqual([[`${ACCT}/bl#2026-10-07T09:00:00`, false]]);
    // The old row and its own exception are gone.
    expect((await h.events()).map((e) => e.eventId)).toEqual([fresh]);
  });

  it('compares descriptions over 1 KB by hash and uploads them only when edited', async () => {
    const long = 'Lorem ipsum '.repeat(200);
    const { h, id } = await synced(single({ description: long }));
    const local = (await h.local('e1'))!;
    expect(String(local.baseline!.cells[Events.DESCRIPTION])).toMatch(/^sha256:[0-9a-f]{64}$/);
    h.fake.user.updateEvent(id, {});
    expect(calendarPlanner.planUpload((await h.local('e1'))!, h.ctx).kind).toBe('clean');
    h.fake.user.updateEvent(id, { [Events.DESCRIPTION]: `${long}!` });
    const plan = calendarPlanner.planUpload((await h.local('e1'))!, h.ctx);
    expect(plan.kind === 'upload' && plan.actions[0].kind === 'update' && plan.actions[0].patch).toEqual({ description: `${long}!` });
  });

  it('writes nothing into a split clone on download: it is a new event', async () => {
    const event = single({ recurrenceRule: { frequency: 'daily' } });
    const { h, id } = await synced(event);
    const clone = h.fake.user.splitViaUri(id, utc('2026-10-10T10:00:00Z'), '20261010T095959Z', {});
    const cloneEvent = (await h.events()).find((e) => e.eventId === clone)!;
    expect(calendarPlanner.planDownload({ ...event, title: 'x' }, cloneEvent, h.ctx)).toMatchObject({ effect: 'none', stillDirty: true });
  });

  it('keeps an exception row an app left without a description or attendees inheriting them', async () => {
    const { h, id } = await synced(weekly());
    h.fake.user.insertException(id, utc('2026-10-14T13:00:00Z'), { [Events.DTSTART]: utc('2026-10-14T13:00:00Z'), [Events.DTEND]: utc('2026-10-14T14:30:00Z'), [Events.EVENT_LOCATION]: null });
    const plan = calendarPlanner.planUpload((await h.local('bl'))!, h.ctx);
    if (plan.kind !== 'upload' || plan.actions[0].kind !== 'update') throw new Error();
    const override = plan.actions[0].patch['recurrenceOverrides/2026-10-14T09:00:00'] as Record<string, unknown>;
    // The series' description, location and attendees stay on the instance.
    expect(override).toMatchObject({ description: 'desc', locations: weekly().locations, participants: weekly().participants });
  });
});
