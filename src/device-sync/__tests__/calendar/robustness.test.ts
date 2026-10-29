import { describe, expect, it } from 'vitest';
import { Attendees, Events, Reminders } from '../../android-columns';
import { calendarPlanner } from '../../calendar/planner';
import { Harness, single, utc, weekly } from './harness';

describe('calendar planner: what the real providers hand back', () => {
  it('sees no edit in numbers read back as text', async () => {
    const h = await new Harness().setup();
    await h.download(weekly());
    const id = Number(h.masterRow('bl')._id);
    // Some provider columns come back through the bridge as text.
    const row = h.fake.table('events').get(id)!;
    for (const c of [Events.STATUS, Events.AVAILABILITY, Events.ACCESS_LEVEL, Events.DTSTART, Events.ALL_DAY, Events.EVENT_COLOR, Events.CALENDAR_ID]) {
      row[c] = String(row[c]);
    }
    for (const a of h.fake.table('attendees').values()) {
      if (a.event_id === id) for (const c of [Attendees.ATTENDEE_STATUS, Attendees.ATTENDEE_TYPE, Attendees.ATTENDEE_RELATIONSHIP]) a[c] = String(a[c]);
    }
    for (const r of h.fake.table('reminders').values()) {
      if (r.event_id === id) for (const c of [Reminders.MINUTES, Reminders.METHOD]) r[c] = String(r[c]);
    }
    expect(calendarPlanner.planDownload(weekly(), await h.local('bl'), h.ctx).effect).toBe('none');
    h.fake.user.updateEvent(id, {});
    expect(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx).kind).toBe('clean');
  });

  it('asserts DIRTY as read, so a row inserted with a NULL DIRTY still takes a guarded write', async () => {
    const h = await new Harness().setup();
    await h.download(single());
    const id = Number(h.masterRow('e1')._id);
    h.fake.table('events').get(id)![Events.DIRTY] = null;
    const local = (await h.local('e1'))!;
    expect(local.dirty).toBe(false);
    const plan = calendarPlanner.planDownload(single({ title: 'Changed' }), local, h.ctx);
    const assert = plan.ops.ops.find((op) => op.op === 'assert' && 'id' in op && op.id === id) as { values: Record<string, unknown> };
    expect(assert.values[Events.DIRTY]).toBeNull();
    await h.apply(plan.ops);
    expect(h.row(id)[Events.TITLE]).toBe('Changed');
  });

  it('writes DIRTY = 0 on every row it inserts', async () => {
    const h = await new Harness().setup();
    const plan = calendarPlanner.planDownload(weekly(), null, h.ctx);
    const inserts = plan.ops.ops.filter((op) => op.op === 'insert' && op.table === 'events') as Array<{ values: Record<string, unknown> }>;
    expect(inserts).toHaveLength(2);
    for (const insert of inserts) expect(insert.values[Events.DIRTY]).toBe(0);
  });

  it('addresses attendee and reminder rows by id only', async () => {
    const h = await new Harness().setup();
    await h.download(weekly());
    const plan = calendarPlanner.planDownload(
      { ...weekly(), participants: { me1: weekly().participants!.me1 }, alerts: {} },
      await h.local('bl'),
      h.ctx,
    );
    for (const op of plan.ops.ops) {
      if ((op.op === 'update' || op.op === 'delete') && (op.table === 'attendees' || op.table === 'reminders')) {
        expect(op).toMatchObject({ expectCount: 1 });
        expect(typeof op.id).toBe('number');
        expect(op.where).toBeUndefined();
      }
      if ('where' in op && op.where) expect(op.where).not.toMatch(/\b_id\b/);
    }
    await h.apply(plan.ops);
  });

  it('computes instance times exactly across a DST change of the series\' zone', async () => {
    const h = await new Harness().setup();
    const event = weekly();
    event.recurrenceRule = { frequency: 'weekly', byDay: [{ day: 'mo' }] };
    event.recurrenceOverrides = { '2026-11-02T09:00:00': { title: 'After the change' } };
    await h.download(event);
    const [x] = (await h.local('bl'))!.exceptions;
    // New York left DST on 1 November: 09:00 is 14:00Z from then on, not 13:00Z.
    expect(x.cells[Events.ORIGINAL_INSTANCE_TIME]).toBe(utc('2026-11-02T14:00:00Z'));
    expect(x.cells[Events.DTSTART]).toBe(utc('2026-11-02T14:00:00Z'));
  });

  it('derives the recurrence id of an app\'s exception from its instance time in the master\'s zone', async () => {
    const h = await new Harness().setup();
    const event = weekly();
    event.recurrenceRule = { frequency: 'weekly', byDay: [{ day: 'mo' }] };
    event.recurrenceOverrides = {};
    await h.download(event);
    const id = Number(h.masterRow('bl')._id);
    h.fake.user.insertException(id, utc('2026-11-02T14:00:00Z'), { [Events.TITLE]: 'x', [Events.DTSTART]: utc('2026-11-02T14:00:00Z'), [Events.DTEND]: utc('2026-11-02T15:30:00Z') });
    expect((await h.local('bl'))!.exceptions[0].recurrenceId).toBe('2026-11-02T09:00:00');
  });

  it('ignores an EXRULE or RDATE an app wrote', async () => {
    const h = await new Harness().setup();
    await h.download(weekly());
    const id = Number(h.masterRow('bl')._id);
    h.fake.user.updateEvent(id, { [Events.EXRULE]: 'FREQ=MONTHLY' });
    expect(calendarPlanner.planUpload((await h.local('bl'))!, h.ctx).kind).toBe('clean');
  });
});
