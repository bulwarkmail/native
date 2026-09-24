import { addDays, differenceInCalendarDays, startOfDay, startOfWeek } from 'date-fns';
import type { CalendarEvent } from '../api/types';
import {
  buildWeekSegmentsRaw,
  eventsOnDayFromIndex,
  getEventEndDate,
  getEventStartDate,
  isTimedEventFullDayOnDate,
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

export type TimeGridMode = 'week' | 'day';

/** Every day of the window, in order. */
export function windowDays(window: DayRange): Date[] {
  const count = differenceInCalendarDays(window.end, window.start) + 1;
  const days: Date[] = [];
  for (let i = 0; i < count; i++) days.push(addDays(window.start, i));
  return days;
}

/**
 * The column navigation aligns with the start of the viewport: the focused
 * week's first day in the week view, the focused day in the day view.
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
 * Segments for timed events that fill whole days within `days`, which must
 * be consecutive. Same result as buildTimedFullDayWeekSegments (the same
 * isTimedEventFullDayOnDate test, so the strip and the timed grid agree on
 * every day, DST days included), but each event is only tested on the days
 * it spans instead of on every day: the scrolling grids hand in months of
 * days (#759).
 */
export function timedFullDaySegments(
  events: CalendarEvent[],
  days: Date[],
): CalendarWeekSegment[] {
  if (days.length === 0) return [];
  const firstDay = startOfDay(days[0]);
  const last = days.length - 1;
  const out: CalendarWeekSegment[] = [];
  const push = (event: CalendarEvent, from: number, to: number) => {
    out.push({
      event,
      startIndex: from,
      span: to - from + 1,
      row: -1,
      continuesBefore: isTimedEventFullDayOnDate(event, addDays(days[from], -1)),
      continuesAfter: isTimedEventFullDayOnDate(event, addDays(days[to], 1)),
    });
  };
  for (const event of events) {
    if (event.showWithoutTime) continue;
    const from = Math.max(0, differenceInCalendarDays(getEventStartDate(event), firstDay));
    const to = Math.min(last, differenceInCalendarDays(getEventEndDate(event), firstDay));
    if (!(from <= to)) continue;
    let runStart = -1;
    for (let i = from; i <= to; i++) {
      if (isTimedEventFullDayOnDate(event, days[i])) {
        if (runStart < 0) runStart = i;
      } else if (runStart >= 0) {
        push(event, runStart, i - 1);
        runStart = -1;
      }
    }
    if (runStart >= 0) push(event, runStart, to);
  }
  return out;
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
    for (const segment of [...buildWeekSegmentsRaw(allDay, chunk), ...timedFullDaySegments(timed, chunk)]) {
      raw.push({ ...segment, startIndex: segment.startIndex + from });
    }
  }
  return packWeekSegments(raw);
}

/** The hour a long press at `offsetY` in a day column lands on. */
export function hourAtOffset(offsetY: number, hourHeight: number): number {
  return Math.max(0, Math.min(23, Math.floor(offsetY / hourHeight)));
}
