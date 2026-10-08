/**
 * Time zone basics with no store behind them: the device zone, resolving
 * the zone setting, and an instant's wall clock in a zone. The calendar
 * (calendar-timezone.ts) and the date formatters (date-format.ts) share
 * them; the formatters stay free of stores for the device sync engine.
 */

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
