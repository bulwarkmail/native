import { format, isSameDay } from 'date-fns';
import type { Locale } from 'date-fns';
import type { Calendar, CalendarEvent } from '../api/types';
import { getEventDisplayEndDate, getEventStartDate, getPrimaryCalendarId, timePattern } from './calendar-utils';
import { isDeclinedByUser } from './calendar-participants';
import { formatCalendarDay, monthTitle, type CalendarSystem } from './calendar-system';

type Translate = (key: string, fallback?: string, params?: Record<string, string | number>) => string;

// What a screen reader says for the calendar grid (webmail 0026abba4,
// 19e0acde9): a day cell by its full date and how many events it has, an
// event by its title, date, time, calendar and state.

/**
 * "October 2026, change month" for the header button that opens the month
 * panel: the month shown first, then what the button does. Not the
 * webmail's "Click to change month" (calendar.mini_calendar_change). The
 * year is always read, also where the header leaves it out (this year).
 */
export function monthButtonAccessibilityLabel(date: Date, system: CalendarSystem, locale: Locale, t: Translate): string {
  return t('calendar.change_month_named', '{month}, change month', { month: monthTitle(date, system, locale, true) });
}

/** The smallest touch target, in dp (WCAG 2.5.5, Android's 48 dp guideline rounded to Apple's 44 pt). */
export const MIN_TOUCH_TARGET = 44;

/** The hitSlop that grows an icon of `size` dp to a `target` dp touch area on every side. */
export function touchSlop(size: number, target: number = MIN_TOUCH_TARGET): number {
  return Math.max(0, Math.ceil((target - size) / 2));
}

/** "Remove Ana" for the cross on an invited participant's chip (webmail recipient_remove_named). */
export function participantRemoveAccessibilityLabel(attendee: { name?: string; email: string }, t: Translate): string {
  return t('calendar.participants.remove_named', 'Remove {name}', { name: attendee.name?.trim() || attendee.email });
}

/** "Monday, November 2, 2026, 3 events" for a month day cell. */
export function dayCellAccessibilityLabel(day: Date, eventCount: number, t: Translate, locale: Locale): string {
  const date = formatCalendarDay(day, locale, 'longWeekdayMonthDayYear');
  if (eventCount === 0) return date;
  return `${date}, ${t('calendar.a11y.event_count', '{count, plural, one {# event} other {# events}}', { count: eventCount })}`;
}

/** "Standup, Monday, November 2, 2026, 09:00 – 09:15, Work, Cancelled" for an event block. */
export function eventAccessibilityLabel(
  event: CalendarEvent,
  opts: {
    t: Translate;
    locale: Locale;
    timeFormat: '12h' | '24h' | undefined;
    calendars?: Pick<Calendar, 'id' | 'name'>[];
    currentUserEmails?: string[];
  },
): string {
  const { t, locale } = opts;
  const parts = [event.title || t('calendar.events.no_title', '(No title)')];
  const start = getEventStartDate(event);
  const end = getEventDisplayEndDate(event);
  const valid = (d: Date) => !isNaN(d.getTime());
  if (valid(start)) {
    const date = formatCalendarDay(start, locale, 'longWeekdayMonthDayYear');
    if (event.showWithoutTime) {
      const last = valid(end) && !isSameDay(start, end)
        ? ` – ${formatCalendarDay(end, locale, 'longWeekdayMonthDayYear')}`
        : '';
      parts.push(date + last, t('calendar.events.all_day', 'All day'));
    } else {
      const time = timePattern(opts.timeFormat);
      let range = format(start, time, { locale });
      if (valid(end) && end.getTime() > start.getTime()) {
        range += isSameDay(start, end)
          ? ` – ${format(end, time, { locale })}`
          : ` – ${formatCalendarDay(end, locale, 'longWeekdayMonthDayYear')} ${format(end, time, { locale })}`;
      }
      parts.push(date, range);
    }
  }
  const calendarId = getPrimaryCalendarId(event);
  const calendar = calendarId ? opts.calendars?.find((c) => c.id === calendarId) : undefined;
  if (calendar?.name) parts.push(calendar.name);
  if (event.status === 'cancelled') parts.push(t('calendar.detail.cancelled', 'Cancelled'));
  else if (isDeclinedByUser(event, opts.currentUserEmails)) parts.push(t('calendar.participants.declined', 'Declined'));
  return parts.join(', ');
}
