/**
 * Jalali (Persian/Shamsi) calendar utilities (webmail lib/jalali-utils).
 *
 * All internal date handling remains Gregorian. The functions in this
 * module convert Gregorian ↔ Jalali at the display layer only.
 *
 * Uses `jalaali-js` for the calendar math: plain arithmetic, so it behaves
 * the same on Hermes, whose Intl support for the Persian calendar is too
 * uneven to rely on.
 */
import * as jalaali from 'jalaali-js';

/** A Jalali date represented as year, month (1-12), day (1-31). */
export interface JalaliDate {
  /** Jalali year (e.g. 1405) */
  jy: number;
  /** Jalali month (1 = Farvardin, 12 = Esfand) */
  jm: number;
  /** Jalali day of month (1-31) */
  jd: number;
}

/** Convert a Gregorian Date (its local day) to its Jalali equivalent. */
export function toJalali(date: Date): JalaliDate {
  const { jy, jm, jd } = jalaali.toJalaali(date);
  return { jy, jm, jd };
}

/** Convert a Jalali date to a Gregorian Date at local midnight. */
export function toGregorian(jy: number, jm: number, jd: number): Date {
  const { gy, gm, gd } = jalaali.toGregorian(jy, jm, jd);
  return new Date(gy, gm - 1, gd);
}

/** Full Persian month names (Farvardin … Esfand). */
export const JALALI_MONTHS: readonly string[] = [
  'فروردین',
  'اردیبهشت',
  'خرداد',
  'تیر',
  'مرداد',
  'شهریور',
  'مهر',
  'آبان',
  'آذر',
  'دی',
  'بهمن',
  'اسفند',
];

/** Number of days in a Jalali month (handles leap years). */
export function jalaliMonthLength(jy: number, jm: number): number {
  return jalaali.jalaaliMonthLength(jy, jm);
}

/** Is the given Jalali year a leap year? */
export function isJalaliLeapYear(jy: number): boolean {
  return jalaali.isLeapJalaaliYear(jy);
}

/**
 * The first day of the month grid for a Jalali month: the 1st of the month,
 * moved back to the start of its week. `weekStartsOn` follows date-fns:
 * 0=Sun, 1=Mon, …, 6=Sat.
 */
export function startOfJalaliMonth(jy: number, jm: number, weekStartsOn: number = 6): Date {
  const firstDay = toGregorian(jy, jm, 1);
  const offset = (firstDay.getDay() - weekStartsOn + 7) % 7;
  // Stepping by calendar day keeps local midnight across DST changes.
  return new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate() - offset);
}

/** The last day of the month grid for a Jalali month (end of its last week). */
export function endOfJalaliMonth(jy: number, jm: number, weekStartsOn: number = 6): Date {
  const lastDay = toGregorian(jy, jm, jalaliMonthLength(jy, jm));
  const offset = (weekStartsOn - lastDay.getDay() + 6) % 7;
  return new Date(lastDay.getFullYear(), lastDay.getMonth(), lastDay.getDate() + offset);
}

/** Every day of a Jalali month's grid, from its first week's start to its last week's end. */
export function eachDayOfJalaliMonth(jy: number, jm: number, weekStartsOn: number = 6): Date[] {
  const start = startOfJalaliMonth(jy, jm, weekStartsOn);
  const end = endOfJalaliMonth(jy, jm, weekStartsOn);
  const days: Date[] = [];
  for (
    let cursor = start;
    cursor <= end;
    cursor = new Date(cursor.getFullYear(), cursor.getMonth(), cursor.getDate() + 1)
  ) {
    days.push(cursor);
  }
  return days;
}

/** Should the calendar render with the Jalali calendar? Keyed off the `fa` UI language, as in webmail. */
export function shouldUseJalaliCalendar(locale: string): boolean {
  return locale === 'fa';
}
