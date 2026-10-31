import { addDays, differenceInCalendarDays, startOfDay, startOfWeek } from 'date-fns';
import type { CalendarEvent } from '../api/types';
import {
  buildTimedFullDayWeekSegments,
  buildWeekSegmentsRaw,
  eventsOnDayFromIndex,
  packWeekSegments,
  type CalendarWeekSegment,
  type EventDayIndex,
} from './calendar-utils';
import type { DayRange, WeekStartsOn } from './calendar-scroll-window';

/**
 * Geometry of the freely scrolling week and day grids (#759, webmail
 * calendar-week-view / calendar-day-view): one column per day of the
 * window, scrolling sideways and snapping to whole days.
 */

export type TimeGridMode = 'week' | '3day' | 'day';

/**
 * Days the multi-day view ("3 days" on a phone) shows for a window `width`
 * wide: three on a phone, five on a medium window, a full seven-day strip
 * on a wide one, so the extra width buys days rather than wider columns.
 */
export function multiDayCount(width: number): number {
  return width >= 840 ? 7 : width >= 600 ? 5 : 3;
}

/** Day columns on one screen. */
export function columnsPerScreen(mode: TimeGridMode, multiDays = 3): number {
  return mode === 'week' ? 7 : mode === '3day' ? multiDays : 1;
}

/** Every day of the window, in order. */
export function windowDays(window: DayRange): Date[] {
  const count = differenceInCalendarDays(window.end, window.start) + 1;
  const days: Date[] = [];
  for (let i = 0; i < count; i++) days.push(addDays(window.start, i));
  return days;
}

/**
 * The column navigation aligns with the start of the viewport: the focused
 * week's first day in the week view, the focused day in the day and
 * three-day views.
 */
export function timeGridFocusColumn(
  window: DayRange,
  date: Date,
  mode: TimeGridMode,
  weekStartsOn: WeekStartsOn,
  columnCount: number,
): number {
  const target = mode === 'week' ? startOfWeek(date, { weekStartsOn }) : startOfDay(date);
  const index = differenceInCalendarDays(target, window.start);
  return Math.max(0, Math.min(columnCount - 1, index));
}

/**
 * The columns whose header cells are drawn: the ones on screen plus two
 * screens either side, so a fling doesn't outrun them.
 */
export function headerColumnRange(
  firstVisible: number,
  perScreen: number,
  columnCount: number,
): { from: number; to: number } {
  const margin = perScreen * 2;
  return {
    from: Math.max(0, firstVisible - margin),
    to: Math.min(columnCount - 1, firstVisible + perScreen - 1 + margin),
  };
}

/**
 * The all-day strip over the window: all-day events plus timed events that
 * fill whole days, as bars packed into rows. Bars are cut at every
 * `chunkSize` days (a week, or a day in the day view) so each part carries
 * its title where it is on screen. Only events found in the day index for
 * these days are considered.
 */
export function buildAllDaySegments(
  index: EventDayIndex,
  days: Date[],
  chunkSize: number,
): CalendarWeekSegment[] {
  const raw: CalendarWeekSegment[] = [];
  const size = Math.max(1, Math.floor(chunkSize));
  for (let from = 0; from < days.length; from += size) {
    const chunk = days.slice(from, from + size);
    const seen = new Set<string>();
    const allDay: CalendarEvent[] = [];
    const timed: CalendarEvent[] = [];
    for (const day of chunk) {
      for (const event of eventsOnDayFromIndex(index, day)) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        (event.showWithoutTime ? allDay : timed).push(event);
      }
    }
    for (const segment of [...buildWeekSegmentsRaw(allDay, chunk), ...buildTimedFullDayWeekSegments(timed, chunk)]) {
      raw.push({ ...segment, startIndex: segment.startIndex + from });
    }
  }
  return packAllDaySegments(raw);
}

/** The id prefix CalendarScreen gives the due tasks it draws on the grid. */
export const TASK_CHIP_ID_PREFIX = 'task:';

/**
 * Packs the all-day bars into rows, with each day's task chips stacked under
 * that day's all-day events rather than packed in among them (webmail
 * calendar-week-view, #1107, #1270, #1122).
 */
export function packAllDaySegments(raw: CalendarWeekSegment[]): CalendarWeekSegment[] {
  const isTask = (s: CalendarWeekSegment) => s.event.id.startsWith(TASK_CHIP_ID_PREFIX);
  const events = packWeekSegments(raw.filter((s) => !isTask(s)));
  const tasks = raw.filter(isTask).sort((a, b) =>
    a.startIndex - b.startIndex || (a.event.title || '').localeCompare(b.event.title || ''));
  if (tasks.length === 0) return events;
  // Each day's next free row: under every event bar that covers it, then
  // under the tasks already put there.
  const nextRow = new Map<number, number>();
  const rowAt = (index: number) => {
    let row = nextRow.get(index);
    if (row === undefined) {
      row = events.reduce(
        (max, s) => (index >= s.startIndex && index < s.startIndex + s.span ? Math.max(max, s.row + 1) : max),
        0,
      );
    }
    return row;
  };
  const stacked = tasks.map((task) => {
    // A task covers one day; a longer one stacks under every day it covers.
    let row = 0;
    for (let i = task.startIndex; i < task.startIndex + task.span; i++) row = Math.max(row, rowAt(i));
    for (let i = task.startIndex; i < task.startIndex + task.span; i++) nextRow.set(i, row + 1);
    return { ...task, row };
  });
  return [...events, ...stacked];
}

/**
 * Rows the all-day area needs for the columns `first`..`last` in view: a
 * crowded day elsewhere in the window adds no empty rows here (webmail
 * #1293).
 */
export function allDayRowsInView(segments: CalendarWeekSegment[], first: number, last: number): number {
  let rows = 0;
  for (const s of segments) {
    if (s.startIndex <= last && s.startIndex + s.span - 1 >= first) rows = Math.max(rows, s.row + 1);
  }
  return rows;
}

/** The all-day area shows this many rows until it is expanded (webmail DEFAULT_ALL_DAY_MAX_ROWS). */
export const ALL_DAY_COLLAPSED_ROWS = 3;

/** Rows drawn: all of them when expanded or few enough, else the collapsed three. */
export function shownAllDayRows(rows: number, expanded: boolean): number {
  return expanded ? rows : Math.min(rows, ALL_DAY_COLLAPSED_ROWS);
}

/** The hour a long press at `offsetY` in a day column lands on. */
export function hourAtOffset(offsetY: number, hourHeight: number): number {
  return Math.max(0, Math.min(23, Math.floor(offsetY / hourHeight)));
}
