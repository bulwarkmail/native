import {
  addDays,
  addMonths as addGregorianMonths,
  endOfWeek,
  format,
  startOfDay,
  startOfWeek,
  type Locale,
} from 'date-fns';
import { JALALI_MONTHS, fromJalali, jalaliMonthLength, toJalali } from './jalali';
import { formatCalendarDate, type CalendarDateStyle } from './date-format';

// The calendar system the calendar's months, day numbers and headers follow:
// Gregorian, or Jalali for the Persian UI, as the webmail decides it
// (lib/jalali-utils.ts shouldUseJalaliCalendar, hooks/use-calendar-locale.ts).
// Dates stay Gregorian Dates everywhere; only what a month is, and how a day
// or a month is labelled, changes.

export type WeekStart = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export interface CalendarSystem {
  jalali: boolean;
  /** Local midnight of the first day of `date`'s month. */
  startOfMonth(date: Date): Date;
  /** Local midnight of the last day of `date`'s month. */
  lastDayOfMonth(date: Date): Date;
  /** The same day `n` months away, clamped to the end of a shorter month. */
  addMonths(date: Date, n: number): Date;
  /** Year and month as one comparable number. */
  monthKey(date: Date): number;
  /** Day of the month, 1-31. */
  dayOfMonth(date: Date): number;
  /** Month name, in the UI language (Persian names for Jalali). */
  monthName(date: Date, width: 'long' | 'short', locale: Locale): string;
  /** Year of `date`'s month. */
  year(date: Date): number;
}

export const gregorianCalendar: CalendarSystem = {
  jalali: false,
  startOfMonth: (date) => new Date(date.getFullYear(), date.getMonth(), 1),
  lastDayOfMonth: (date) => new Date(date.getFullYear(), date.getMonth() + 1, 0),
  addMonths: (date, n) => addGregorianMonths(date, n),
  monthKey: (date) => date.getFullYear() * 12 + date.getMonth(),
  dayOfMonth: (date) => date.getDate(),
  // The long name stands alone ("LLLL": some languages decline it inside a
  // date); the short one labels the 1st in a month grid.
  monthName: (date, width, locale) => format(date, width === 'long' ? 'LLLL' : 'MMM', { locale }),
  year: (date) => date.getFullYear(),
};

export const jalaliCalendar: CalendarSystem = {
  jalali: true,
  startOfMonth: (date) => {
    const { jy, jm } = toJalali(date);
    return fromJalali(jy, jm, 1);
  },
  lastDayOfMonth: (date) => {
    const { jy, jm } = toJalali(date);
    return fromJalali(jy, jm, jalaliMonthLength(jy, jm));
  },
  addMonths: (date, n) => {
    const { jy, jm, jd } = toJalali(date);
    const index = jy * 12 + (jm - 1) + n;
    const y = Math.floor(index / 12);
    const m = index - y * 12 + 1;
    const day = fromJalali(y, m, Math.min(jd, jalaliMonthLength(y, m)));
    // Keep the time of day, as date-fns addMonths does.
    day.setHours(date.getHours(), date.getMinutes(), date.getSeconds(), date.getMilliseconds());
    return day;
  },
  monthKey: (date) => {
    const { jy, jm } = toJalali(date);
    return jy * 12 + (jm - 1);
  },
  dayOfMonth: (date) => toJalali(date).jd,
  // The webmail shows the Persian names, and the first three letters on a
  // phone (formatMonthYearShort).
  monthName: (date, width) => {
    const name = JALALI_MONTHS[toJalali(date).jm - 1];
    return width === 'long' ? name : name.slice(0, 3);
  },
  year: (date) => toJalali(date).jy,
};

/** Whether the calendar shows Jalali dates: keyed off the Persian UI, as in the webmail. */
export function shouldUseJalaliCalendar(locale: string | null | undefined): boolean {
  return locale === 'fa';
}

export function calendarSystemFor(locale: string | null | undefined): CalendarSystem {
  return shouldUseJalaliCalendar(locale) ? jalaliCalendar : gregorianCalendar;
}

/** The days of `date`'s month grid: whole weeks from the one with the 1st to the one with the last day. */
export function monthGridRange(
  date: Date,
  weekStartsOn: WeekStart,
  system: CalendarSystem,
): { start: Date; end: Date } {
  return {
    start: startOfWeek(system.startOfMonth(date), { weekStartsOn }),
    end: startOfDay(endOfWeek(system.lastDayOfMonth(date), { weekStartsOn })),
  };
}

/** `date`'s month grid as rows of seven days. */
export function monthGridRows(date: Date, weekStartsOn: WeekStart, system: CalendarSystem): Date[][] {
  const { start, end } = monthGridRange(date, weekStartsOn, system);
  const rows: Date[][] = [];
  for (let day = start; day <= end; day = addDays(day, 7)) {
    rows.push(Array.from({ length: 7 }, (_, i) => addDays(day, i)));
  }
  return rows;
}

/** Whether `date` is the first day of its month. */
export function isFirstOfMonth(date: Date, system: CalendarSystem): boolean {
  return system.dayOfMonth(date) === 1;
}

/** "Mehr 1405" / "October 2026"; without the year when `withYear` is false. */
export function monthTitle(date: Date, system: CalendarSystem, locale: Locale, withYear: boolean): string {
  const name = system.monthName(date, 'long', locale);
  if (!withYear) return name;
  if (!system.jalali) return format(date, 'LLLL yyyy', { locale });
  return `${name} ${system.year(date)}`;
}

/** Day number and month of `date`, e.g. "9 Ordibehesht" or "Apr 29". */
export function shortDayLabel(date: Date, system: CalendarSystem, locale: Locale): string {
  if (!system.jalali) return format(date, 'MMM d', { locale });
  return `${system.dayOfMonth(date)} ${system.monthName(date, 'long', locale)}`;
}

/**
 * A date with weekday, day, month and year, e.g. "Wed, Apr 29, 2026", or
 * "چهارشنبه, 9 اردیبهشت 1405" for Jalali (webmail useFormatEventDate).
 */
export function fullDateLabel(date: Date, system: CalendarSystem, locale: Locale, gregorianPattern = 'EEE, PP'): string {
  if (!system.jalali) return format(date, gregorianPattern, { locale });
  const { jy, jm, jd } = toJalali(date);
  return `${format(date, 'EEEE', { locale })}, ${jd} ${JALALI_MONTHS[jm - 1]} ${jy}`;
}

/** "6 – 12 Mehr" / "Oct 6 – 12": the days a range of days covers. */
export function dayRangeLabel(start: Date, end: Date, system: CalendarSystem, locale: Locale): string {
  if (!system.jalali) {
    const sameMonth = start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear();
    return `${format(start, 'MMM d', { locale })} – ${format(end, sameMonth ? 'd' : 'MMM d', { locale })}`;
  }
  const a = toJalali(start);
  const b = toJalali(end);
  if (a.jy === b.jy && a.jm === b.jm) return `${a.jd} – ${b.jd} ${JALALI_MONTHS[a.jm - 1]}`;
  return `${a.jd} ${JALALI_MONTHS[a.jm - 1]} – ${b.jd} ${JALALI_MONTHS[b.jm - 1]}`;
}

/** A day's number in the grid: "29", or "9" for 9 Ordibehesht. */
export function dayNumberLabel(date: Date, system: CalendarSystem): string {
  return String(system.dayOfMonth(date));
}

/**
 * The label of a month's first day in a grid that runs through months:
 * "Oct" or "Oct 1"; the Persian month name, with "1" before it, for Jalali.
 */
export function monthStartLabel(date: Date, system: CalendarSystem, locale: Locale, withDay: boolean): string {
  if (!system.jalali) return format(date, withDay ? 'MMM d' : 'MMM', { locale });
  const name = system.monthName(date, 'long', locale);
  return withDay ? `${system.dayOfMonth(date)} ${name}` : name;
}

/** The calendar system of a date-fns locale: Jalali for Persian. */
export function calendarSystemOfLocale(locale: Locale): CalendarSystem {
  return calendarSystemFor(locale.code?.split('-')[0]);
}

/**
 * A calendar date in one of formatCalendarDate's styles. For Jalali, the
 * Persian weekday and month with the Jalali day and year, as the webmail's
 * useFormatEventDate writes them ("چهارشنبه, 9 اردیبهشت 1405").
 */
export function formatCalendarDay(date: Date, locale: Locale, style: CalendarDateStyle): string {
  const system = calendarSystemOfLocale(locale);
  if (!system.jalali) return formatCalendarDate(date, locale.code, style);
  const { jy, jm, jd } = toJalali(date);
  const month = JALALI_MONTHS[jm - 1];
  switch (style) {
    case 'longWeekdayMonthDayYear':
      return `${format(date, 'EEEE', { locale })}, ${jd} ${month} ${jy}`;
    case 'weekdayMonthDay':
      return `${format(date, 'EEEE', { locale })}, ${jd} ${month}`;
    case 'monthDay':
      return `${jd} ${month}`;
    case 'monthDayYear':
      return `${jd} ${month} ${jy}`;
  }
}
