import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { enUS } from 'date-fns/locale/en-US';
import { faIR } from 'date-fns/locale/fa-IR';
import { fromJalali, isLeapJalaliYear, jalaliMonthLength, toJalali } from '../jalali';
import {
  calendarSystemFor,
  dayNumberLabel,
  dayRangeLabel,
  formatCalendarDay,
  gregorianCalendar,
  isFirstOfMonth,
  jalaliCalendar,
  monthGridRows,
  monthStartLabel,
  monthTitle,
} from '../calendar-system';
import { baseRange } from '../calendar-scroll-window';
import { monthKeyOf, monthMask } from '../calendar-month-scroll';

// Ported from the webmail's lib/__tests__/jalali-utils.test.ts and
// hooks/__tests__/use-calendar-locale.test.ts. The conversion was also
// checked day by day from 1900 to 2200 against jalaali-js, which the webmail
// uses.

const ymd = (d: Date) => [d.getFullYear(), d.getMonth() + 1, d.getDate()];

describe('Jalali dates', () => {
  it('converts Gregorian days to Jalali and back', () => {
    expect(toJalali(new Date(2026, 2, 21))).toEqual({ jy: 1405, jm: 1, jd: 1 });
    expect(toJalali(new Date(2026, 3, 29))).toEqual({ jy: 1405, jm: 2, jd: 9 });
    expect(toJalali(new Date(2025, 2, 20))).toEqual({ jy: 1403, jm: 12, jd: 30 });
    expect(ymd(fromJalali(1405, 7, 1))).toEqual([2026, 9, 23]);
    expect(ymd(fromJalali(1403, 12, 30))).toEqual([2025, 3, 20]);
  });

  it('knows leap years and month lengths', () => {
    expect(isLeapJalaliYear(1403)).toBe(true);
    expect(isLeapJalaliYear(1404)).toBe(false);
    expect(jalaliMonthLength(1404, 1)).toBe(31);
    expect(jalaliMonthLength(1404, 7)).toBe(30);
    expect(jalaliMonthLength(1404, 12)).toBe(29);
    expect(jalaliMonthLength(1403, 12)).toBe(30);
  });
});

describe('the calendar system', () => {
  it('is Jalali for the Persian UI only, as in the webmail', () => {
    expect(calendarSystemFor('fa')).toBe(jalaliCalendar);
    expect(calendarSystemFor('de')).toBe(gregorianCalendar);
    expect(calendarSystemFor('ar')).toBe(gregorianCalendar);
  });

  it('builds the Jalali month grid from the week of 1 Mehr to the week of 30 Mehr, starting on Saturday', () => {
    // 15 October 2026 is 23 Mehr 1405.
    const rows = monthGridRows(new Date(2026, 9, 15), 6, jalaliCalendar);
    const first = rows[0][0];
    const last = rows[rows.length - 1][6];
    expect(first.getDay()).toBe(6);
    expect(rows.flat().some((d) => toJalali(d).jm === 7 && toJalali(d).jd === 1)).toBe(true);
    expect(toJalali(rows[0][6]).jm === 7 || toJalali(rows[0][6]).jd === 1).toBe(true);
    expect(rows.flat().some((d) => toJalali(d).jm === 7 && toJalali(d).jd === 30)).toBe(true);
    // No whole week of another month at either end.
    expect(rows[0].some((d) => toJalali(d).jm === 7)).toBe(true);
    expect(rows[rows.length - 1].some((d) => toJalali(d).jm === 7)).toBe(true);
    expect(last.getDay()).toBe(5);
  });

  it('starts a Gregorian month grid on Saturday when the week does', () => {
    const rows = monthGridRows(new Date(2026, 9, 15), 6, gregorianCalendar);
    expect(rows[0][0].getDay()).toBe(6);
    expect(ymd(rows[0][0])).toEqual([2026, 9, 26]);
    expect(ymd(rows[rows.length - 1][6])).toEqual([2026, 11, 6]);
  });

  it('gives the scrolling month the Jalali grid, and the Gregorian one without a calendar system', () => {
    const date = new Date(2026, 9, 15);
    const jalali = baseRange('month', date, { weekStartsOn: 6, calendarSystem: jalaliCalendar });
    const rows = monthGridRows(date, 6, jalaliCalendar);
    expect(jalali.start.getTime()).toBe(rows[0][0].getTime());
    expect(jalali.end.getTime()).toBe(rows[rows.length - 1][6].getTime());
    const gregorian = baseRange('month', date, { weekStartsOn: 1 });
    expect(ymd(gregorian.start)).toEqual([2026, 9, 28]);
  });

  it('counts two days of Mehr in September and October as one month, and shades by it', () => {
    const sept = new Date(2026, 8, 25); // 3 Mehr
    const oct = new Date(2026, 9, 20); // 28 Mehr
    expect(monthKeyOf(sept, jalaliCalendar)).toBe(monthKeyOf(oct, jalaliCalendar));
    expect(monthKeyOf(sept)).not.toBe(monthKeyOf(oct));
    const days = [new Date(2026, 9, 21), new Date(2026, 9, 22), new Date(2026, 9, 23)]; // 29, 30 Mehr, 1 Aban
    expect(monthMask(days, monthKeyOf(oct, jalaliCalendar), jalaliCalendar)).toBe(0b011);
  });

  it('steps Jalali months, keeping the day where the month has it', () => {
    // 31 Shahrivar 1405 -> 30 Mehr (Mehr has 30 days).
    expect(toJalali(jalaliCalendar.addMonths(fromJalali(1405, 6, 31), 1))).toEqual({ jy: 1405, jm: 7, jd: 30 });
    expect(toJalali(jalaliCalendar.addMonths(fromJalali(1404, 12, 10), 1))).toEqual({ jy: 1405, jm: 1, jd: 10 });
    expect(toJalali(jalaliCalendar.addMonths(fromJalali(1405, 1, 10), -1))).toEqual({ jy: 1404, jm: 12, jd: 10 });
    const withTime = new Date(2026, 9, 15, 14, 30);
    expect(jalaliCalendar.addMonths(withTime, 2).getHours()).toBe(14);
  });

  it('labels Jalali days and months as the webmail does', () => {
    const day = new Date(2026, 3, 29); // 9 Ordibehesht 1405
    expect(dayNumberLabel(day, jalaliCalendar)).toBe('9');
    expect(dayNumberLabel(day, gregorianCalendar)).toBe('29');
    expect(monthTitle(day, jalaliCalendar, faIR, true)).toBe('اردیبهشت 1405');
    expect(monthTitle(day, jalaliCalendar, faIR, false)).toBe('اردیبهشت');
    expect(monthTitle(day, gregorianCalendar, enUS, true)).toBe('April 2026');
    expect(isFirstOfMonth(new Date(2026, 3, 21), jalaliCalendar)).toBe(true);
    expect(monthStartLabel(new Date(2026, 3, 21), jalaliCalendar, faIR, true)).toBe('1 اردیبهشت');
    expect(monthStartLabel(new Date(2026, 4, 1), gregorianCalendar, enUS, true)).toBe('May 1');
    expect(dayRangeLabel(new Date(2026, 3, 25), new Date(2026, 4, 1), jalaliCalendar, faIR)).toBe('5 – 11 اردیبهشت');
    expect(dayRangeLabel(new Date(2026, 3, 18), new Date(2026, 3, 24), jalaliCalendar, faIR)).toBe('29 فروردین – 4 اردیبهشت');
  });

  it('writes event dates with the Jalali day, month and year in Persian (useFormatEventDate)', () => {
    const day = new Date(2026, 3, 29);
    expect(formatCalendarDay(day, faIR, 'longWeekdayMonthDayYear')).toBe('چهارشنبه, 9 اردیبهشت 1405');
    expect(formatCalendarDay(day, faIR, 'monthDay')).toBe('9 اردیبهشت');
    expect(formatCalendarDay(day, enUS, 'monthDay')).toMatch(/Apr(il)? 29/);
  });
});

describe('the views follow the calendar system', () => {
  const read = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf8');

  it('builds the month grid and its shading from the calendar system', () => {
    const month = read('../../components/calendar/MonthView.tsx');
    expect(month).toMatch(/monthGridRows\(currentDate, weekStartsOn, system\)/);
    expect(month).toMatch(/monthMask\(days, activeMonth, system\)/);
    expect(month).toMatch(/dayNumberLabel\(d, system\)/);
    const scroll = read('../../components/calendar/MonthScrollView.tsx');
    expect(scroll).toMatch(/calendarSystem: system/);
    expect(scroll).toMatch(/monthMask\(days, activeMonth, system\)/);
  });

  it('steps a month and titles the screen in the calendar system', () => {
    const screen = read('../../screens/CalendarScreen.tsx');
    expect(screen).toMatch(/system\.addMonths\(base, -1\)/);
    expect(screen).toMatch(/system\.addMonths\(base, 1\)/);
    expect(screen).toMatch(/headerTitle\(titleDate, locale, system\)/);
    expect(screen).toMatch(/calendarSystem: system/);
  });

  it('numbers the days of the week and day views in the calendar system', () => {
    expect(read('../../components/calendar/WeekView.tsx')).toMatch(/dayNumberLabel\(day, system\)/);
    expect(read('../../components/calendar/TimeGridScrollView.tsx')).toMatch(/dayNumberLabel\(day, system\)/);
    expect(read('../../components/calendar/AgendaView.tsx')).toMatch(/dayNumberLabel\(date, system\)/);
  });
});
