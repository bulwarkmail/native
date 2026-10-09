import type { CalendarViewTarget } from '../navigation/pending-calendar-open';
import { dayKey } from './calendar-utils';

/**
 * What "View in calendar" on an invitation parks for the Calendar tab: the
 * day of its start, read in the calendar's time zone (`start` is a display
 * date, as getEventStartDate gives it). Only a date, never an event id: the
 * Calendar tab shows the account that is shown when it reads the target, and
 * a date names nothing in any account. Null when the start is unknown or the
 * message's account is no longer the one shown, so another account's
 * calendar is never opened for it.
 */
export function invitationViewTarget(
  start: Date | null,
  bannerAppAccountId: string | null,
  shownAppAccountId: string | null,
): CalendarViewTarget | null {
  if (!start || isNaN(start.getTime())) return null;
  if (!bannerAppAccountId || bannerAppAccountId !== shownAppAccountId) return null;
  return { date: dayKey(start) };
}
