import { describe, expect, it } from 'vitest';
import { Attendees, Events, Reminders } from '../../android-columns';
import { calendarPlanner } from '../../calendar/planner';
import type { LocalEvent, UploadPlan } from '../../planner';
import type { CalendarEventWire } from '../../wire';
import { ACCT, Harness, ME, serverApply, single, utc, weekly } from './harness';

type Plan = UploadPlan<CalendarEventWire>;

async function synced(event: CalendarEventWire, options = {}) {
  const h = await new Harness(options).setup();
  await h.download(event);
  return { h, id: Number(h.masterRow(event.id)._id) };
}

function actionsOf(plan: Plan) {
  if (plan.kind !== 'upload') throw new Error(`expected an upload, got ${JSON.stringify(plan)}`);
  return plan.actions;
}

/** Claims a new row, then returns its create action. */
async function claimAndCreate(h: Harness, eventId: number) {
  const claim = calendarPlanner.planUpload(await h.byRow(eventId), h.ctx);
  expect(claim.kind).toBe('claim');
  if (claim.kind === 'claim') await h.apply(claim.ops);
  const local = await h.byRow(eventId);
  const [create] = actionsOf(calendarPlanner.planUpload(local, h.ctx));
  if (create.kind !== 'create') throw new Error('not a create');
  return { local, create };
}

describe('calendar planner: new events', () => {
  it('claims, creates and adopts a device event without writing anything on its echo', async () => {
    const h = await new Harness().setup();
    const id = h.fake.user.insertEvent(
      h.rowIds.get('b')!,
      { [Events.TITLE]: 'Dentist', [Events.DTSTART]: utc('2026-10-09T08:00:00Z'), [Events.DTEND]: utc('2026-10-09T09:00:00Z'), [Events.EVENT_TIMEZONE]: 'Europe/Berlin', [Events.EVENT_LOCATION]: 'Main St 1', [Events.STATUS]: 1, [Events.ACCESS_LEVEL]: 2, [Events.AVAILABILITY]: 0 },
      { reminders: [{ [Reminders.MINUTES]: 30, [Reminders.METHOD]: 1 }] },
    );
    const { local, create } = await claimAndCreate(h, id);
    expect(local.syncId).toBe(`~pending/${create.uid}`);
    expect(create).toMatchObject({ collectionId: 'b', uid: local.pending!.uid });
    expect(create.sendSchedulingMessages).toBeUndefined();
    const object = create.object as Record<string, unknown>;
    expect(object).toMatchObject({
      '@type': 'Event',
      uid: create.uid,
      calendarIds: { b: true },
      title: 'Dentist',
      start: '2026-10-09T10:00:00',
      duration: 'PT1H',
      timeZone: 'Europe/Berlin',
      status: 'confirmed',
      freeBusyStatus: 'busy',
      privacy: 'private',
    });
    expect(Object.values(object.locations as object)).toEqual([{ '@type': 'Location', name: 'Main St 1' }]);
    expect(Object.values(object.alerts as object)).toEqual([{ '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT30M', relativeTo: 'start' }, action: 'display' }]);

    // The server stores it; the engine re-fetches it and applies the accepted plan.
    const server = { ...(object as CalendarEventWire), id: 'n1', updated: '2026-09-27T12:00:00Z' } as CalendarEventWire;
    const accepted = calendarPlanner.planAccepted(local, server, h.ctx);
    await h.apply(accepted.ops);
    const after = (await h.local('n1'))!;
    expect(after).toMatchObject({ syncId: `${ACCT}/n1`, dirty: false, pending: null });
    expect(after.cells[Events.UID_2445]).toBe(create.uid);
    expect(calendarPlanner.planDownload(server, after, h.ctx).effect).toBe('none');
  });

  it('creates a new series with the exceptions and exclusions made before its upload', async () => {
    const h = await new Harness().setup();
    const id = h.fake.user.insertEvent(h.rowIds.get('b')!, {
      [Events.TITLE]: 'Standup',
      [Events.DTSTART]: utc('2026-10-05T07:00:00Z'),
      [Events.DURATION]: 'P900S',
      [Events.RRULE]: 'FREQ=DAILY;COUNT=5',
      [Events.EVENT_TIMEZONE]: 'Europe/Berlin',
      [Events.STATUS]: 1,
    });
    // Claimed first (the pending _SYNC_ID lets Etar offer "this event").
    const claim = calendarPlanner.planUpload(await h.byRow(id), h.ctx);
    if (claim.kind === 'claim') await h.apply(claim.ops);
    h.fake.user.insertException(id, utc('2026-10-06T07:00:00Z'), { [Events.TITLE]: 'Standup (late)', [Events.DTSTART]: utc('2026-10-06T08:00:00Z'), [Events.DTEND]: utc('2026-10-06T08:15:00Z') });
    h.fake.user.cancelInstance(id, utc('2026-10-07T07:00:00Z'), utc('2026-10-07T07:15:00Z'));
    const local = await h.byRow(id);
    expect(local.exceptions).toHaveLength(2);
    const [create] = actionsOf(calendarPlanner.planUpload(local, h.ctx));
    if (create.kind !== 'create') throw new Error('not a create');
    expect(create.object.recurrenceRule).toEqual({ frequency: 'daily', count: 5 });
    expect(create.object.recurrenceOverrides).toEqual({
      // The series' details a new override needs come along (withNewOverrideDetails).
      '2026-10-06T09:00:00': { title: 'Standup (late)', start: '2026-10-06T10:00:00', duration: 'PT15M', status: 'confirmed', freeBusyStatus: 'busy' },
      '2026-10-07T09:00:00': { excluded: true },
    });
    const server = { ...(create.object as CalendarEventWire), id: 's1' } as CalendarEventWire;
    await h.apply(calendarPlanner.planAccepted(local, server, h.ctx).ops);
    const after = (await h.local('s1'))!;
    expect(after.exceptions.map((x) => [x.syncId, x.dirty])).toEqual([[`${ACCT}/s1#2026-10-06T09:00:00`, false]]);
    expect(h.masterRow('s1')[Events.EXDATE]).toBe('20261007T070000Z');
    expect(calendarPlanner.planDownload(server, after, h.ctx).effect).toBe('none');
  });

  it('creates an event an app left without a status (Google Calendar) without making it tentative', async () => {
    const h = await new Harness().setup();
    // CalendarProvider has no default for STATUS: an app that does not write it leaves it NULL.
    const id = h.fake.user.insertEvent(h.rowIds.get('b')!, {
      [Events.TITLE]: 'From Google Calendar', [Events.DTSTART]: utc('2026-10-14T15:00:00Z'), [Events.DTEND]: utc('2026-10-14T16:00:00Z'), [Events.EVENT_TIMEZONE]: 'Europe/Berlin', [Events.STATUS]: null,
    });
    const { local, create } = await claimAndCreate(h, id);
    expect(create.object).not.toHaveProperty('status');
    const server = { ...(create.object as CalendarEventWire), id: 'g1' } as CalendarEventWire;
    await h.apply(calendarPlanner.planAccepted(local, server, h.ctx).ops);
    // Written as JSCalendar's default, confirmed.
    expect(h.row(id)).toMatchObject({ [Events.STATUS]: 1, [Events.DIRTY]: 0 });
    expect(calendarPlanner.planDownload(server, (await h.local('g1'))!, h.ctx).effect).toBe('none');
  });

  it('leaves out exclusions a new series inherited from before its start (Etar\'s split copies the EXDATE)', async () => {
    const h = await new Harness().setup();
    const id = h.fake.user.insertEvent(h.rowIds.get('b')!, {
      [Events.TITLE]: 'Weekly (new time)',
      [Events.DTSTART]: utc('2026-11-16T09:00:00Z'),
      [Events.DURATION]: 'P3600S',
      [Events.RRULE]: 'FREQ=WEEKLY;COUNT=3;BYDAY=MO',
      [Events.EVENT_TIMEZONE]: 'Europe/Berlin',
      // The old series' exclusions (Oct 12, Nov 2) and one of this series (Nov 23).
      [Events.EXDATE]: '20261012T060000Z,20261102T070000Z,20261123T090000Z',
      [Events.STATUS]: 1,
    });
    const { create } = await claimAndCreate(h, id);
    expect(create.object.recurrenceOverrides).toEqual({ '2026-11-23T10:00:00': { excluded: true } });
  });

  it('invites the attendees of a new event as its organizer', async () => {
    const h = await new Harness().setup();
    const id = h.fake.user.insertEvent(
      h.rowIds.get('b')!,
      { [Events.TITLE]: 'Review', [Events.DTSTART]: utc('2026-10-09T08:00:00Z'), [Events.DTEND]: utc('2026-10-09T09:00:00Z'), [Events.EVENT_TIMEZONE]: 'Europe/Berlin', [Events.STATUS]: 1 },
      {
        attendees: [
          { [Attendees.ATTENDEE_EMAIL]: ME, [Attendees.ATTENDEE_RELATIONSHIP]: 2, [Attendees.ATTENDEE_TYPE]: 1, [Attendees.ATTENDEE_STATUS]: 1 },
          { [Attendees.ATTENDEE_EMAIL]: 'guest@example.net', [Attendees.ATTENDEE_NAME]: 'Guest', [Attendees.ATTENDEE_RELATIONSHIP]: 1, [Attendees.ATTENDEE_TYPE]: 1, [Attendees.ATTENDEE_STATUS]: 3 },
        ],
      },
    );
    const { create } = await claimAndCreate(h, id);
    expect(create.sendSchedulingMessages).toBe(true);
    const participants = Object.values(create.object.participants ?? {});
    expect(participants).toEqual([
      { '@type': 'Participant', calendarAddress: `mailto:${ME}`, roles: { owner: true, attendee: true }, participationStatus: 'accepted' },
      { '@type': 'Participant', calendarAddress: 'mailto:guest@example.net', name: 'Guest', roles: { attendee: true }, participationStatus: 'needs-action', expectReply: true },
    ]);
    expect(create.object.organizerCalendarAddress).toBe(`mailto:${ME}`);
  });

  it('gives a new event carrying another row\'s uid a fresh one', async () => {
    const { h } = await synced(single());
    const copy = h.fake.user.insertEvent(h.rowIds.get('b')!, {
      [Events.TITLE]: 'Copy', [Events.DTSTART]: utc('2026-10-09T08:00:00Z'), [Events.DTEND]: utc('2026-10-09T09:00:00Z'), [Events.EVENT_TIMEZONE]: 'UTC', [Events.UID_2445]: 'single-1@example.org', [Events.STATUS]: 1,
    });
    const local = await h.byRow(copy);
    expect(local.split).toBe('clone');
    const { create } = await claimAndCreate(h, copy);
    expect(create.uid).not.toBe('single-1@example.org');
    // A uid nobody else carries is kept (an imported invitation keeps its UID).
    const own = h.fake.user.insertEvent(h.rowIds.get('b')!, {
      [Events.TITLE]: 'Imported', [Events.DTSTART]: utc('2026-10-09T08:00:00Z'), [Events.DTEND]: utc('2026-10-09T09:00:00Z'), [Events.EVENT_TIMEZONE]: 'UTC', [Events.UID_2445]: 'ics-uid@example.net', [Events.STATUS]: 1,
    });
    expect((await claimAndCreate(h, own)).create.uid).toBe('ics-uid@example.net');
  });

  it('adopts its own create found by uid on download, keeping later local edits', async () => {
    const h = await new Harness().setup();
    const id = h.fake.user.insertEvent(h.rowIds.get('b')!, { [Events.TITLE]: 'Draft', [Events.DTSTART]: utc('2026-10-09T08:00:00Z'), [Events.DTEND]: utc('2026-10-09T09:00:00Z'), [Events.EVENT_TIMEZONE]: 'Europe/Berlin', [Events.STATUS]: 1 });
    const { create } = await claimAndCreate(h, id);
    // The create reached the server, but the response was lost; meanwhile the user renamed it.
    h.fake.user.updateEvent(id, { [Events.TITLE]: 'Final' });
    const server = { ...(create.object as CalendarEventWire), id: 'n7' } as CalendarEventWire;
    const plan = calendarPlanner.planDownload(server, await h.byRow(id), h.ctx);
    expect(plan).toMatchObject({ effect: 'update', stillDirty: true, conflicts: 0 });
    await h.apply(plan.ops);
    const adopted = (await h.local('n7'))!;
    expect(adopted).toMatchObject({ eventId: id, dirty: true, pending: null });
    const [update] = actionsOf(calendarPlanner.planUpload(adopted, h.ctx));
    expect(update).toMatchObject({ kind: 'update', id: 'n7', patch: { title: 'Final' } });
  });

  it('removes a new event created in a read-only calendar', async () => {
    const h = await new Harness().setup();
    const id = h.fake.user.insertEvent(h.rowIds.get('r')!, { [Events.TITLE]: 'x', [Events.DTSTART]: 0, [Events.DTEND]: 1000, [Events.EVENT_TIMEZONE]: 'UTC', [Events.STATUS]: 1 });
    const plan = calendarPlanner.planUpload(await h.byRow(id), h.ctx);
    expect(plan).toMatchObject({ kind: 'revert', reason: 'readOnly' });
    if (plan.kind === 'revert') await h.apply(plan.ops);
    expect(h.row(id)).toBeUndefined();
  });
});

describe('calendar planner: accepted uploads, merges and deletions', () => {
  it('keeps a row edited again during its upload dirty, with the uploaded value as its baseline', async () => {
    const { h, id } = await synced(single());
    h.fake.user.updateEvent(id, { [Events.TITLE]: 'First' });
    const local = (await h.local('e1'))!;
    const [update] = actionsOf(calendarPlanner.planUpload(local, h.ctx));
    if (update.kind !== 'update') throw new Error();
    const server = serverApply(single(), update.patch);
    const accepted = calendarPlanner.planAccepted(local, server, h.ctx);
    // The user edits again before the clearing batch: its assert fails.
    h.fake.beforeNextBatch(() => h.fake.user.updateEvent(id, { [Events.TITLE]: 'Second' }));
    expect((await h.tryApply(accepted.ops)).ok).toBe(false);
    await h.apply(accepted.keepDirtyOps);
    const after = (await h.local('e1'))!;
    expect(after).toMatchObject({ dirty: true });
    expect(after.cells[Events.TITLE]).toBe('Second');
    expect(after.shadow?.title).toBe('First');
    const [next] = actionsOf(calendarPlanner.planUpload(after, h.ctx));
    expect(next).toMatchObject({ patch: { title: 'Second' } });
    // A revert to the old value uploads too.
    h.fake.user.updateEvent(id, { [Events.TITLE]: 'Lunch' });
    expect(actionsOf(calendarPlanner.planUpload((await h.local('e1'))!, h.ctx))[0]).toMatchObject({ patch: { title: 'Lunch' } });
  });

  it('purges a cancelled instance whose exclusion was uploaded even when the series was edited meanwhile', async () => {
    const { h, id } = await synced(weekly());
    const cancelled = h.fake.user.cancelInstance(id, utc('2026-10-19T13:00:00Z'), utc('2026-10-19T14:30:00Z'));
    const local = (await h.local('bl'))!;
    const [update] = actionsOf(calendarPlanner.planUpload(local, h.ctx));
    if (update.kind !== 'update') throw new Error();
    const server = serverApply(weekly(), update.patch);
    const accepted = calendarPlanner.planAccepted(local, server, h.ctx);
    h.fake.beforeNextBatch(() => h.fake.user.updateEvent(id, { [Events.TITLE]: 'Edited meanwhile' }));
    expect((await h.tryApply(accepted.ops)).ok).toBe(false);
    await h.apply(accepted.keepDirtyOps);
    expect(h.row(cancelled)).toBeUndefined();
    const after = (await h.local('bl'))!;
    const [next] = actionsOf(calendarPlanner.planUpload(after, h.ctx));
    // Only the newer edit: the exclusion is on the server already and stays one.
    expect(next).toMatchObject({ kind: 'update', patch: { title: 'Edited meanwhile' } });
  });

  it('fails a download write when the user edits the event meanwhile', async () => {
    const { h, id } = await synced(weekly());
    const plan = calendarPlanner.planDownload({ ...weekly(), title: 'Server' }, await h.local('bl'), h.ctx);
    h.fake.beforeNextBatch(() => h.fake.user.updateEvent(id, { [Events.DESCRIPTION]: 'mine' }));
    const result = await h.tryApply(plan.ops);
    expect(result).toMatchObject({ ok: false, reason: 'assert' });
    expect(h.row(id)[Events.TITLE]).toBe('Probe weekly');
  });

  it('merges per unit: local and server changes to different fields both survive', async () => {
    const { h, id } = await synced(weekly());
    h.fake.user.updateEvent(id, { [Events.TITLE]: 'Local title' });
    const plan = await h.download({ ...weekly(), description: 'Server description' });
    expect(plan).toMatchObject({ conflicts: 0, stillDirty: true });
    expect(h.row(id)).toMatchObject({ [Events.TITLE]: 'Local title', [Events.DESCRIPTION]: 'Server description', [Events.DIRTY]: 1 });
    expect(actionsOf(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx))[0]).toMatchObject({ patch: { title: 'Local title' } });
  });

  it('lets the server win a real conflict and counts it', async () => {
    const { h, id } = await synced(weekly());
    h.fake.user.updateEvent(id, { [Events.TITLE]: 'Local title' });
    const plan = await h.download({ ...weekly(), title: 'Server title' });
    expect(plan).toMatchObject({ conflicts: 1, stillDirty: false });
    expect(h.row(id)).toMatchObject({ [Events.TITLE]: 'Server title', [Events.DIRTY]: 0 });
  });

  it('never reads a status an app left NULL as an edit, in uploads or merges', async () => {
    const { h, id } = await synced(weekly());
    expect(h.row(id)[Events.STATUS]).toBe(0);
    // A row an app wrote without STATUS (only an insert can leave it NULL), then edited.
    h.fake.table('events').get(id)![Events.STATUS] = null;
    h.fake.user.updateEvent(id, { [Events.TITLE]: 'Renamed' });
    expect(actionsOf(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx))[0]).toMatchObject({ kind: 'update', patch: { title: 'Renamed' } });
    expect(Object.keys((actionsOf(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx))[0] as { patch: object }).patch)).toEqual(['title']);
    // The server's status change meanwhile is no conflict: the row takes it, the title stays for the upload.
    const plan = await h.download({ ...weekly(), status: 'cancelled' });
    expect(plan).toMatchObject({ conflicts: 0, stillDirty: true });
    expect(h.row(id)).toMatchObject({ [Events.STATUS]: 2, [Events.TITLE]: 'Renamed', [Events.DIRTY]: 1 });
  });

  it('treats the same change on both sides as converged', async () => {
    const { h, id } = await synced(weekly());
    h.fake.user.updateEvent(id, { [Events.TITLE]: 'Same' });
    const plan = await h.download({ ...weekly(), title: 'Same' });
    expect(plan).toMatchObject({ conflicts: 0, stillDirty: false });
    expect(h.row(id)[Events.DIRTY]).toBe(0);
  });

  it('merges attendees by address and keeps the user\'s RSVP', async () => {
    const invite = single({
      organizerCalendarAddress: 'mailto:boss@example.net',
      participants: {
        boss: { calendarAddress: 'mailto:boss@example.net', roles: { owner: true } },
        me: { calendarAddress: 'mailto:usera@example.org', roles: { attendee: true }, participationStatus: 'needs-action' },
      },
    } as Partial<CalendarEventWire>);
    const { h, id } = await synced(invite);
    h.fake.user.setAttendeeStatus(id, ME, 1);
    const remote = { ...invite, participants: { ...invite.participants, new: { calendarAddress: 'mailto:new@example.net', roles: { attendee: true } } } } as CalendarEventWire;
    const plan = await h.download(remote);
    expect(plan).toMatchObject({ conflicts: 0, stillDirty: true });
    const rows = h.fake.rows('attendees', `${Attendees.EVENT_ID} = ?`, [id]);
    expect(rows.map((a) => [a[Attendees.ATTENDEE_EMAIL], a[Attendees.ATTENDEE_STATUS]])).toEqual([
      ['boss@example.net', 3],
      [ME, 1],
      ['new@example.net', 3],
    ]);
    expect(actionsOf(calendarPlanner.planUpload((await h.local('e1'))!, h.ctx))[0]).toMatchObject({
      patch: { 'participants/me/participationStatus': 'accepted' },
      sendSchedulingMessages: true,
    });
  });

  it('destroys an event deleted on the device, with a CANCEL when others take part', async () => {
    const { h, id } = await synced(weekly());
    h.fake.user.deleteEvent(id);
    expect(actionsOf(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx))).toEqual([
      { kind: 'destroy', id: 'bl', uid: 'probe-rec@example.org', sendSchedulingMessages: true },
    ]);
    // Its exceptions go with it.
    const local = (await h.local('bl'))!;
    const group = calendarPlanner.planLocalDelete(local);
    await h.apply(group);
    expect(await h.events()).toEqual([]);
  });

  it('removes only the synced membership of an event that is in several calendars', async () => {
    const h = await new Harness().setup(['b', 'w', 'r']);
    const isSelected = h.ctx.isSelected;
    h.ctx = { ...h.ctx, isSelected: (key) => key !== `${ACCT}/x` && isSelected(key) };
    await h.download(single({ calendarIds: { b: true, x: true } }));
    h.fake.user.deleteEvent(Number(h.masterRow('e1')._id));
    expect(actionsOf(calendarPlanner.planUpload((await h.local('e1'))!, h.ctx))).toEqual([{ kind: 'update', id: 'e1', patch: { 'calendarIds/b': null } }]);
    // The server keeps it elsewhere: the rows go.
    const accepted = calendarPlanner.planAccepted((await h.local('e1'))!, single({ calendarIds: { x: true } }), h.ctx);
    await h.apply(accepted.ops);
    expect(await h.events()).toEqual([]);
  });

  it('leaves an event the server moved out of every synced calendar before the deletion reached it, and only purges the rows', async () => {
    const { h, id } = await synced(single());
    const isSelected = h.ctx.isSelected;
    h.ctx = { ...h.ctx, isSelected: (key) => key !== `${ACCT}/x` && isSelected(key) };
    h.fake.user.deleteEvent(id);
    // The shadow follows the server although no synced calendar holds the event now.
    expect(await h.download(single({ calendarIds: { x: true } }))).toMatchObject({ stillDirty: true, effect: 'update' });
    expect(h.row(id)).toMatchObject({ [Events.DELETED]: 1 });

    const plan = calendarPlanner.planUpload((await h.local('e1'))!, h.ctx);
    expect(plan.kind).toBe('purge');
    if (plan.kind === 'purge') await h.apply(plan.ops);
    expect(await h.events()).toEqual([]);
  });

  it('still destroys an event the server moved to another synced calendar, or whose calendar was deselected before the upload', async () => {
    const destroy = [{ kind: 'destroy', id: 'e1', uid: 'single-1@example.org' }];
    const moved = await synced(single());
    moved.h.fake.user.deleteEvent(moved.id);
    await moved.h.download(single({ calendarIds: { w: true } }));
    expect(actionsOf(calendarPlanner.planUpload((await moved.h.local('e1'))!, moved.h.ctx))).toEqual(destroy);

    const deselected = await synced(single());
    deselected.h.fake.user.deleteEvent(deselected.id);
    deselected.h.ctx = { ...deselected.h.ctx, isSelected: () => false };
    expect(actionsOf(calendarPlanner.planUpload((await deselected.h.local('e1'))!, deselected.h.ctx))).toEqual(destroy);
  });

  it('destroys a deleted event whose create had an unknown outcome by its uid', async () => {
    const h = await new Harness().setup();
    const id = h.fake.user.insertEvent(h.rowIds.get('b')!, { [Events.TITLE]: 'x', [Events.DTSTART]: 0, [Events.DTEND]: 1000, [Events.EVENT_TIMEZONE]: 'UTC', [Events.STATUS]: 1 });
    const { local } = await claimAndCreate(h, id);
    h.fake.user.deleteEvent(id);
    // With the pending _SYNC_ID the app delete was a soft delete the engine can act on.
    expect(h.row(id)).toMatchObject({ [Events.DELETED]: 1 });
    expect(actionsOf(calendarPlanner.planUpload(await h.byRow(id), h.ctx))).toEqual([{ kind: 'destroy', id: null, uid: local.pending!.uid }]);
  });

  it('keeps a device deletion when the server edited the event meanwhile', async () => {
    const { h, id } = await synced(single());
    h.fake.user.deleteEvent(id);
    const plan = await h.download(single({ title: 'Server edit' }));
    expect(plan).toMatchObject({ stillDirty: true, effect: 'update', writes: 1 });
    expect(h.row(id)).toMatchObject({ [Events.DELETED]: 1, [Events.TITLE]: 'Lunch' });
    expect(actionsOf(calendarPlanner.planUpload((await h.local('e1'))!, h.ctx))[0].kind).toBe('destroy');
  });

  it('purges an exception row whose master is gone instead of uploading it', async () => {
    const { h } = await synced(weekly());
    const local = (await h.local('bl'))!;
    await h.apply({ ref: 'x', ops: [{ op: 'delete', table: 'events', id: local.eventId, expectCount: 1 }] });
    const [orphan] = await h.events();
    expect(orphan.cells[Events.ORIGINAL_SYNC_ID]).toBe(`${ACCT}/bl`);
    const plan = calendarPlanner.planUpload(orphan, h.ctx);
    expect(plan.kind).toBe('purge');
    if (plan.kind === 'purge') await h.apply(plan.ops);
    expect(await h.events()).toEqual([]);
  });

  it('refuses tasks everywhere', async () => {
    const { h } = await synced(single());
    const local = (await h.local('e1'))!;
    const task = { ...single(), '@type': 'Task' } as CalendarEventWire;
    expect(() => calendarPlanner.planAccepted(local, task, h.ctx)).toThrow(/tasks/);
    expect(() => calendarPlanner.planUpload({ ...local, shadow: task }, h.ctx)).toThrow(/tasks/);
  });
});

describe('calendar planner: pairs', () => {
  it('uploads Etar\'s move to another calendar (delete + insert) as a calendarIds swap', async () => {
    const { h, id } = await synced(single());
    h.fake.user.deleteEvent(id);
    const moved = h.fake.user.insertEvent(h.rowIds.get('w')!, {
      [Events.TITLE]: 'Lunch', [Events.DTSTART]: utc('2026-10-06T10:00:00Z'), [Events.DTEND]: utc('2026-10-06T11:00:00Z'), [Events.EVENT_TIMEZONE]: 'Europe/Berlin', [Events.STATUS]: 1, [Events.AVAILABILITY]: 0, [Events.ACCESS_LEVEL]: 0,
    });
    const events = await h.events();
    const pairs = calendarPlanner.planPairs(events.filter((e) => e.deleted), events.filter((e) => !e.syncId), h.ctx);
    expect(pairs).toHaveLength(1);
    expect(pairs[0].actions).toEqual([{ kind: 'update', id: 'e1', patch: { 'calendarIds/b': null, 'calendarIds/w': true } }]);
    await h.apply(pairs[0].ops);
    const after = await h.events();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ eventId: moved, syncId: `${ACCT}/e1`, dirty: false });
    expect(after[0].shadow?.calendarIds).toEqual({ w: true });
    // The server's echo writes nothing.
    expect(calendarPlanner.planDownload(single({ calendarIds: { w: true } }), after[0], h.ctx).effect).toBe('none');
  });

  it('uploads a series turned into a single event by delete + insert as a rule removal', async () => {
    const { h, id } = await synced(single({ recurrenceRule: { frequency: 'daily' } }));
    h.fake.user.deleteEvent(id);
    h.fake.user.insertEvent(h.rowIds.get('b')!, {
      [Events.TITLE]: 'Lunch', [Events.DTSTART]: utc('2026-10-06T10:00:00Z'), [Events.DTEND]: utc('2026-10-06T11:00:00Z'), [Events.EVENT_TIMEZONE]: 'Europe/Berlin', [Events.STATUS]: 1, [Events.AVAILABILITY]: 0, [Events.ACCESS_LEVEL]: 0,
    });
    const events = await h.events();
    const pairs = calendarPlanner.planPairs(events.filter((e) => e.deleted), events.filter((e) => !e.syncId), h.ctx);
    expect(pairs.map((p) => p.actions)).toEqual([[{ kind: 'update', id: 'e1', patch: { recurrenceRule: null } }]]);
  });

  it('pairs a copy an app inserted without a status (Google Calendar\'s "Copy to" + delete) with the original', async () => {
    const { h, id } = await synced(single());
    h.fake.user.deleteEvent(id);
    h.fake.user.insertEvent(h.rowIds.get('w')!, {
      [Events.TITLE]: 'Lunch', [Events.DTSTART]: utc('2026-10-06T10:00:00Z'), [Events.DTEND]: utc('2026-10-06T11:00:00Z'), [Events.EVENT_TIMEZONE]: 'Europe/Berlin', [Events.STATUS]: null, [Events.AVAILABILITY]: 0, [Events.ACCESS_LEVEL]: 0,
    });
    const events = await h.events();
    const pairs = calendarPlanner.planPairs(events.filter((e) => e.deleted), events.filter((e) => !e.syncId), h.ctx);
    expect(pairs.map((p) => p.actions)).toEqual([[{ kind: 'update', id: 'e1', patch: { 'calendarIds/b': null, 'calendarIds/w': true } }]]);
  });

  it('does not pair unrelated rows', async () => {
    const { h, id } = await synced(single());
    h.fake.user.deleteEvent(id);
    h.fake.user.insertEvent(h.rowIds.get('w')!, { [Events.TITLE]: 'Something else', [Events.DTSTART]: utc('2026-10-06T10:00:00Z'), [Events.DTEND]: utc('2026-10-06T11:00:00Z'), [Events.EVENT_TIMEZONE]: 'Europe/Berlin', [Events.STATUS]: 1 });
    const events = await h.events();
    expect(calendarPlanner.planPairs(events.filter((e) => e.deleted), events.filter((e) => !e.syncId), h.ctx)).toEqual([]);
  });

  /** Etar's move of `single()` (delete + insert into Work), with `extra` columns and children on the new row. */
  const lunchColumns = {
    [Events.TITLE]: 'Lunch', [Events.DTSTART]: utc('2026-10-06T10:00:00Z'), [Events.DTEND]: utc('2026-10-06T11:00:00Z'), [Events.EVENT_TIMEZONE]: 'Europe/Berlin', [Events.STATUS]: 1, [Events.AVAILABILITY]: 0, [Events.ACCESS_LEVEL]: 0,
  };
  async function pairAndApply(h: Harness) {
    const events = await h.events();
    const pairs = calendarPlanner.planPairs(events.filter((e) => e.deleted), events.filter((e) => !e.syncId && !e.deleted), h.ctx);
    expect(pairs).toHaveLength(1);
    await h.apply(pairs[0].ops);
    return pairs[0];
  }
  const alert15 = { al1: { '@type': 'Alert', trigger: { '@type': 'OffsetTrigger', offset: '-PT15M', relativeTo: 'start' }, action: 'display' } } as CalendarEventWire['alerts'];

  it('keeps a reminder saved with the move for the next upload instead of taking it as the baseline', async () => {
    const { h, id } = await synced(single({ alerts: alert15 }));
    h.fake.user.deleteEvent(id);
    const moved = h.fake.user.insertEvent(h.rowIds.get('w')!, lunchColumns, { reminders: [{ [Reminders.MINUTES]: 60, [Reminders.METHOD]: 1 }] });

    const pair = await pairAndApply(h);

    expect(pair.actions).toEqual([{ kind: 'update', id: 'e1', patch: { 'calendarIds/b': null, 'calendarIds/w': true } }]);
    const after = (await h.local('e1'))!;
    expect(after).toMatchObject({ eventId: moved, dirty: true });
    const [update] = actionsOf(calendarPlanner.planUpload(after, h.ctx));
    if (update.kind !== 'update') throw new Error('not an update');
    // Only the reminder is left to send: the move went up with the pair.
    expect(Object.keys(update.patch).every((k) => k.startsWith('alerts/'))).toBe(true);
    const alerts = serverApply(after.shadow!, update.patch).alerts!;
    expect(Object.values(alerts).map((a) => (a.trigger as { offset?: string }).offset)).toEqual(['-PT1H']);
  });

  it('uploads an edit made before the move, which the new row copied', async () => {
    const { h, id } = await synced(single({ description: 'Bring salad' }));
    h.fake.user.updateEvent(id, { [Events.DESCRIPTION]: 'Bring soup' });
    h.fake.user.deleteEvent(id);
    h.fake.user.insertEvent(h.rowIds.get('w')!, { ...lunchColumns, [Events.DESCRIPTION]: 'Bring soup' });

    await pairAndApply(h);

    const after = (await h.local('e1'))!;
    expect(after.dirty).toBe(true);
    expect(actionsOf(calendarPlanner.planUpload(after, h.ctx))).toEqual([{ kind: 'update', id: 'e1', patch: { description: 'Bring soup' } }]);
  });

  it('takes attendee rows an app re-inserted with constant details as they are, uploading nothing for them', async () => {
    const participants = {
      bob: { '@type': 'Participant', calendarAddress: 'mailto:bob@example.net', name: 'Bob', roles: { attendee: true, optional: true }, participationStatus: 'accepted' },
      carol: { '@type': 'Participant', calendarAddress: 'mailto:carol@example.net', name: 'Carol', roles: { attendee: true }, participationStatus: 'declined' },
    } as CalendarEventWire['participants'];
    const { h, id } = await synced(single({ participants, organizerCalendarAddress: 'mailto:boss@example.net' }));
    const attendees = h.fake.rows('attendees', `${Attendees.EVENT_ID} = ?`, [id]).map((a) => ({
      // Etar writes every attendee it re-inserts as a required attendee without a status.
      [Attendees.ATTENDEE_EMAIL]: a[Attendees.ATTENDEE_EMAIL], [Attendees.ATTENDEE_NAME]: a[Attendees.ATTENDEE_NAME],
      [Attendees.ATTENDEE_RELATIONSHIP]: 1, [Attendees.ATTENDEE_TYPE]: 1, [Attendees.ATTENDEE_STATUS]: 0,
    }));
    const organizer = h.row(id)[Events.ORGANIZER];
    h.fake.user.deleteEvent(id);
    h.fake.user.insertEvent(h.rowIds.get('w')!, { ...lunchColumns, [Events.ORGANIZER]: organizer }, { attendees });

    await pairAndApply(h);

    const after = (await h.local('e1'))!;
    expect(after.dirty).toBe(false);
    expect(calendarPlanner.planUpload({ ...after, dirty: true }, h.ctx).kind).toBe('clean');
  });

  describe("Etar's move of a meeting (its copy leaves the user's own row out, or adds the user as organizer)", () => {
    const emailsOf = (h: Harness, eventId: number) =>
      h.fake.rows('attendees', `${Attendees.EVENT_ID} = ?`, [eventId]).map((a) => String(a[Attendees.ATTENDEE_EMAIL])).sort();
    const person = (address: string, extra: Record<string, unknown> = {}) => ({ '@type': 'Participant', calendarAddress: `mailto:${address}`, roles: { attendee: true }, ...extra });
    const moveToWork = { kind: 'update', id: 'e1', patch: { 'calendarIds/b': null, 'calendarIds/w': true } };

    it('pairs a meeting that lists the user', async () => {
      const participants = {
        me: person(ME, { roles: { owner: true, attendee: true }, participationStatus: 'accepted' }),
        bob: person('bob@example.net', { name: 'Bob', participationStatus: 'accepted' }),
      } as CalendarEventWire['participants'];
      const { h, id } = await synced(single({ participants, organizerCalendarAddress: `mailto:${ME}` }));

      const moved = h.fake.user.etarMove(id, h.rowIds.get('w')!);

      expect(emailsOf(h, moved)).toEqual(['bob@example.net']);
      expect((await pairAndApply(h)).actions).toEqual([moveToWork]);
      expect((await h.local('e1'))!).toMatchObject({ eventId: moved, dirty: false });
    });

    it('pairs a meeting that does not list the user', async () => {
      const participants = {
        boss: person('boss@example.net', { roles: { owner: true, attendee: true }, participationStatus: 'accepted' }),
        bob: person('bob@example.net', { participationStatus: 'needs-action' }),
      } as CalendarEventWire['participants'];
      const { h, id } = await synced(single({ participants, organizerCalendarAddress: 'mailto:boss@example.net' }));

      const moved = h.fake.user.etarMove(id, h.rowIds.get('w')!);

      expect(emailsOf(h, moved)).toEqual(['bob@example.net', 'boss@example.net', ME]);
      expect((await pairAndApply(h)).actions).toEqual([moveToWork]);
    });

    it('never pairs a copy that lost or gained someone else', async () => {
      const participants = {
        me: person(ME, { roles: { owner: true, attendee: true }, participationStatus: 'accepted' }),
        bob: person('bob@example.net'),
        carol: person('carol@example.net'),
      } as CalendarEventWire['participants'];
      const attendee = (email: string) => ({ [Attendees.ATTENDEE_EMAIL]: email, [Attendees.ATTENDEE_RELATIONSHIP]: 1, [Attendees.ATTENDEE_TYPE]: 1, [Attendees.ATTENDEE_STATUS]: 0 });
      for (const copied of [['bob@example.net'], ['bob@example.net', 'carol@example.net', 'dave@example.net']]) {
        const { h, id } = await synced(single({ participants, organizerCalendarAddress: `mailto:${ME}` }));
        h.fake.user.deleteEvent(id);
        h.fake.user.insertEvent(h.rowIds.get('w')!, lunchColumns, { attendees: copied.map(attendee) });
        const events = await h.events();
        expect(calendarPlanner.planPairs(events.filter((e) => e.deleted), events.filter((e) => !e.syncId), h.ctx), copied.join()).toEqual([]);
      }
    });
  });

  it('keeps the timing of a series turned single against the series, so a start moved before uploads', async () => {
    const { h, id } = await synced(single({ recurrenceRule: { frequency: 'daily' } }));
    // Moved an hour later in place, then turned into a single event (Etar: delete + insert).
    h.fake.user.updateEvent(id, { [Events.DTSTART]: utc('2026-10-06T11:00:00Z') });
    h.fake.user.deleteEvent(id);
    h.fake.user.insertEvent(h.rowIds.get('b')!, { ...lunchColumns, [Events.DTSTART]: utc('2026-10-06T11:00:00Z'), [Events.DTEND]: utc('2026-10-06T12:00:00Z') });

    const pair = await pairAndApply(h);

    expect(pair.actions).toEqual([{ kind: 'update', id: 'e1', patch: { recurrenceRule: null } }]);
    const after = (await h.local('e1'))!;
    expect(after.dirty).toBe(true);
    expect(actionsOf(calendarPlanner.planUpload(after, h.ctx))).toEqual([{ kind: 'update', id: 'e1', patch: { start: '2026-10-06T13:00:00' } }]);

    // Without the earlier edit, the single event matches what the server holds after the pair: nothing left.
    const plain = await synced(single({ recurrenceRule: { frequency: 'daily' } }));
    plain.h.fake.user.deleteEvent(plain.id);
    plain.h.fake.user.insertEvent(plain.h.rowIds.get('b')!, lunchColumns);
    await pairAndApply(plain.h);
    expect((await plain.h.local('e1'))!.dirty).toBe(false);
  });
});

describe('calendar planner: baselines, zones and reminder owners', () => {
  it('heals a clean row\'s baseline after provider normalisation, but never a series\' timing or rule', async () => {
    const { h, id } = await synced(weekly());
    // Provider-side changes without DIRTY (as CONTENT_EXCEPTION_URI's split does to the rule).
    const row = h.fake.table('events').get(id)!;
    row[Events.ORGANIZER] = 'someone@example.net';
    row[Events.RRULE] = 'FREQ=WEEKLY;UNTIL=20261019T125959Z;BYDAY=MO,WE';
    const heal = calendarPlanner.planBaselineHeal((await h.local('bl'))!)!;
    expect(heal).not.toBeNull();
    await h.apply(heal);
    const baseline = (await h.local('bl'))!.baseline!;
    expect(baseline.cells[Events.ORGANIZER]).toBe('someone@example.net');
    expect(baseline.cells[Events.RRULE]).toBe('FREQ=WEEKLY;COUNT=10;BYDAY=MO,WE');
    expect(calendarPlanner.planBaselineHeal((await h.local('bl'))!)).toBeNull();
  });

  it('does not heal a row that turned dirty', async () => {
    const { h, id } = await synced(single());
    h.fake.user.updateEvent(id, { [Events.TITLE]: 'x' });
    expect(calendarPlanner.planBaselineHeal((await h.local('e1'))!)).toBeNull();
  });

  it('rewrites floating events for a new device zone, keeping their wall time', async () => {
    const { h, id } = await synced(single({ id: 'f', timeZone: null, start: '2026-10-06T14:00:00' }));
    expect(h.row(id)[Events.DTSTART]).toBe(utc('2026-10-06T12:00:00Z'));
    h.ctx = { ...h.ctx, deviceZone: 'America/New_York' };
    const group = calendarPlanner.planZoneChange((await h.local('f'))!, 'Europe/Berlin', h.ctx)!;
    await h.apply(group);
    expect(h.row(id)).toMatchObject({ [Events.DTSTART]: utc('2026-10-06T18:00:00Z'), [Events.EVENT_TIMEZONE]: 'America/New_York' });
    expect(calendarPlanner.planZoneChange((await h.local('f'))!, 'Europe/Berlin', h.ctx)).toBeNull();
    // Events with a zone are not floating.
    const t = await synced(single());
    expect(calendarPlanner.planZoneChange((await t.h.local('e1'))!, 'Europe/Berlin', { ...t.h.ctx, deviceZone: 'Asia/Tokyo' })).toBeNull();
  });

  it('rewrites Reminders rows when the reminder owner changes, without server writes', async () => {
    const { h, id } = await synced(weekly());
    expect(h.fake.rows('reminders', `${Reminders.EVENT_ID} = ?`, [id])).toHaveLength(1);
    h.ctx = { ...h.ctx, reminderOwner: 'bulwark' };
    await h.apply(calendarPlanner.planReminderOwnerChange((await h.local('bl'))!, h.ctx)!);
    expect(h.fake.rows('reminders', `${Reminders.EVENT_ID} = ?`, [id])).toHaveLength(0);
    expect(calendarPlanner.planReminderOwnerChange((await h.local('bl'))!, h.ctx)).toBeNull();
    h.ctx = { ...h.ctx, reminderOwner: 'device' };
    await h.apply(calendarPlanner.planReminderOwnerChange((await h.local('bl'))!, h.ctx)!);
    expect(h.fake.rows('reminders', `${Reminders.EVENT_ID} = ?`, [id]).map((r) => r[Reminders.MINUTES])).toEqual([15]);
    // Back with the calendar app: an echo download writes nothing.
    expect(calendarPlanner.planDownload(weekly(), await h.local('bl'), h.ctx).effect).toBe('none');
  });
});

describe('calendar planner: decoding', () => {
  it('tolerates garbage in sync columns and numbers read back as text', async () => {
    const [event] = calendarPlanner.decodeEvents(
      [
        {
          _id: '5', calendar_id: '1', _sync_id: 'c/x', dirty: '1', deleted: '0', sync_data1: '{broken', sync_data3: '{"uid":1}',
          sync_data4: '[]', sync_data5: 'nope', title: 'T', allDay: '0', dtstart: '1000', rrule: null, original_id: null, original_sync_id: null,
        },
      ],
      [],
      [],
    );
    expect(event).toMatchObject({ eventId: 5, calendarRowId: 1, syncId: 'c/x', dirty: true, deleted: false, shadow: null, pending: null, baseline: null, poison: null });
  });

  it('groups exceptions by ORIGINAL_ID, else ORIGINAL_SYNC_ID, and returns orphans as masters', () => {
    const events = calendarPlanner.decodeEvents(
      [
        { _id: 1, calendar_id: 1, _sync_id: 'c/m', eventTimezone: 'Europe/Berlin', allDay: 0, dirty: 0, deleted: 0 },
        { _id: 2, calendar_id: 1, _sync_id: null, original_id: 1, originalInstanceTime: utc('2026-10-07T07:00:00Z'), dirty: 1, deleted: 0 },
        { _id: 3, calendar_id: 1, _sync_id: 'c/m#2026-10-08T09:00:00', original_sync_id: 'c/m', sync_data2: '2026-10-08T09:00:00', dirty: 0, deleted: 0 },
        { _id: 4, calendar_id: 1, _sync_id: null, original_sync_id: 'c/gone', originalInstanceTime: 0, dirty: 1, deleted: 0 },
      ],
      [],
      [],
    );
    expect(events.map((e) => [e.eventId, e.exceptions.map((x) => [x.eventId, (x as { recurrenceId: string }).recurrenceId])])).toEqual([
      [1, [[2, '2026-10-07T09:00:00'], [3, '2026-10-08T09:00:00']]],
      [4, []],
    ]);
  });

  it('marks two masters sharing a _SYNC_ID as a split source and clone', () => {
    const events = calendarPlanner.decodeEvents(
      [
        { _id: 1, calendar_id: 1, _sync_id: 'c/m' },
        { _id: 9, calendar_id: 1, _sync_id: 'c/m' },
        { _id: 3, calendar_id: 1, _sync_id: 'c/n' },
      ],
      [],
      [],
    );
    expect(events.map((e: LocalEvent) => [e.eventId, e.split])).toEqual([
      [1, 'source'],
      [3, undefined],
      [9, 'clone'],
    ]);
  });
});
