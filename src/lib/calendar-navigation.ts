import { addDays, addMonths, addWeeks, subMonths, subWeeks } from 'date-fns';

export type CalendarViewMode = 'month' | 'week' | 'agenda';

export const AGENDA_DAYS = 30;

export function shiftViewDate(
  viewMode: CalendarViewMode,
  date: Date,
  delta: -1 | 1,
): Date {
  if (viewMode === 'month') return delta < 0 ? subMonths(date, 1) : addMonths(date, 1);
  if (viewMode === 'week') return delta < 0 ? subWeeks(date, 1) : addWeeks(date, 1);
  return addDays(date, delta * AGENDA_DAYS);
}

/**
 * Prev/next in week and agenda view moves the visible period and the
 * selected day together. Month view only moves the displayed month: the
 * highlighted day stays, matching a tap in the month grid.
 */
export function applyCalendarNavigation(
  viewMode: CalendarViewMode,
  currentDate: Date,
  selectedDate: Date,
  delta: -1 | 1,
): { currentDate: Date; selectedDate: Date } {
  const nextCurrent = shiftViewDate(viewMode, currentDate, delta);
  if (viewMode === 'week' || viewMode === 'agenda') {
    return { currentDate: nextCurrent, selectedDate: nextCurrent };
  }
  return { currentDate: nextCurrent, selectedDate };
}
