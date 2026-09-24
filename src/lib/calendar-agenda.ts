import type { CalendarEvent } from '../api/types';
import { dayKey, type EventDayIndex } from './calendar-utils';
import { parseDayKey, type DayRange } from './calendar-scroll-window';

export interface AgendaDay {
  date: Date;
  data: CalendarEvent[];
}

/**
 * The agenda's rows: every day inside the loaded range that has events, in
 * order, plus an empty "Today" anchor when today lies inside it. Days that
 * were never fetched get no row, so the list never claims they are empty
 * (webmail's infinite agenda, 60e05c00).
 */
export function buildAgendaDays(
  index: EventDayIndex,
  loaded: DayRange | null,
  now: Date,
): AgendaDay[] {
  if (!loaded) return [];
  const startKey = dayKey(loaded.start);
  const endKey = dayKey(loaded.end);
  // yyyy-MM-dd keys sort like the days they name.
  const keys: string[] = [];
  for (const key of index.keys()) {
    if (key >= startKey && key <= endKey) keys.push(key);
  }
  const todayKey = dayKey(now);
  if (todayKey >= startKey && todayKey <= endKey && !index.has(todayKey)) keys.push(todayKey);
  keys.sort();
  // Buckets are pre-sorted by buildEventDayIndex (all-day first, then by
  // start, then title).
  return keys.map((key) => ({ date: parseDayKey(key), data: index.get(key) ?? [] }));
}

/** The row the agenda scrolls to for a navigation: the first day at or after `focus`. */
export function findAgendaFocusIndex(days: ReadonlyArray<{ date: Date }>, focus: Date): number {
  const key = dayKey(focus);
  return days.findIndex((day) => dayKey(day.date) >= key);
}
