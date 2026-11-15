import { addDays, startOfDay, startOfWeek } from 'date-fns';
import { monthGridRange, type CalendarSystem } from './calendar-system';
import type { DayRange, WeekStartsOn } from './calendar-scroll-window';

/**
 * Where the "+" button starts a new event (#139): on a day the view shows,
 * not on a selection that was scrolled off screen.
 */

export type NewEventViewMode = 'month' | 'week' | '3day' | 'day' | 'agenda';

export interface ShownDays {
  /** Every day on screen. */
  range: DayRange;
  /** The day an event starts on when the selected one is not among them. */
  first: Date;
}

/** The latest start that the editor's rounding keeps on the same day. */
const LAST_START_MINUTES = 23 * 60 + 30;

/**
 * The days a view has on screen, from the day its title follows (`shown`:
 * the day scrolled to, else the focused one). The scrolling month passes
 * the rows it last reported (`monthRows`); they count while they hold a
 * day of `shown`'s month, so rows left behind by navigation are ignored. The schedule has
 * no such period and gives none.
 */
export function shownDays(
  mode: NewEventViewMode,
  shown: Date,
  scrolled: boolean,
  opts: {
    multiDays: number;
    weekStartsOn: WeekStartsOn;
    calendarSystem: CalendarSystem;
    monthRows?: DayRange | null;
  },
): ShownDays | null {
  const day = startOfDay(shown);
  switch (mode) {
    case 'day':
      return { range: { start: day, end: day }, first: day };
    case '3day':
      return { range: { start: day, end: addDays(day, opts.multiDays - 1) }, first: day };
    case 'week': {
      // A scrolled week grid starts on any day; otherwise on the week's first.
      const start = scrolled ? day : startOfWeek(day, { weekStartsOn: opts.weekStartsOn });
      return { range: { start, end: addDays(start, 6) }, first: start };
    }
    case 'month': {
      const monthStart = opts.calendarSystem.startOfMonth(day);
      const monthEnd = opts.calendarSystem.lastDayOfMonth(day);
      const rows = opts.monthRows;
      const range =
        rows && startOfDay(rows.start) <= monthEnd && startOfDay(rows.end) >= monthStart
          ? { start: startOfDay(rows.start), end: startOfDay(rows.end) }
          : monthGridRange(day, opts.weekStartsOn, opts.calendarSystem);
      // The 1st of the month in the title, or its first day still on screen.
      return { range, first: monthStart >= range.start ? monthStart : range.start };
    }
    case 'agenda':
      return null;
  }
}

/**
 * The start the editor opens on: the selected day while it is on screen,
 * else the view's first day, at the time `now` reads. The editor rounds
 * that up to the next half hour, so a time after 23:30 is held there and
 * the event stays on its day.
 */
export function newEventStart(selected: Date, shown: ShownDays | null, now: Date): Date {
  const selectedDay = startOfDay(selected);
  const onScreen = !shown || (selectedDay >= shown.range.start && selectedDay <= shown.range.end);
  const start = new Date(onScreen ? selectedDay : shown.first);
  if (now.getHours() * 60 + now.getMinutes() >= LAST_START_MINUTES) start.setHours(23, 30, 0, 0);
  else start.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
  return start;
}
