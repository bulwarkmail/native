import { format, parseISO } from 'date-fns';
import type { CalendarEvent } from '../api/types';
import {
  buildAllDayDuration,
  getEventDisplayEndDate,
  getEventEndDate,
  getEventStartDate,
  parseDuration,
} from './calendar-utils';
import {
  formatWallClock,
  fromDisplayDate,
  getEffectiveTimeZone,
  getWallClock,
  isValidTimeZone,
  localDateTimeToInstant,
} from './calendar-timezone';

// The event editor's times and what they save as. The editor shows and
// edits display dates (calendar-timezone): wall clocks in the calendar's time
// zone, like the grid and the detail sheet. Saving turns them back into the
// event's own start / duration / zone. A time the user did not touch is
// written back exactly as it came, so opening and saving an event never
// moves it, whatever the device zone, the calendar zone or a DST change in
// between.

/** What the editor shows. `end` is the inclusive last day of an all-day event. */
export interface EditorTimes {
  allDay: boolean;
  start: Date;
  end: Date;
}

export function editorTimesFromEvent(event: CalendarEvent): EditorTimes {
  return {
    allDay: !!event.showWithoutTime,
    start: getEventStartDate(event),
    // All-day events store an exclusive end (start + P1D = next day 00:00);
    // the editor works with the inclusive last day, otherwise every re-save
    // grows the event by one day.
    end: event.showWithoutTime ? getEventDisplayEndDate(event) : getEventEndDate(event),
  };
}

export type EventTimeFields = Pick<CalendarEvent, 'start' | 'duration' | 'timeZone' | 'showWithoutTime'>;

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

function formatDuration(days: number, minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  let dur = 'P';
  if (days > 0) dur += `${days}D`;
  if (hours > 0 || mins > 0) {
    dur += 'T';
    if (hours > 0) dur += `${hours}H`;
    if (mins > 0) dur += `${mins}M`;
  }
  return dur === 'P' ? 'PT0M' : dur;
}

/**
 * The JSCalendar duration from `start` to `end` for an event in `timeZone`.
 * Whole days are calendar days in that zone (RFC 8984 adds them nominally,
 * so a day across a DST change is 23 or 25 hours), the rest is exact time.
 */
export function durationBetween(start: Date, end: Date, timeZone: string): string {
  const totalMinutes = Math.max(0, Math.floor((end.getTime() - start.getTime()) / 60000));
  if (totalMinutes < 24 * 60) return formatDuration(0, totalMinutes);
  const s = getWallClock(start, timeZone);
  const e = getWallClock(end, timeZone);
  let days = Math.round(
    (Date.UTC(e.year, e.month - 1, e.day) - Date.UTC(s.year, s.month - 1, s.day)) / 86_400_000,
  );
  const startSecond = s.hour * 3600 + s.minute * 60 + s.second;
  const endSecond = e.hour * 3600 + e.minute * 60 + e.second;
  if (endSecond < startSecond) days -= 1;
  const anchorDay = new Date(Date.UTC(s.year, s.month - 1, s.day + days));
  const anchor = localDateTimeToInstant(
    `${pad(anchorDay.getUTCFullYear(), 4)}-${pad(anchorDay.getUTCMonth() + 1)}-${pad(anchorDay.getUTCDate())}`
      + `T${pad(s.hour)}:${pad(s.minute)}:${pad(s.second)}`,
    timeZone,
  );
  if (!anchor) return formatDuration(0, totalMinutes);
  const rest = Math.max(0, Math.floor((end.getTime() - anchor.getTime()) / 60000));
  return formatDuration(Math.max(0, days), rest);
}

/** The real instant an event starts at. */
function startInstantOf(event: CalendarEvent, zone: string): Date {
  if (event.utcStart) {
    const utc = parseISO(event.utcStart);
    if (!isNaN(utc.getTime())) return utc;
  }
  return localDateTimeToInstant(event.start, event.timeZone || zone)
    ?? fromDisplayDate(parseISO(event.start));
}

/** The real instant an event ends at. */
function endInstantOf(event: CalendarEvent, zone: string): Date {
  if (event.utcEnd) {
    const utc = parseISO(event.utcEnd);
    if (!isNaN(utc.getTime())) return utc;
  }
  return new Date(startInstantOf(event, zone).getTime() + parseDuration(event.duration));
}

/**
 * The start / duration / time zone to save for the editor's `times`.
 * `event` is the event being edited (absent for a new one).
 *
 * - A start or end the user left alone is kept as stored: an unchanged
 *   event saves its own start, duration and zone.
 * - A changed time is converted from the calendar's zone into the zone the
 *   event lives in, so a New York meeting edited from a Berlin calendar
 *   stays a New York meeting. New, floating and formerly all-day events
 *   take the calendar's zone.
 */
export function eventTimeFieldsToSave(times: EditorTimes, event?: CalendarEvent | null): EventTimeFields {
  const seed = event ? editorTimesFromEvent(event) : null;
  const sameKind = !!seed && seed.allDay === times.allDay;
  const startSame = sameKind && seed!.start.getTime() === times.start.getTime();
  const endSame = sameKind && seed!.end.getTime() === times.end.getTime();

  if (times.allDay) {
    if (event && startSame && endSame) {
      return { start: event.start, duration: event.duration, timeZone: null, showWithoutTime: true };
    }
    return {
      start: format(times.start, "yyyy-MM-dd'T'00:00:00"),
      duration: buildAllDayDuration(times.start, times.end),
      timeZone: null,
      showWithoutTime: true,
    };
  }

  const showWithoutTime = event ? false : undefined;
  if (event && startSame && endSame) {
    return { start: event.start, duration: event.duration, timeZone: event.timeZone, showWithoutTime };
  }
  const calendarZone = getEffectiveTimeZone();
  const ownZone = event && !event.showWithoutTime && isValidTimeZone(event.timeZone) ? event.timeZone : null;
  const zone = ownZone ?? calendarZone;
  const startInstant = startSame ? startInstantOf(event!, calendarZone) : fromDisplayDate(times.start);
  const endInstant = endSame ? endInstantOf(event!, calendarZone) : fromDisplayDate(times.end);
  if (startSame) {
    // Only the end moved: the start (and a floating start's missing zone)
    // stays as stored.
    return {
      start: event!.start,
      duration: durationBetween(startInstant, endInstant, event!.timeZone || calendarZone),
      timeZone: event!.timeZone,
      showWithoutTime,
    };
  }
  return {
    start: formatWallClock(startInstant, zone),
    duration: durationBetween(startInstant, endInstant, zone),
    timeZone: zone,
    showWithoutTime,
  };
}
