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

/** Sentinel for "follow the device" — the default. */
export const AUTO_TIME_ZONE = 'auto';

// Reading the device zone builds an Intl.DateTimeFormat, which is slow on
// Hermes, and task sorting resolves a due per comparison. The zone only
// changes when the user travels or changes it, so a short cache is enough.
const DEVICE_ZONE_TTL_MS = 30_000;
let deviceZoneCache: { zone: string; readAt: number } | null = null;

/** The zone the device reports; `UTC` when detection fails. */
export function getDeviceTimeZone(): string {
  const now = Date.now();
  if (deviceZoneCache && now - deviceZoneCache.readAt < DEVICE_ZONE_TTL_MS) {
    return deviceZoneCache.zone;
  }
  let zone: string;
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    zone = 'UTC';
  }
  deviceZoneCache = { zone, readAt: now };
  return zone;
}

const validityCache = new Map<string, boolean>();

/** True when `Intl` accepts `tz` as a time zone identifier. */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz) return false;
  let valid = validityCache.get(tz);
  if (valid === undefined) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      valid = true;
    } catch {
      valid = false;
    }
    validityCache.set(tz, valid);
  }
  return valid;
}

/**
 * Resolve a stored `timeZone` setting to a concrete IANA zone. `auto`, empty
 * or unknown values (a zone synced from a client with a newer tz database)
 * fall back to the device zone instead of throwing later inside Intl.
 */
export function resolveTimeZone(
  setting: string | null | undefined,
  deviceTimeZone = getDeviceTimeZone(),
): string {
  if (!setting || setting === AUTO_TIME_ZONE) return deviceTimeZone;
  return isValidTimeZone(setting) ? setting : deviceTimeZone;
}

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

export interface WallClock {
  year: number;
  /** 1-12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

// Building an Intl.DateTimeFormat is expensive; the calendar converts every
// event it shows, so keep one per zone.
const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = wallClockFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    wallClockFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Wall-clock fields of the instant `date` as seen in `timeZone`. */
export function getWallClock(date: Date, timeZone: string): WallClock {
  const map: Record<string, number> = {};
  for (const part of wallClockFormatter(timeZone).formatToParts(date)) {
    if (part.type !== 'literal') map[part.type] = Number(part.value);
  }
  return {
    year: map.year,
    month: map.month,
    day: map.day,
    // Some engines still emit "24" at midnight despite hourCycle h23.
    hour: map.hour === 24 ? 0 : map.hour,
    minute: map.minute,
    second: map.second,
  };
}

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

/** Is the display date `date` on today's calendar day in the calendar's zone? */
export function isDisplayToday(date: Date): boolean {
  const now = displayNow();
  return date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}
