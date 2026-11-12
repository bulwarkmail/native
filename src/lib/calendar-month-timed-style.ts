import { isSameDay } from 'date-fns';
import type { CalendarEvent } from '../api/types';
import { getEventEndDate, getEventStartDate } from './calendar-utils';

/**
 * How the month view draws an event with a start time (webmail #1449): a
 * filled bar like all-day events, its time and title in the calendar colour,
 * or a dot in the calendar colour before them. Same key and values as the
 * webmail's calendarMonthTimedEvents.
 */
export type MonthTimedEventStyle = 'bar' | 'text' | 'dot';
export const MONTH_TIMED_EVENT_STYLES: readonly MonthTimedEventStyle[] = ['bar', 'text', 'dot'];

/**
 * The look of one event in the month view: all-day and multi-day events
 * stay bars whatever the setting.
 */
export function monthEventLook(event: CalendarEvent, style: MonthTimedEventStyle | undefined): MonthTimedEventStyle {
  if (!style || style === 'bar' || event.showWithoutTime) return 'bar';
  // An end at the next midnight still ends on the start's day.
  const end = new Date(getEventEndDate(event).getTime() - 1);
  const start = getEventStartDate(event);
  return isSameDay(start, end < start ? start : end) ? style : 'bar';
}
