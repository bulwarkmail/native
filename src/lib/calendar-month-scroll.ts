import { addDays, differenceInCalendarDays } from 'date-fns';
import { baseRange, type DayRange, type ScrollWindowOptions } from './calendar-scroll-window';
import { GREGORIAN, type CalendarSystem } from './calendar-system';
import { CHROME_MAX_FONT_SCALE, fontPx } from '../theme/tokens';

/**
 * Geometry of the freely scrolling month view (#759, webmail
 * calendar-month-view): one fixed-height row per week of the window.
 */

/**
 * Height of a week row with event chips (#666): 4px padding above and below,
 * the 36px day circle, 2px, then two chips (an 11px line and 1px padding
 * each, 1px apart) or one chip and a 10px "+N" line, and 1px to spare. The
 * lines follow the font size setting and, up to CHROME_MAX_FONT_SCALE (the
 * chip and "+N" Text cap it), the OS font scale, which Android applies to
 * lineHeight. Whole pixels, so every row and getItemLayout offset agree.
 * Call it in render, like fontPx.
 */
export function monthChipRowHeight(osFontScale: number): number {
  const scale = Math.min(Math.max(osFontScale, 1), CHROME_MAX_FONT_SCALE);
  const line = (px: number) => Math.ceil(fontPx(px) * scale);
  const chip = line(11) + 2;
  const chips = Math.max(2 * chip + 1, chip + 1 + line(10));
  return 4 + 36 + 2 + chips + 4 + 1;
}

/** Fraction of the viewport height at which the "current month" is sampled. */
export const VISIBLE_MONTH_SAMPLE = 0.4;

/** The first day of every week in the window (which is made of whole weeks). */
export function windowWeekStarts(window: DayRange): Date[] {
  const count = Math.floor(differenceInCalendarDays(window.end, window.start) / 7) + 1;
  const weeks: Date[] = [];
  for (let i = 0; i < count; i++) weeks.push(addDays(window.start, i * 7));
  return weeks;
}

/** The seven days of the week starting at `weekStart`. */
export function weekDays(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** Row of the week that starts `date`'s month grid: where navigation puts the top. */
export function monthFocusRow(
  window: DayRange,
  date: Date,
  rowCount: number,
  opts: ScrollWindowOptions,
): number {
  const gridStart = baseRange('month', date, opts).start;
  const row = Math.floor(differenceInCalendarDays(gridStart, window.start) / 7);
  return Math.max(0, Math.min(rowCount - 1, row));
}

/**
 * Where the list mounts (its `initialScrollIndex`, clamped to the rows it
 * has) and the scroll offset that row has at `rowHeight`. After a remount
 * for a new row height the old offset is in the old height's units, so it
 * is reset to this one until the list reports a scroll.
 */
export function monthMountPosition(row: number, rowHeight: number, rowCount: number): { row: number; offset: number } {
  const at = Math.max(0, Math.min(rowCount - 1, row));
  return { row: at, offset: at * rowHeight };
}

/** Row under the sample line for a scroll offset. */
export function sampledRow(
  offset: number,
  viewportHeight: number,
  rowHeight: number,
  rowCount: number,
  fraction = VISIBLE_MONTH_SAMPLE,
): number {
  if (rowCount <= 0 || rowHeight <= 0) return 0;
  const row = Math.floor((offset + viewportHeight * fraction) / rowHeight);
  return Math.max(0, Math.min(rowCount - 1, row));
}

/** Year and month as one comparable number, in `calendar` (Gregorian by default). */
export function monthKeyOf(date: Date, calendar: CalendarSystem = GREGORIAN): number {
  return calendar.monthKey(date);
}

/**
 * Bit i is set when day i of the week belongs to the month `monthKey`. Rows
 * compare this instead of the month itself, so moving to another month only
 * re-renders the rows whose shading changes.
 */
export function monthMask(
  days: Date[],
  monthKey: number,
  calendar: CalendarSystem = GREGORIAN,
): number {
  let mask = 0;
  days.forEach((day, i) => {
    if (monthKeyOf(day, calendar) === monthKey) mask |= 1 << i;
  });
  return mask;
}

/** Index of `date` in `days` (same calendar day), or -1. */
export function dayIndexIn(days: Date[], date: Date): number {
  if (days.length === 0) return -1;
  const diff = differenceInCalendarDays(date, days[0]);
  return diff >= 0 && diff < days.length ? diff : -1;
}
