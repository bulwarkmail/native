import {
  addDays,
  differenceInCalendarDays,
  parseISO,
  startOfDay,
  subMilliseconds,
} from 'date-fns';
import type { Calendar, CalendarEvent } from '../api/types';
import { colors } from '../theme/tokens';

// ─── Duration ────────────────────────────────────────────
// Parse an ISO 8601 duration ("PT1H30M", "P2D", "PT45M") to milliseconds.
// Mobile's webmail equivalent lives in components/calendar/event-card; we
// inline it here so this lib has no UI deps.
export function parseDuration(iso: string | undefined): number {
  if (!iso) return 0;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(iso);
  if (!match) return 0;
  const [, d, h, m, s] = match;
  const days = d ? parseInt(d, 10) : 0;
  const hours = h ? parseInt(h, 10) : 0;
  const minutes = m ? parseInt(m, 10) : 0;
  const seconds = s ? parseFloat(s) : 0;
  return ((days * 24 + hours) * 3600 + minutes * 60 + seconds) * 1000;
}

// ─── Local-time parsing ──────────────────────────────────
// JSCalendar `start` strings are floating local time ("2026-04-20T09:00:00", no Z).
// Use parseISO so the returned Date represents the wall-clock value in local tz.
export function parseLocalDateTime(iso: string): Date {
  return parseISO(iso);
}

// ─── Event time-range ────────────────────────────────────
export function getEventStartDate(
  event: Pick<CalendarEvent, 'start' | 'utcStart' | 'showWithoutTime'>,
): Date {
  const source = !event.showWithoutTime && event.utcStart ? event.utcStart : event.start;
  return parseISO(source);
}

export function getEventEndDate(event: CalendarEvent): Date {
  if (!event.showWithoutTime && event.utcEnd) {
    return parseISO(event.utcEnd);
  }
  const start = getEventStartDate(event);
  if (!event.duration) return start;
  return new Date(start.getTime() + parseDuration(event.duration));
}

export function getEventDisplayEndDate(event: CalendarEvent): Date {
  const end = getEventEndDate(event);
  const start = getEventStartDate(event);
  if (!event.showWithoutTime || end.getTime() <= start.getTime()) {
    return end;
  }
  return subMilliseconds(end, 1);
}

export interface EventTimeRange {
  start: Date;
  end: Date;
  allDay: boolean;
}

export function eventTimeRange(event: CalendarEvent): EventTimeRange {
  return {
    start: getEventStartDate(event),
    end: getEventEndDate(event),
    allDay: !!event.showWithoutTime,
  };
}

// ─── Day overlap ─────────────────────────────────────────
export function eventsOnDay(events: CalendarEvent[], day: Date): CalendarEvent[] {
  const dayStart = startOfDay(day);
  const nextDayStart = addDays(dayStart, 1);
  return events.filter((event) => {
    const start = getEventStartDate(event);
    const end = getEventDisplayEndDate(event);
    return end > dayStart && start < nextDayStart;
  });
}

// ─── Day index (O(1) per-day lookup) ─────────────────────
// A month view touches 42 day cells. Calling `eventsOnDay` on each cell costs
// O(days × events) with two parseISO calls per event per day. For ~200 events
// that's ~16k parseISO calls per month render, redone on every swipe.
// `buildEventDayIndex` parses each event's start/end once, then walks only the
// days that event actually touches — typically 1 day. Result is a map from
// local-date key (yyyy-MM-dd) to the events on that day.
export type EventDayIndex = Map<string, CalendarEvent[]>;

export function dayKey(day: Date): string {
  const y = day.getFullYear();
  const m = (day.getMonth() + 1).toString().padStart(2, '0');
  const d = day.getDate().toString().padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function buildEventDayIndex(events: CalendarEvent[]): EventDayIndex {
  const idx: EventDayIndex = new Map();
  for (const event of events) {
    const start = getEventStartDate(event);
    const end = getEventDisplayEndDate(event);
    let day = startOfDay(start);
    // Cap at 366 days: matches the original semantics (end > dayStart) — we
    // include day while day < end. Safety bound guards against malformed
    // multi-year events that would otherwise blow up the loop.
    let safety = 0;
    while (day < end && safety < 366) {
      const key = dayKey(day);
      const arr = idx.get(key);
      if (arr) arr.push(event);
      else idx.set(key, [event]);
      day = addDays(day, 1);
      safety++;
    }
  }
  return idx;
}

export function eventsOnDayFromIndex(
  index: EventDayIndex,
  day: Date,
): CalendarEvent[] {
  return index.get(dayKey(day)) ?? [];
}

export function getEventDayBounds(event: CalendarEvent): { startDay: Date; endDay: Date } {
  return {
    startDay: startOfDay(getEventStartDate(event)),
    endDay: startOfDay(getEventDisplayEndDate(event)),
  };
}

// ─── All-day duration helpers ────────────────────────────
export function normalizeAllDayDuration(duration: string | undefined): string | undefined {
  if (!duration) return undefined;
  const totalMs = parseDuration(duration);
  const totalDays = Math.max(1, Math.ceil(totalMs / (24 * 60 * 60 * 1000)));
  return `P${totalDays}D`;
}

export function buildAllDayDuration(start: Date, inclusiveEnd: Date): string {
  const dayCount = Math.max(
    1,
    differenceInCalendarDays(startOfDay(inclusiveEnd), startOfDay(start)) + 1,
  );
  return `P${dayCount}D`;
}

// ─── Per-day timed bounds (for week/day grids) ───────────
export interface TimedDayBounds {
  startMinutes: number;
  endMinutes: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export function getTimedEventBoundsForDay(
  event: CalendarEvent,
  day: Date,
): TimedDayBounds | null {
  if (event.showWithoutTime) return null;

  const eventStart = getEventStartDate(event);
  const eventEnd = getEventEndDate(event);
  const dayStart = startOfDay(day);
  const nextDayStart = addDays(dayStart, 1);

  if (eventEnd <= dayStart || eventStart >= nextDayStart) return null;

  const clippedStart = eventStart > dayStart ? eventStart : dayStart;
  const clippedEnd = eventEnd < nextDayStart ? eventEnd : nextDayStart;
  const startMinutes = Math.max(
    0,
    Math.floor((clippedStart.getTime() - dayStart.getTime()) / 60000),
  );
  const endMinutes = Math.min(
    1440,
    Math.ceil((clippedEnd.getTime() - dayStart.getTime()) / 60000),
  );

  return {
    startMinutes,
    endMinutes,
    continuesBefore: eventStart < dayStart,
    continuesAfter: eventEnd > nextDayStart,
  };
}

// ─── Overlapping event layout (column packing) ───────────
export interface TimedEventLayout {
  event: CalendarEvent;
  column: number;
  totalColumns: number;
  startMinutes: number;
  endMinutes: number;
  continuesBefore: boolean;
  continuesAfter: boolean;
}

export function layoutOverlappingEvents(
  events: CalendarEvent[],
  day: Date,
): TimedEventLayout[] {
  const layoutInputs = events.flatMap((event) => {
    const bounds = getTimedEventBoundsForDay(event, day);
    return bounds ? [{ event, ...bounds }] : [];
  });

  const sorted = layoutInputs.sort((a, b) => {
    const diff = a.startMinutes - b.startMinutes;
    if (diff !== 0) return diff;
    return b.endMinutes - b.startMinutes - (a.endMinutes - a.startMinutes);
  });

  const columns: { end: number }[][] = [];
  const result: TimedEventLayout[] = [];

  for (const item of sorted) {
    let placed = false;
    for (let col = 0; col < columns.length; col++) {
      if (columns[col].every((e) => e.end <= item.startMinutes)) {
        columns[col].push({ end: item.endMinutes });
        result.push({ ...item, column: col, totalColumns: 0 });
        placed = true;
        break;
      }
    }
    if (!placed) {
      columns.push([{ end: item.endMinutes }]);
      result.push({ ...item, column: columns.length - 1, totalColumns: 0 });
    }
  }

  const total = columns.length || 1;
  result.forEach((r) => {
    r.totalColumns = total;
  });
  return result;
}

// ─── Calendar color resolution ───────────────────────────
// Falls back to a deterministic palette slice when `color` is missing,
// mirroring webmail's behavior.
const CALENDAR_PALETTE = [
  colors.calendar.blue,
  colors.calendar.green,
  colors.calendar.purple,
  colors.calendar.orange,
  colors.calendar.red,
  colors.calendar.pink,
  colors.calendar.teal,
  colors.calendar.indigo,
] as const;

export const CALENDAR_COLOR_PALETTE = CALENDAR_PALETTE;

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function getCalendarColor(calendar: Pick<Calendar, 'id' | 'color'> | undefined): string {
  if (!calendar) return CALENDAR_PALETTE[0];
  if (calendar.color) return calendar.color;
  return CALENDAR_PALETTE[hashString(calendar.id) % CALENDAR_PALETTE.length];
}

export function getEventColor(
  event: Pick<CalendarEvent, 'calendarIds' | 'color'>,
  calendars: Calendar[],
): string {
  if (event.color) return event.color;
  const calendarId = Object.keys(event.calendarIds || {})[0];
  const cal = calendars.find((c) => c.id === calendarId);
  return getCalendarColor(cal);
}

export function getPrimaryCalendarId(
  event: Pick<CalendarEvent, 'calendarIds'>,
): string | undefined {
  return Object.keys(event.calendarIds || {})[0];
}
