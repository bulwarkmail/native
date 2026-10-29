import { addDays, differenceInCalendarDays } from 'date-fns';
import { baseRange, type DayRange, type ScrollWindowOptions } from './calendar-scroll-window';

/**
 * Geometry of the freely scrolling month view (#759, webmail
 * calendar-month-view): one fixed-height row per week of the window.
 */

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
 * Row height and number of whole rows for a month grid of `height`. Six
 * weeks fill the space when they fit at `minRow` or taller; a short window
 * (a phone in landscape) shows fewer, taller-than-minimum rows instead of
 * six rows that run off the bottom.
 */
export function monthRowGeometry(
  height: number,
  minRow: number,
  maxRows = 6,
): { rowHeight: number; visibleRows: number } {
  if (height <= 0 || minRow <= 0) return { rowHeight: minRow, visibleRows: maxRows };
  const visibleRows = Math.max(1, Math.min(maxRows, Math.floor(height / minRow)));
  return { rowHeight: Math.floor(height / visibleRows), visibleRows };
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

/** Year and month as one comparable number. */
export function monthKeyOf(date: Date): number {
  return date.getFullYear() * 12 + date.getMonth();
}

/**
 * Bit i is set when day i of the week belongs to the month `monthKey`. Rows
 * compare this instead of the month itself, so moving to another month only
 * re-renders the rows whose shading changes.
 */
export function monthMask(days: Date[], monthKey: number): number {
  let mask = 0;
  days.forEach((day, i) => {
    if (monthKeyOf(day) === monthKey) mask |= 1 << i;
  });
  return mask;
}

/** Index of `date` in `days` (same calendar day), or -1. */
export function dayIndexIn(days: Date[], date: Date): number {
  if (days.length === 0) return -1;
  const diff = differenceInCalendarDays(date, days[0]);
  return diff >= 0 && diff < days.length ? diff : -1;
}

// Below this cell width a start time fills the whole chip and the title never
// shows, as on a phone in portrait (about 58 dp, less at a larger font).
const MIN_CELL_WIDTH_FOR_TIME = 80;

/** Whether a full month cell of about `cellWidth` dp puts the start time before the title. */
export function monthChipShowsTime(showTimeSetting: boolean, cellWidth: number): boolean {
  return showTimeSetting && cellWidth >= MIN_CELL_WIDTH_FOR_TIME;
}
