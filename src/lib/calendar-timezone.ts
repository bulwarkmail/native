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
import { getDeviceTimeZone, getWallClock, isValidTimeZone, resolveTimeZone, type WallClock } from './time-zone';

export {
  AUTO_TIME_ZONE,
  getDeviceTimeZone,
  getWallClock,
  isValidTimeZone,
  resolveTimeZone,
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

/** UTC offset of `timeZone` at the given instant, in milliseconds (east = positive). */
export function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const w = getWallClock(date, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // Intl drops sub-second precision; compare against the whole-second instant.
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** A Date whose *local* fields equal the given wall clock (years < 100 included). */
function localDateFromWallClock(w: WallClock, milliseconds: number): Date {
  const d = new Date(0);
  d.setFullYear(w.year, w.month - 1, w.day);
  d.setHours(w.hour, w.minute, w.second, milliseconds);
  return d;
}

/**
 * Shift an instant into a Date whose local getters read as its wall clock in
 * `timeZone`. Not the same instant unless the zones agree: only for local
 * field arithmetic and rendering.
 */
export function toZonedDisplayDate(date: Date, timeZone: string): Date {
  if (isNaN(date.getTime())) return date;
  return localDateFromWallClock(getWallClock(date, timeZone), date.getMilliseconds());
}

/**
 * Read the local fields of `wall` as a wall clock in `timeZone` and return
 * the real instant. Two offset lookups handle wall clocks next to a DST
 * transition.
 */
export function fromZonedDisplayDate(wall: Date, timeZone: string): Date {
  if (isNaN(wall.getTime())) return wall;
  const asUtc = Date.UTC(
    wall.getFullYear(), wall.getMonth(), wall.getDate(),
    wall.getHours(), wall.getMinutes(), wall.getSeconds(), wall.getMilliseconds(),
  );
  const guess = asUtc - getTimeZoneOffsetMs(new Date(asUtc), timeZone);
  return new Date(asUtc - getTimeZoneOffsetMs(new Date(guess), timeZone));
}

/**
 * The instant of a JSCalendar LocalDateTime ("yyyy-MM-ddTHH:mm:ss") read as
 * a wall clock in `timeZone`. Parsed from the digits, so a wall clock that
 * does not exist on the device (its own DST gap) still converts right.
 * `null` for an unparsable value or zone.
 */
export function localDateTimeToInstant(value: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(value);
  if (!m || !isValidTimeZone(timeZone)) return null;
  const asUtc = Date.UTC(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0),
  );
  const guess = asUtc - getTimeZoneOffsetMs(new Date(asUtc), timeZone);
  return new Date(asUtc - getTimeZoneOffsetMs(new Date(guess), timeZone));
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
