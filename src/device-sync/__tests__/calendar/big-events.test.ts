// Big meetings (many attendees on many overrides): a write into such an event
// has to fit one provider transaction (Binder: about 1 MB; a Parcel carries
// the JSON as UTF-16, estimated at 2 bytes per character plus ~300 per op).
import { describe, expect, it } from 'vitest';
import { Attendees, Events } from '../../android-columns';
import { calendarPlanner } from '../../calendar/planner';
import { contactsPlanner } from '../../contacts/planner';
import type { OpGroup } from '../../planner';
import { CALENDAR_AUTHORITY } from '../../types';
import type { CalendarEventWire } from '../../wire';
import { createHarness, rowWrites, type Harness as EngineHarness } from '../engine/harness';
import { Harness, ME, serverApply } from './harness';

const TRANSACTION = 1_000_000;
const estimate = (group: OpGroup) => 2 * JSON.stringify(group.ops).length + 300 * group.ops.length;
/** A plan's groups: the group and the ones applied after it. */
const chain = (group: OpGroup): OpGroup[] => [group, ...(group.next ?? [])];

/** A daily meeting with `attendees` guests whose `overrides` occurrences each carry the whole participants map. */
function meeting(attendees: number, overrides: number, me = ME, calendarId = 'b'): CalendarEventWire {
  const participants: Record<string, unknown> = {
    me: { '@type': 'Participant', calendarAddress: `mailto:${me}`, roles: { owner: true, attendee: true }, participationStatus: 'accepted' },
  };
  for (let i = 0; i < attendees; i++) {
    participants[`p${i}`] = { '@type': 'Participant', calendarAddress: `mailto:person${i}@example.com`, name: `Person ${i}`, roles: { attendee: true }, participationStatus: 'needs-action', expectReply: true };
  }
  const recurrenceOverrides: Record<string, unknown> = {};
  for (let i = 0; i < overrides; i++) {
    const day = new Date(Date.UTC(2026, 9, 6) + i * 86_400_000).toISOString().slice(0, 10);
    recurrenceOverrides[`${day}T09:00:00`] = { title: `Standup #${i}`, participants };
  }
  return {
    id: 'big',
    '@type': 'Event',
    uid: 'big@example.org',
    calendarIds: { [calendarId]: true },
    title: 'Standup',
    description: 'Daily standup',
    start: '2026-10-05T09:00:00',
    timeZone: 'Europe/Berlin',
    duration: 'PT15M',
    recurrenceRule: { frequency: 'daily', count: 300 },
    organizerCalendarAddress: `mailto:${me}`,
    participants,
    recurrenceOverrides,
  } as unknown as CalendarEventWire;
}

/** The engine with the real planners (the fake provider refuses a batch over one Binder transaction, as Android does). */
function engineWithRealPlanners(): EngineHarness {
  const h = createHarness();
  h.deps.planners = { contacts: contactsPlanner, calendar: calendarPlanner };
  return h;
}

/** The big meeting's rows on the engine's device: one master, one exception row per override, every attendee once. */
function expectWholeMeeting(h: EngineHarness, id: string, attendees: number, overrides: number, context = ''): void {
  const rows = h.events();
  const masters = rows.filter((e) => e[Events._SYNC_ID] === `a/${id}`);
  expect(masters, context).toHaveLength(1);
  const exceptions = rows.filter((e) => e[Events.ORIGINAL_SYNC_ID] === `a/${id}`);
  expect(exceptions, context).toHaveLength(overrides);
  expect(new Set(exceptions.map((x) => x[Events._SYNC_ID])).size, context).toBe(overrides);
  expect(exceptions.every((x) => Number(x[Events.ORIGINAL_ID]) === Number(masters[0]._id)), context).toBe(true);
  const attendeesOf = (eventId: unknown) => h.device.rows('attendees').filter((a) => Number(a.event_id) === Number(eventId)).length;
  expect([masters[0], ...exceptions].every((row) => attendeesOf(row._id) === attendees + 1), context).toBe(true);
  expect(Object.keys(JSON.parse(String(masters[0][Events.SYNC_DATA1])).recurrenceOverrides), context).toHaveLength(overrides);
  expect(rows.filter((e) => e[Events.ORIGINAL_SYNC_ID] === null), context).toHaveLength(1);
}

async function synced(event: CalendarEventWire) {
  const h = await new Harness().setup();
  await h.download(event);
  return { h, id: Number(h.masterRow(event.id)._id) };
}

describe('calendar planner: big meetings', () => {
  it('fits the writes after an edit of a big meeting into one transaction', async () => {
    const event = meeting(25, 52);
    const { h, id } = await synced(event);
    // Only the series row is edited; its 52 occurrences with 26 attendees each stay clean.
    h.fake.user.updateEvent(id, { [Events.TITLE]: 'Daily standup' });
    const local = (await h.local('big'))!;

    const plan = calendarPlanner.planUpload(local, h.ctx);
    if (plan.kind !== 'upload' || plan.actions[0].kind !== 'update') throw new Error(plan.kind);
    const server = serverApply(event, plan.actions[0].patch);
    const accepted = calendarPlanner.planAccepted(local, server, h.ctx);
    expect(estimate(accepted.ops)).toBeLessThan(TRANSACTION);
    expect(estimate(accepted.keepDirtyOps)).toBeLessThan(TRANSACTION);

    // A download into the edited event (the server changed one occurrence meanwhile).
    const remote = { ...event, recurrenceOverrides: { ...event.recurrenceOverrides, '2026-10-09T09:00:00': { title: 'Moved to Friday' } } } as CalendarEventWire;
    expect(estimate(calendarPlanner.planDownload(remote, local, h.ctx).ops)).toBeLessThan(TRANSACTION);

    // A save that changed nothing mapped is cleared the same way.
    h.fake.user.updateEvent(id, { [Events.TITLE]: 'Standup' });
    const clean = calendarPlanner.planUpload((await h.local('big'))!, h.ctx);
    expect(clean.kind).toBe('clean');
    if (clean.kind === 'clean') expect(estimate(clean.ops)).toBeLessThan(TRANSACTION);
  }, 60_000);

  it('still fails a write when an app changed a clean occurrence\'s attendees meanwhile', async () => {
    const event = meeting(3, 4);
    const { h, id } = await synced(event);
    h.fake.user.updateEvent(id, { [Events.TITLE]: 'Daily standup' });
    const local = (await h.local('big'))!;
    const x = local.exceptions[0];
    const plan = calendarPlanner.planUpload(local, h.ctx);
    if (plan.kind !== 'upload' || plan.actions[0].kind !== 'update') throw new Error(plan.kind);
    const accepted = calendarPlanner.planAccepted(local, serverApply(event, plan.actions[0].patch), h.ctx);
    // The occurrence's attendees are not asserted one by one: CalendarProvider marks the event DIRTY on any app write to them.
    h.fake.beforeNextBatch(() => h.fake.user.setAttendeeStatus(x.eventId, 'person1@example.com', 1));
    expect(await h.tryApply(accepted.ops)).toMatchObject({ ok: false, reason: 'assert' });
    expect(h.fake.rows('attendees', `${Attendees.EVENT_ID} = ? AND ${Attendees.ATTENDEE_EMAIL} = ?`, [x.eventId, 'person1@example.com'])[0][Attendees.ATTENDEE_STATUS]).toBe(1);
  });

  it.each([
    [25, 52],
    [100, 12],
  ])('writes the first download of %i attendees on %i overrides in groups that each fit one transaction', async (attendees, overrides) => {
    const h = await new Harness().setup();
    const event = meeting(attendees, overrides);

    const plan = calendarPlanner.planDownload(event, null, h.ctx);

    expect(plan.effect).toBe('insert');
    expect(chain(plan.ops).length).toBeGreaterThan(1);
    for (const group of chain(plan.ops)) expect(estimate(group)).toBeLessThan(TRANSACTION);
    await h.apply(plan.ops);
    const local = (await h.local('big'))!;
    expect(local.shadow).toEqual(event);
    expect(local.exceptions.map((x) => x.recurrenceId).sort()).toEqual(Object.keys(event.recurrenceOverrides!).sort());
    expect(local.exceptions.every((x) => x.attendees.length === attendees + 1 && !x.dirty)).toBe(true);
    // Its echo writes nothing.
    expect(calendarPlanner.planDownload(event, local, h.ctx).effect).toBe('none');
  }, 60_000);

  it('finishes a first download cut off between its groups, without writing a row twice', async () => {
    const event = meeting(25, 52);
    const groups = chain(calendarPlanner.planDownload(event, null, (await new Harness().setup()).ctx).ops).length;
    for (let cut = 1; cut < groups; cut++) {
      const h = await new Harness().setup();
      for (const group of chain(calendarPlanner.planDownload(event, null, h.ctx).ops).slice(0, cut)) await h.apply({ ref: group.ref, ops: group.ops });

      // Planned again from what the first groups wrote.
      const again = calendarPlanner.planDownload(event, await h.local('big'), h.ctx);
      for (const group of chain(again.ops)) expect(estimate(group)).toBeLessThan(TRANSACTION);
      await h.apply(again.ops);

      const local = (await h.local('big'))!;
      expect(local.shadow, `cut after ${cut}`).toEqual(event);
      expect(new Set(local.exceptions.map((x) => x.recurrenceId)).size, `cut after ${cut}`).toBe(52);
      expect(local.exceptions, `cut after ${cut}`).toHaveLength(52);
      expect(local.exceptions.every((x) => x.attendees.length === 26), `cut after ${cut}`).toBe(true);
      expect(calendarPlanner.planDownload(event, local, h.ctx).effect, `cut after ${cut}`).toBe('none');
    }
    // Every cut point writes a 2 MB meeting again.
  }, 60_000);

  it('writes a change of every occurrence in groups, the series with its new shadow last', async () => {
    const h = await new Harness().setup();
    const event = meeting(25, 52);
    await h.download(event);
    // Another client adds a guest to the meeting and to every occurrence.
    const guest = { '@type': 'Participant', calendarAddress: 'mailto:guest@example.com', name: 'Guest', roles: { attendee: true }, participationStatus: 'needs-action' };
    const changed = JSON.parse(JSON.stringify(event)) as CalendarEventWire;
    (changed.participants as Record<string, unknown>).guest = guest;
    for (const override of Object.values(changed.recurrenceOverrides!)) (override as { participants: Record<string, unknown> }).participants.guest = guest;

    const plan = calendarPlanner.planDownload(changed, await h.local('big'), h.ctx);

    const groups = chain(plan.ops);
    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) expect(estimate(group)).toBeLessThan(TRANSACTION);
    const writesShadow = (group: OpGroup) => group.ops.some((op) => op.op === 'update' && Events.SYNC_DATA1 in op.values);
    expect(groups.map(writesShadow)).toEqual(groups.map((_, i) => i === groups.length - 1));
    // Cut off after the first group: planned again from what it wrote, the rest follows.
    await h.apply({ ref: groups[0].ref, ops: groups[0].ops });
    await h.apply(calendarPlanner.planDownload(changed, await h.local('big'), h.ctx).ops);
    const local = (await h.local('big'))!;
    expect(local.shadow).toEqual(changed);
    expect(local.exceptions.every((x) => x.attendees.length === 27)).toBe(true);
    expect(calendarPlanner.planDownload(changed, local, h.ctx).effect).toBe('none');
  }, 60_000);
});

describe('device sync engine: big meetings', () => {
  it.each([
    [25, 52],
    [100, 12],
  ])('downloads a meeting of %i attendees on %i overrides in several transactions', async (attendees, overrides) => {
    const h = engineWithRealPlanners();
    const { id: _drop, ...event } = meeting(attendees, overrides, 'alice@example.com', h.calendar) as unknown as Record<string, unknown>;
    const id = h.server.addEvent('a', event);

    const report = await h.run(CALENDAR_AUTHORITY);

    expect(report).toMatchObject({ outcome: 'ok', itemErrors: [], stats: { downloaded: { created: 1 } } });
    expectWholeMeeting(h, id, attendees, overrides);
    const before = h.batches.log.length;
    expect((await h.run(CALENDAR_AUTHORITY)).outcome).toBe('ok');
    expect(rowWrites(h.batches.log.slice(before))).toEqual([]);
  }, 60_000);

  it('finishes a big meeting cut off between its groups by a crash, without duplicating rows', async () => {
    const setup = () => {
      const h = engineWithRealPlanners();
      const { id: _drop, ...event } = meeting(25, 52, 'alice@example.com', h.calendar) as unknown as Record<string, unknown>;
      return { h, id: h.server.addEvent('a', event) };
    };
    const probe = setup();
    await probe.h.run(CALENDAR_AUTHORITY);
    const batches = probe.h.batches.applied;

    for (let n = 1; n < batches; n++) {
      const { h, id } = setup();
      h.batches.crashAfter = n;
      await h.run(CALENDAR_AUTHORITY);
      h.batches.crashAfter = null;
      expect((await h.run(CALENDAR_AUTHORITY)).outcome, `crash after batch ${n}`).toBe('ok');
      expectWholeMeeting(h, id, 25, 52, `crash after batch ${n}`);
    }
    // Two runs of a 2 MB meeting per crash point.
  }, 60_000);
});
