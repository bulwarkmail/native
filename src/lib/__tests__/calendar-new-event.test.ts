import { describe, it, expect } from 'vitest';
import { dayKey } from '../calendar-utils';
import { gregorianCalendar, jalaliCalendar } from '../calendar-system';
import { newEventStart, shownDays, type ShownDays } from '../calendar-new-event';

const opts = { multiDays: 3, weekStartsOn: 1 as const, calendarSystem: gregorianCalendar };
const keys = (shown: ShownDays | null) => shown && [dayKey(shown.range.start), dayKey(shown.range.end)];
const first = (shown: ShownDays | null) => shown && dayKey(shown.first);
// Saturday 14 November 2026, 12:47.
const now = new Date(2026, 10, 14, 12, 47, 10);

describe('shownDays', () => {
  it('is the one day of the day view', () => {
    expect(keys(shownDays('day', new Date(2026, 10, 22, 9), true, opts))).toEqual(['2026-11-22', '2026-11-22']);
  });

  it('is the multi-day view\'s days from the first one in view', () => {
    expect(keys(shownDays('3day', new Date(2026, 10, 22), true, opts))).toEqual(['2026-11-22', '2026-11-24']);
    expect(keys(shownDays('3day', new Date(2026, 10, 22), true, { ...opts, multiDays: 5 })))
      .toEqual(['2026-11-22', '2026-11-26']);
  });

  it('is the focused day\'s week until the week grid is scrolled', () => {
    expect(keys(shownDays('week', new Date(2026, 10, 25), false, opts))).toEqual(['2026-11-23', '2026-11-29']);
    expect(keys(shownDays('week', new Date(2026, 10, 25), false, { ...opts, weekStartsOn: 0 })))
      .toEqual(['2026-11-22', '2026-11-28']);
    expect(keys(shownDays('week', new Date(2026, 10, 25), true, opts))).toEqual(['2026-11-25', '2026-12-01']);
  });

  it('is the month\'s grid of whole weeks, starting events on the 1st', () => {
    const december = shownDays('month', new Date(2026, 11, 9), false, opts);
    expect(keys(december)).toEqual(['2026-11-30', '2027-01-03']);
    expect(first(december)).toBe('2026-12-01');
    // 9 December 2026 is in Azar 1405: 22 November to 21 December.
    const azar = shownDays('month', new Date(2026, 11, 9), false, { ...opts, calendarSystem: jalaliCalendar });
    expect(keys(azar)).toEqual(['2026-11-16', '2026-12-27']);
    expect(first(azar)).toBe('2026-11-22');
  });

  it('is the rows the scrolling month reported, while they hold the month in the title', () => {
    // The title turned to December with November's last weeks still on top.
    const rows = { start: new Date(2026, 10, 16), end: new Date(2026, 11, 27) };
    const december = shownDays('month', new Date(2026, 11, 3), true, { ...opts, monthRows: rows });
    expect(keys(december)).toEqual(['2026-11-16', '2026-12-27']);
    expect(first(december)).toBe('2026-12-01');
    // Scrolling back, the title turned to November with its 1st above the top row.
    const back = { start: new Date(2026, 10, 9), end: new Date(2026, 11, 20) };
    const november = shownDays('month', new Date(2026, 10, 26), true, { ...opts, monthRows: back });
    expect(first(november)).toBe('2026-11-09');
    // Further on in December the title's day is from a row scrolled away.
    const later = { start: new Date(2026, 11, 14), end: new Date(2027, 0, 24) };
    const lateDecember = shownDays('month', new Date(2026, 11, 3), true, { ...opts, monthRows: later });
    expect(keys(lateDecember)).toEqual(['2026-12-14', '2027-01-24']);
    expect(first(lateDecember)).toBe('2026-12-14');
    // Rows from before a jump to March are not on screen any more.
    const march = shownDays('month', new Date(2027, 2, 1), false, { ...opts, monthRows: rows });
    expect(keys(march)).toEqual(['2027-03-01', '2027-04-04']);
  });

  it('has no period in the schedule', () => {
    expect(shownDays('agenda', new Date(2026, 10, 22), true, opts)).toBeNull();
  });
});

describe('newEventStart', () => {
  const at = (date: Date) => `${dayKey(date)} ${date.getHours()}:${date.getMinutes()}`;

  it('starts on the day swiped to in the day view, not on the selection left behind (#139)', () => {
    const shown = shownDays('day', new Date(2026, 10, 22), true, opts);
    expect(at(newEventStart(new Date(2026, 10, 14, 11, 58), shown, now))).toBe('2026-11-22 12:47');
  });

  it('keeps the selected day while the view shows it', () => {
    const week = shownDays('week', new Date(2026, 10, 10), false, opts);
    expect(at(newEventStart(new Date(2026, 10, 14), week, now))).toBe('2026-11-14 12:47');
    const month = shownDays('month', new Date(2026, 10, 3), true, opts);
    expect(at(newEventStart(new Date(2026, 10, 30), month, now))).toBe('2026-11-30 12:47');
  });

  it('starts on the first day shown once the selection is off screen', () => {
    const week = shownDays('week', new Date(2026, 10, 25), false, opts);
    expect(at(newEventStart(new Date(2026, 10, 14), week, now))).toBe('2026-11-23 12:47');
    const month = shownDays('month', new Date(2026, 11, 9), false, opts);
    expect(at(newEventStart(new Date(2026, 10, 14), month, now))).toBe('2026-12-01 12:47');
    const days = shownDays('3day', new Date(2026, 10, 12), true, opts);
    expect(at(newEventStart(new Date(2026, 10, 15), days, now))).toBe('2026-11-12 12:47');
  });

  it('keeps a selected day of the month before while its row is on screen', () => {
    const rows = { start: new Date(2026, 10, 16), end: new Date(2026, 11, 27) };
    const december = shownDays('month', new Date(2026, 11, 3), true, { ...opts, monthRows: rows });
    expect(at(newEventStart(new Date(2026, 10, 20), december, now))).toBe('2026-11-20 12:47');
    expect(at(newEventStart(new Date(2026, 10, 14), december, now))).toBe('2026-12-01 12:47');
  });

  it('keeps the selected day in the schedule', () => {
    expect(at(newEventStart(new Date(2026, 10, 20), null, now))).toBe('2026-11-20 12:47');
  });

  it('stays on the day late in the evening, when rounding up would pass midnight', () => {
    const shown = shownDays('day', new Date(2026, 10, 22), true, opts);
    expect(at(newEventStart(new Date(2026, 10, 14), shown, new Date(2026, 10, 14, 23, 40)))).toBe('2026-11-22 23:30');
    expect(at(newEventStart(new Date(2026, 10, 14), shown, new Date(2026, 10, 14, 23, 30, 5)))).toBe('2026-11-22 23:30');
    expect(at(newEventStart(new Date(2026, 10, 14), shown, new Date(2026, 10, 14, 23, 29, 59)))).toBe('2026-11-22 23:29');
  });

  it('takes the time from the clock, not from when the day was selected', () => {
    const shown = shownDays('day', new Date(2026, 10, 14), false, opts);
    expect(at(newEventStart(new Date(2026, 10, 14, 11, 58), shown, now))).toBe('2026-11-14 12:47');
  });
});
