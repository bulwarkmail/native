import { describe, expect, it } from 'vitest';
import { CalendarAccess, Calendars } from '../../android-columns';
import { calendarPlanner } from '../../calendar/planner';
import { CAN_PARTIALLY_UPDATE } from '../../calendar/columns';
import { cssColorToArgb } from '../../calendar/values';
import { BIRTHDAY_CALENDAR_ID } from '../../../lib/birthday-calendar';
import type { CalendarLike } from '../../wire';
import { ACCT, CALENDARS, Harness, ME } from './harness';

const personal = (calendar: CalendarLike, readOnly = false) => ({ jmapAccountId: ACCT, calendar, readOnly, accountName: ME });

describe('calendar planner: calendar rows', () => {
  it('inserts every column the provider and the calendar apps need', async () => {
    const h = await new Harness().setup(['b']);
    const [row] = await h.calendars();
    expect(row.syncId).toBe(`${ACCT}/b`);
    expect(row.cells).toMatchObject({
      [Calendars.NAME]: 'Personal',
      [Calendars.CALENDAR_DISPLAY_NAME]: 'Personal',
      [Calendars.CALENDAR_COLOR]: cssColorToArgb('#3b82f6'),
      [Calendars.CALENDAR_ACCESS_LEVEL]: CalendarAccess.OWNER,
      [Calendars.OWNER_ACCOUNT]: ME,
      [Calendars.SYNC_EVENTS]: 1,
      [Calendars.VISIBLE]: 1,
      [Calendars.CALENDAR_TIME_ZONE]: 'Europe/Berlin',
      [Calendars.ALLOWED_REMINDERS]: '1,2',
      [Calendars.ALLOWED_AVAILABILITY]: '0,1',
      [Calendars.ALLOWED_ATTENDEE_TYPES]: '0,1,2,3',
      [Calendars.MAX_REMINDERS]: 5,
      [Calendars.CAN_ORGANIZER_RESPOND]: 0,
      [CAN_PARTIALLY_UPDATE]: 0,
    });
    // CAL_SYNC1 would become the `feed` extra of every sync the provider requests for the calendar.
    expect(h.fake.row('calendars', row.calendarRowId)).toMatchObject({ [Calendars.CAL_SYNC1]: null, [Calendars.DIRTY]: 0 });
    expect(row.shadow).toEqual(CALENDARS.b);
    expect(row.flags).toEqual({});
  });

  it('writes nothing when nothing changed, and only what changed otherwise', async () => {
    const h = await new Harness().setup(['b']);
    const local = await h.calendars();
    expect(calendarPlanner.planCalendars([personal(CALENDARS.b)], local, h.ctx)).toEqual({ groups: [], deleteCalendarRows: [] });
    const renamed = { ...CALENDARS.b, name: 'Private', color: 'tomato' } as CalendarLike;
    const plan = calendarPlanner.planCalendars([personal(renamed)], local, h.ctx);
    expect(plan.groups).toHaveLength(1);
    const [op] = plan.groups[0].ops;
    expect(op).toMatchObject({ op: 'update', table: 'calendars', id: local[0].calendarRowId, expectCount: 1 });
    expect(Object.keys((op as { values: object }).values).sort()).toEqual(
      [Calendars.NAME, Calendars.CALENDAR_DISPLAY_NAME, Calendars.CALENDAR_COLOR, Calendars.CAL_SYNC2].sort(),
    );
    // VISIBLE is the user's once the row exists.
    expect((op as { values: object }).values).not.toHaveProperty(Calendars.VISIBLE);
  });

  it('keeps VISIBLE as the user set it', async () => {
    const h = await new Harness().setup(['b']);
    const [row] = await h.calendars();
    await h.apply({ ref: 'x', ops: [{ op: 'update', table: 'calendars', id: row.calendarRowId, values: { [Calendars.VISIBLE]: 0 } }] });
    expect(calendarPlanner.planCalendars([personal(CALENDARS.b)], await h.calendars(), h.ctx).groups).toEqual([]);
  });

  it('maps rights to access levels, and a writable read-only calendar is a subscribed feed', () => {
    const level = (rights: CalendarLike['myRights'], readOnly = false) => {
      const plan = calendarPlanner.planCalendars([personal({ id: 'z', name: 'Z', myRights: rights } as CalendarLike, readOnly)], [], new Harness().ctx);
      const values = (plan.groups[0].ops[0] as { values: Record<string, unknown> }).values;
      return [values[Calendars.CALENDAR_ACCESS_LEVEL], JSON.parse(String(values[Calendars.CAL_SYNC3]))];
    };
    expect(level({ mayWriteAll: true, mayWriteOwn: true })).toEqual([CalendarAccess.OWNER, {}]);
    expect(level({ mayWriteOwn: true })).toEqual([CalendarAccess.CONTRIBUTOR, {}]);
    expect(level({ mayRSVP: true }, true)).toEqual([CalendarAccess.RESPOND, { readOnly: 'rights' }]);
    expect(level({ mayReadItems: true }, true)).toEqual([CalendarAccess.READ, { readOnly: 'rights' }]);
    expect(level({ mayWriteAll: true }, true)).toEqual([CalendarAccess.READ, { readOnly: 'subscription' }]);
  });

  it('offers no reminder editor when Bulwark owns reminders', async () => {
    const h = await new Harness({ reminderOwner: 'bulwark' }).setup(['b']);
    expect((await h.calendars())[0].cells[Calendars.MAX_REMINDERS]).toBe(0);
    h.ctx = { ...h.ctx, reminderOwner: 'device' };
    const plan = calendarPlanner.planCalendars([personal(CALENDARS.b)], await h.calendars(), h.ctx);
    expect((plan.groups[0].ops[0] as { values: object }).values).toEqual({ [Calendars.MAX_REMINDERS]: 5 });
  });

  it('names shared accounts\' calendars after their account and colours calendars without a colour', () => {
    const ctx = new Harness().ctx;
    const plan = calendarPlanner.planCalendars(
      [{ jmapAccountId: 'd', calendar: { id: 'x', name: 'Team', myRights: { mayWriteAll: true } } as CalendarLike, readOnly: false, accountName: 'Bob Builder' }],
      [],
      ctx,
    );
    const values = (plan.groups[0].ops[0] as { values: Record<string, unknown> }).values;
    expect(values[Calendars._SYNC_ID]).toBe('d/x');
    expect(values[Calendars.CALENDAR_DISPLAY_NAME]).toBe('Team (Bob Builder)');
    expect(typeof values[Calendars.CALENDAR_COLOR]).toBe('number');
    expect(values[Calendars.OWNER_ACCOUNT]).toBe(ME);
  });

  it('deletes rows of deselected calendars and never syncs the birthday calendar', async () => {
    const h = await new Harness().setup(['b', 'w']);
    const local = await h.calendars();
    const plan = calendarPlanner.planCalendars(
      [personal(CALENDARS.b), personal({ id: BIRTHDAY_CALENDAR_ID, name: 'Birthdays' } as CalendarLike)],
      local,
      h.ctx,
    );
    expect(plan.groups).toEqual([]);
    expect(plan.deleteCalendarRows).toEqual([local.find((c) => c.syncId === `${ACCT}/w`)!.calendarRowId]);
  });

  it('reads calendar rows defensively', () => {
    const cal = calendarPlanner.decodeCalendar({ _id: '4', _sync_id: 'c/b', cal_sync2: 'garbage', cal_sync3: '{"readOnly":"subscription","taskOnly":true}' });
    expect(cal).toMatchObject({ calendarRowId: 4, syncId: 'c/b', shadow: null, flags: { readOnly: 'subscription', taskOnly: true } });
    expect(calendarPlanner.decodeCalendar({ _id: 5, _sync_id: null, cal_sync3: '[1]' }).flags).toEqual({});
  });
});
