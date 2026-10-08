/**
 * The IANA time zone the calendar works in.
 *
 * Timed events must be saved with a `timeZone` so other clients, CalDAV
 * syncs and invitees resolve the wall-clock correctly; a floating DTSTART
 * shifts whenever the viewer's zone differs from the author's. Mirrors the
 * webmail's lib/timezone.ts: the user's override when set (#755), otherwise
 * the device zone.
 */

import { useSettingsStore } from '../stores/settings-store';
import {
  fromZonedDisplayDate,
  getDeviceTimeZone,
  getWallClock,
  resolveTimeZone,
  toZonedDisplayDate,
} from './time-zone';

export {
  AUTO_TIME_ZONE,
  fromZonedDisplayDate,
  getDeviceTimeZone,
  getTimeZoneOffsetMs,
  getWallClock,
  isValidTimeZone,
  localDateTimeToInstant,
  resolveTimeZone,
  toZonedDisplayDate,
  type WallClock,
} from './time-zone';

/**
 * The zone the calendar shows and edits times in, new timed events are
 * saved in and JMAP queries are interpreted in.
 */
export function getEffectiveTimeZone(): string {
  let setting: string | null | undefined;
  try {
    setting = useSettingsStore.getState().calendarTimeZone;
  } catch {
    setting = undefined;
  }
  return resolveTimeZone(setting);
}

// ─── Display dates ───────────────────────────────────────
// The calendar's grid math, the pickers and date-fns `format` all read the
// *local* getters of a Date. Rather than teaching every view about zones, an
// instant is shifted once at the boundary into a "display date" whose local
// fields read as the wall clock in the calendar's zone, and shifted back
// when a time the user picked has to become a real instant. Both are the
// identity while the calendar zone is the device zone. Port of the webmail's
// lib/timezone.ts (toDisplayDate / fromDisplayDate).

/** The instant `date` as a JSCalendar LocalDateTime ("yyyy-MM-ddTHH:mm:ss") in `timeZone`. */
export function formatWallClock(date: Date, timeZone: string): string {
  const w = getWallClock(date, timeZone);
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
}

/** Instant -> display date. The identity unless the calendar zone differs from the device's. */
export function toDisplayDate(date: Date): Date {
  const timeZone = getEffectiveTimeZone();
  if (timeZone === getDeviceTimeZone()) return date;
  return toZonedDisplayDate(date, timeZone);
}

/** Display date (picked in the calendar or an editor) -> real instant. Inverse of `toDisplayDate`. */
export function fromDisplayDate(date: Date): Date {
  const timeZone = getEffectiveTimeZone();
  if (timeZone === getDeviceTimeZone()) return date;
  return fromZonedDisplayDate(date, timeZone);
}

/** "Now" as a display date: what a clock in the calendar's zone reads. */
export function displayNow(): Date {
  return toDisplayDate(new Date());
}

function sameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

/** Is the display date `date` on today's calendar day in the calendar's zone? */
export function isDisplayToday(date: Date): boolean {
  return sameLocalDay(date, displayNow());
}

/** Is the display date `date` on tomorrow's calendar day in the calendar's zone? */
export function isDisplayTomorrow(date: Date): boolean {
  const tomorrow = displayNow();
  tomorrow.setDate(tomorrow.getDate() + 1);
  return sameLocalDay(date, tomorrow);
}

/** Minutes since midnight on a clock in the calendar's zone: where the grids draw the now-line. */
export function displayNowMinutes(): number {
  const now = displayNow();
  return now.getHours() * 60 + now.getMinutes();
}
