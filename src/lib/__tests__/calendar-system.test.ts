import { describe, it, expect } from 'vitest';
import { enUS } from 'date-fns/locale/en-US';
import { faIR } from 'date-fns/locale/fa-IR';
import { GREGORIAN, JALALI, calendarSystemFor, headerTitleFor } from '../calendar-system';
import { baseRange, computeScrollWindow, freshScrollWindowState } from '../calendar-scroll-window';
import { monthFocusRow, monthKeyOf, monthMask, weekDays } from '../calendar-month-scroll';
import { startOfJalaliMonth, endOfJalaliMonth } from '../jalali-utils';

// The month grid follows the Jalali calendar when the app is in Persian
// (webmail useCalendarLocale). Internal dates stay Gregorian.

describe('calendarSystemFor', () => {
  it('only fa uses Jalali', () => {
    expect(calendarSystemFor('fa').kind).toBe('jalali');
    expect(calendarSystemFor('ar').kind).toBe('gregorian');
    expect(calendarSystemFor('en').kind).toBe('gregorian');
    expect(calendarSystemFor('fa')).toBe(JALALI);
    expect(calendarSystemFor('de')).toBe(GREGORIAN);
  });
});

describe('JALALI', () => {
  it('steps month by month from Esfand 1403 to Farvardin 1404 and back, never skipping', () => {
    expect(JALALI.addMonths(new Date(2025, 2, 20), 1)).toEqual(new Date(2025, 2, 21));
    expect(JALALI.addMonths(new Date(2025, 2, 21), -1)).toEqual(new Date(2025, 1, 19));
  });

  it('lands on the next Jalali month from any day of the month, across the year', () => {
    // From the last day of Mehr 1405 (22 Oct) and from its first (23 Sep).
    expect(JALALI.addMonths(new Date(2026, 9, 22), 1)).toEqual(new Date(2026, 9, 23)); // 1 Aban
    expect(JALALI.addMonths(new Date(2026, 8, 23), 1)).toEqual(new Date(2026, 9, 23));
    expect(JALALI.addMonths(new Date(2026, 9, 23), -1)).toEqual(new Date(2026, 8, 23)); // 1 Mehr
    // Twelve months on is the same month next year; -13 crosses two year ends.
    expect(JALALI.addMonths(new Date(2026, 8, 23), 12)).toEqual(new Date(2027, 8, 23)); // 1 Mehr 1406
    expect(JALALI.monthKey(JALALI.addMonths(new Date(2026, 8, 23), -13)))
      .toBe(JALALI.monthKey(new Date(2026, 8, 23)) - 13);
  });

  it('steps through every month of a year without skipping or repeating one', () => {
    let d = new Date(2025, 2, 21); // 1 Farvardin 1404
    for (let i = 0; i < 24; i++) {
      const next = JALALI.addMonths(d, 1);
      expect(JALALI.monthKey(next)).toBe(JALALI.monthKey(d) + 1);
      expect(JALALI.isFirstOfMonth(next)).toBe(true);
      expect(JALALI.addMonths(next, -1)).toEqual(JALALI.monthStart(d));
      d = next;
    }
  });

  it('labels the first of a Jalali month, and keys months by Jalali month', () => {
    expect(JALALI.isFirstOfMonth(new Date(2026, 8, 23))).toBe(true);
    expect(JALALI.isFirstOfMonth(new Date(2026, 9, 1))).toBe(false);
    expect(JALALI.monthKey(new Date(2026, 9, 22))).toBe(JALALI.monthKey(new Date(2026, 8, 23)));
    expect(JALALI.monthKey(new Date(2026, 9, 23))).toBe(JALALI.monthKey(new Date(2026, 8, 23)) + 1);
    expect(JALALI.dayOfMonth(new Date(2026, 9, 8))).toBe(16);
  });

  it('gives the month boundaries at local midnight', () => {
    expect(JALALI.monthStart(new Date(2026, 9, 8, 15, 30))).toEqual(new Date(2026, 8, 23));
    expect(JALALI.monthEnd(new Date(2026, 9, 8, 15, 30))).toEqual(new Date(2026, 9, 22));
    expect(JALALI.monthEnd(new Date(2025, 2, 1))).toEqual(new Date(2025, 2, 20)); // 30 Esfand 1403
  });

  it('names the month and year', () => {
    expect(JALALI.monthYearLabel(new Date(2026, 9, 8), faIR)).toBe('مهر 1405');
    expect(JALALI.shortMonthLabel(new Date(2026, 9, 23), faIR)).toBe('آبان');
  });
});

describe('GREGORIAN', () => {
  it('is the plain Gregorian month', () => {
    expect(GREGORIAN.addMonths(new Date(2026, 0, 31), 1)).toEqual(new Date(2026, 1, 28));
    expect(GREGORIAN.monthStart(new Date(2026, 9, 8))).toEqual(new Date(2026, 9, 1));
    expect(GREGORIAN.monthEnd(new Date(2026, 9, 8))).toEqual(new Date(2026, 9, 31));
    expect(GREGORIAN.monthKey(new Date(2026, 9, 8))).toBe(2026 * 12 + 9);
    expect(GREGORIAN.dayOfMonth(new Date(2026, 9, 8))).toBe(8);
    expect(GREGORIAN.isFirstOfMonth(new Date(2026, 9, 1))).toBe(true);
    expect(GREGORIAN.monthYearLabel(new Date(2026, 9, 8), enUS)).toBe('October 2026');
    expect(GREGORIAN.shortMonthLabel(new Date(2026, 9, 8), enUS)).toBe('Oct');
  });
});

describe('the month grid range', () => {
  it('gives the Jalali grid for a fa month range and the Gregorian one otherwise', () => {
    const d = new Date(2026, 9, 8);
    const jalali = baseRange('month', d, { weekStartsOn: 6, calendar: JALALI });
    expect(jalali.start).toEqual(startOfJalaliMonth(1405, 7, 6));
    expect(jalali.end).toEqual(endOfJalaliMonth(1405, 7, 6));
    expect(baseRange('month', d, { weekStartsOn: 1 })).toEqual({
      start: new Date(2026, 8, 28),
      end: new Date(2026, 10, 1),
    });
    expect(baseRange('month', d, { weekStartsOn: 1, calendar: GREGORIAN }))
      .toEqual(baseRange('month', d, { weekStartsOn: 1 }));
  });

  it('puts the Jalali month first in a fresh scrolling window', () => {
    const opts = { weekStartsOn: 6 as const, calendar: JALALI };
    const d = new Date(2026, 9, 8);
    const window = computeScrollWindow(freshScrollWindowState('month', d), opts);
    expect(window.start.getTime()).toBeLessThan(startOfJalaliMonth(1405, 7, 6).getTime());
    const weeks = Math.floor((window.end.getTime() - window.start.getTime()) / 86400000 / 7) + 1;
    const row = monthFocusRow(window, d, weeks, opts);
    const firstWeek = weekDays(new Date(window.start.getFullYear(), window.start.getMonth(), window.start.getDate() + row * 7));
    expect(firstWeek.some((day) => JALALI.isFirstOfMonth(day))).toBe(true);
  });

  it('shades the days of the Jalali month in a week that spans two', () => {
    // Sat 19 Sep to Fri 25 Sep 2026: 28–31 Shahrivar, then 1–3 Mehr.
    const week = weekDays(new Date(2026, 8, 19));
    const mehr = monthKeyOf(new Date(2026, 8, 23), JALALI);
    expect(monthMask(week, mehr, JALALI)).toBe(0b1110000);
    // Without a calendar the Gregorian month decides, as before.
    expect(monthMask(week, monthKeyOf(new Date(2026, 8, 23)))).toBe(0b1111111);
  });
});

describe('headerTitleFor', () => {
  it('keeps the Gregorian titles', () => {
    const d = new Date(2026, 9, 8);
    expect(headerTitleFor('month', d, 1, enUS, GREGORIAN)).toBe('October 2026');
    expect(headerTitleFor('agenda', d, 1, enUS, GREGORIAN)).toBe('October 2026');
    expect(headerTitleFor('day', d, 1, enUS, GREGORIAN)).toBe('Thu, Oct 8, 2026');
    expect(headerTitleFor('week', d, 1, enUS, GREGORIAN)).toBe('Oct 5 – 11, 2026');
    expect(headerTitleFor('week', new Date(2026, 8, 30), 1, enUS, GREGORIAN)).toBe('Sep 28 – Oct 4, 2026');
    expect(headerTitleFor('week', d, 1, enUS, GREGORIAN, new Date(2026, 9, 7))).toBe('Oct 7 – 13, 2026');
  });

  it('titles a Jalali month "مهر 1405"', () => {
    expect(headerTitleFor('month', new Date(2026, 9, 8), 6, faIR, JALALI)).toBe('مهر 1405');
    expect(headerTitleFor('agenda', new Date(2026, 9, 8), 6, faIR, JALALI)).toBe('مهر 1405');
  });

  it('titles Jalali weeks and days with the Jalali day, month and year', () => {
    // Sat 26 Sep – Fri 2 Oct 2026: 4–10 Mehr.
    expect(headerTitleFor('week', new Date(2026, 8, 28), 6, faIR, JALALI)).toBe('4 – 10 مهر 1405');
    // Sat 19 Sep – Fri 25 Sep 2026: 28 Shahrivar – 3 Mehr.
    expect(headerTitleFor('week', new Date(2026, 8, 22), 6, faIR, JALALI)).toBe('28 شهریور – 3 مهر 1405');
    // A free-scrolled week starts at the day shown first.
    expect(headerTitleFor('week', new Date(2026, 8, 22), 6, faIR, JALALI, new Date(2026, 8, 23)))
      .toBe('1 – 7 مهر 1405');
    expect(headerTitleFor('day', new Date(2026, 8, 23), 6, faIR, JALALI)).toBe('چهارشنبه 1 مهر 1405');
  });
});
