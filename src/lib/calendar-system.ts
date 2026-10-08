import {
  addDays,
  addMonths,
  endOfMonth,
  endOfWeek,
  format,
  startOfDay,
  startOfMonth,
  startOfWeek,
  type Locale,
} from 'date-fns';
import {
  JALALI_MONTHS,
  jalaliMonthLength,
  shouldUseJalaliCalendar,
  toGregorian,
  toJalali,
} from './jalali-utils';

/**
 * The calendar the month grid is laid out in (webmail useCalendarLocale).
 * Dates stay Gregorian `Date`s everywhere; only which days make up a month,
 * the day numbers and the month names change. Persian uses the Jalali
 * calendar; every other language the Gregorian one.
 */
export interface CalendarSystem {
  kind: 'gregorian' | 'jalali';
  /** First day of the month containing `d`, at local midnight. */
  monthStart(d: Date): Date;
  /** Last day of the month containing `d`, at local midnight. */
  monthEnd(d: Date): Date;
  /** `n` months from `d`. Jalali lands on the 1st of the target month. */
  addMonths(d: Date, n: number): Date;
  /** Year and month as one comparable number: `year * 12 + monthIndex`. */
  monthKey(d: Date): number;
  dayOfMonth(d: Date): number;
  isFirstOfMonth(d: Date): boolean;
  /** "October 2026" / "مهر 1405". */
  monthYearLabel(d: Date, locale: Locale): string;
  /** The month's name where a grid row marks the start of a month. */
  shortMonthLabel(d: Date, locale: Locale): string;
}

export const GREGORIAN: CalendarSystem = {
  kind: 'gregorian',
  monthStart: (d) => startOfMonth(d),
  monthEnd: (d) => startOfDay(endOfMonth(d)),
  addMonths: (d, n) => addMonths(d, n),
  monthKey: (d) => d.getFullYear() * 12 + d.getMonth(),
  dayOfMonth: (d) => d.getDate(),
  isFirstOfMonth: (d) => d.getDate() === 1,
  monthYearLabel: (d, locale) => format(d, 'MMMM yyyy', { locale }),
  shortMonthLabel: (d, locale) => format(d, 'MMM', { locale }),
};

// Webmail steps Jalali months with Gregorian addMonths, which can land in
// the same or the next-but-one Jalali month near month ends (they start
// around the 20th–22nd). Counting in Jalali months and landing on the 1st
// steps exactly one month at a time.
export const JALALI: CalendarSystem = {
  kind: 'jalali',
  monthStart: (d) => {
    const { jy, jm } = toJalali(d);
    return toGregorian(jy, jm, 1);
  },
  monthEnd: (d) => {
    const { jy, jm } = toJalali(d);
    return toGregorian(jy, jm, jalaliMonthLength(jy, jm));
  },
  addMonths: (d, n) => {
    const { jy, jm } = toJalali(d);
    const index = jy * 12 + (jm - 1) + n;
    return toGregorian(Math.floor(index / 12), (((index % 12) + 12) % 12) + 1, 1);
  },
  monthKey: (d) => {
    const { jy, jm } = toJalali(d);
    return jy * 12 + (jm - 1);
  },
  dayOfMonth: (d) => toJalali(d).jd,
  isFirstOfMonth: (d) => toJalali(d).jd === 1,
  monthYearLabel: (d) => {
    const { jy, jm } = toJalali(d);
    return `${JALALI_MONTHS[jm - 1]} ${jy}`;
  },
  // The full name: cutting Persian month names short leaves broken words,
  // and they are short enough for the label.
  shortMonthLabel: (d) => JALALI_MONTHS[toJalali(d).jm - 1],
};

export function calendarSystemFor(localeCode: string): CalendarSystem {
  return shouldUseJalaliCalendar(localeCode) ? JALALI : GREGORIAN;
}

/**
 * The calendar header's title: the month, the week's range or the day.
 * `firstDay` is the first day a freely scrolled week view shows.
 */
export function headerTitleFor(
  viewMode: 'month' | 'week' | 'day' | 'agenda',
  currentDate: Date,
  weekStartsOn: 0 | 1 | 6,
  locale: Locale,
  calendar: CalendarSystem,
  firstDay?: Date | null,
): string {
  const jalali = calendar.kind === 'jalali';
  if (viewMode === 'day') {
    if (jalali) {
      // Webmail formatFullDate: weekday, day, month, year.
      const { jy, jm, jd } = toJalali(currentDate);
      return `${format(currentDate, 'EEEE', { locale })} ${jd} ${JALALI_MONTHS[jm - 1]} ${jy}`;
    }
    return format(currentDate, 'EEE, MMM d, yyyy', { locale });
  }
  if (viewMode === 'week') {
    const start = firstDay ?? startOfWeek(currentDate, { weekStartsOn });
    const end = firstDay ? addDays(firstDay, 6) : endOfWeek(currentDate, { weekStartsOn });
    if (jalali) {
      // Webmail formatWeekRange: "4 – 10 Mehr 1405", "28 Shahrivar – 3 Mehr 1405".
      const s = toJalali(start);
      const e = toJalali(end);
      if (s.jy === e.jy && s.jm === e.jm) {
        return `${s.jd} – ${e.jd} ${JALALI_MONTHS[s.jm - 1]} ${s.jy}`;
      }
      return `${s.jd} ${JALALI_MONTHS[s.jm - 1]} – ${e.jd} ${JALALI_MONTHS[e.jm - 1]} ${e.jy}`;
    }
    if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
      return `${format(start, 'MMM d', { locale })} – ${format(end, 'd, yyyy', { locale })}`;
    }
    return `${format(start, 'MMM d', { locale })} – ${format(end, 'MMM d, yyyy', { locale })}`;
  }
  return calendar.monthYearLabel(currentDate, locale);
}
