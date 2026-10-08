import { useMemo } from 'react';
import { useSettingsStore } from '../stores/settings-store';
import type { DateRegion } from './date-format';

/**
 * The date format region and the app-wide time zone, for the date
 * formatters. The zone is stored as `calendarTimeZone` (synced as the
 * webmail's `timeZone`) and covers mail as well as the calendar.
 */
export function useDateRegion(): DateRegion {
  const dateLocale = useSettingsStore((s) => s.dateLocale);
  const timeZone = useSettingsStore((s) => s.calendarTimeZone);
  return useMemo(() => ({ dateLocale, timeZone }), [dateLocale, timeZone]);
}
