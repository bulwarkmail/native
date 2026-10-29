/**
 * JSCalendar LocalDateTimes in an IANA zone ↔ UTC instants, for mapping
 * events to CalendarProvider's millisecond columns (docs/device-sync.md,
 * "Timing" and "DST edges"). Only `Intl` is used, so it behaves the same on
 * Hermes and in vitest, whatever zone the process runs in.
 *
 * RFC 5545 §3.3.5 decides the transition hours: a wall time in a DST gap is
 * read with the offset before the gap (it moves forward by the gap), and a
 * wall time in an overlap is the earlier of its two instants. The app's
 * `localDateTimeToInstant` (lib/calendar-timezone.ts) gets one of the two
 * wrong depending on the sign of the zone's offset, and its module imports
 * the settings store, so it is not reused here.
 */

export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export type LocalTimeKind = 'ok' | 'gap' | 'overlap';

export const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d+)?)?)?/;

/**
 * The fields of a LocalDateTime (`2026-10-25T02:30:00`) or a date
 * (`2026-10-25`, read as midnight). Like Stalwart, a fraction and a trailing
 * `Z` or offset are ignored. Null for anything that is not a real date-time.
 */
export function parseLocalDateTime(value: unknown): WallClock | null {
  if (typeof value !== 'string') return null;
  const m = LOCAL_DATE_TIME.exec(value.trim());
  if (!m) return null;
  const wall: WallClock = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4] ?? 0),
    minute: Number(m[5] ?? 0),
    second: Number(m[6] ?? 0),
  };
  if (wall.hour > 23 || wall.minute > 59 || wall.second > 59) return null;
  // Date arithmetic rolls 2026-02-30 over into March; a real date survives the round trip.
  const back = wallFromMs(wallMs(wall));
  return back.month === wall.month && back.day === wall.day ? wall : null;
}

const pad = (n: number, len = 2) => String(n).padStart(len, '0');

export function formatLocalDateTime(wall: WallClock): string {
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}T${pad(wall.hour)}:${pad(wall.minute)}:${pad(wall.second)}`;
}

/** `YYYY-MM-DD` of a wall clock. */
export function formatDate(wall: WallClock): string {
  return `${pad(wall.year, 4)}-${pad(wall.month)}-${pad(wall.day)}`;
}

/** The wall clock read as if it were UTC, in milliseconds (years below 100 included). */
export function wallMs(wall: WallClock): number {
  const d = new Date(0);
  d.setUTCFullYear(wall.year, wall.month - 1, wall.day);
  d.setUTCHours(wall.hour, wall.minute, wall.second, 0);
  return d.getTime();
}

export function wallFromMs(ms: number): WallClock {
  const d = new Date(ms);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  };
}

/** Wall-clock arithmetic: calendar days, then an exact amount of wall time. */
export function addToWall(wall: WallClock, days: number, ms = 0): WallClock {
  return wallFromMs(wallMs(wall) + days * DAY_MS + ms);
}

// ─── Zones ──────────────────────────────────────────────

const zoneCache = new Map<string, string | null>();

/**
 * The zone as Intl names it (canonical case, aliases resolved: `US/Eastern`
 * → `America/New_York`, `Etc/UTC` → `UTC`), or null when Intl does not know
 * it. Android's TimeZone silently turns an unknown id into GMT and Stalwart
 * turns one into a floating event, so every zone is checked before either
 * write.
 */
export function canonicalZone(zone: unknown): string | null {
  if (typeof zone !== 'string' || !zone) return null;
  let canonical = zoneCache.get(zone);
  if (canonical === undefined) {
    try {
      canonical = new Intl.DateTimeFormat('en-US', { timeZone: zone }).resolvedOptions().timeZone ?? zone;
    } catch {
      canonical = null;
    }
    zoneCache.set(zone, canonical);
  }
  return canonical;
}

export function isValidTimeZone(zone: unknown): zone is string {
  return canonicalZone(zone) !== null;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(zone, f);
  }
  return f;
}

/** Wall-clock fields of an instant in `zone` (whole seconds). */
export function wallClockAt(utcMs: number, zone: string): WallClock {
  const fields: Record<string, number> = {};
  for (const part of formatter(zone).formatToParts(new Date(floorSecond(utcMs)))) {
    if (part.type !== 'literal') fields[part.type] = Number(part.value);
  }
  return {
    year: fields.year,
    month: fields.month,
    day: fields.day,
    // Some engines still say "24" at midnight despite h23.
    hour: fields.hour === 24 ? 0 : fields.hour,
    minute: fields.minute,
    second: fields.second,
  };
}

function floorSecond(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

/** The zone's UTC offset at an instant in ms, east positive. */
export function offsetAt(utcMs: number, zone: string): number {
  const at = floorSecond(utcMs);
  return wallMs(wallClockAt(at, zone)) - at;
}

export interface ResolvedLocalTime {
  /** The instant per RFC 5545: gap → the offset before it; overlap → the earlier one. */
  utc: number;
  kind: LocalTimeKind;
}

/**
 * The instant of a wall clock in `zone`, and whether the wall time is
 * normal, skipped (gap) or repeated (overlap). Assumes at most one offset
 * change within a day of the wall time, which holds for every real zone.
 */
export function resolveWallClock(wall: WallClock, zone: string): ResolvedLocalTime {
  const w = wallMs(wall);
  const before = offsetAt(w - DAY_MS, zone);
  const after = offsetAt(w + DAY_MS, zone);
  const tBefore = w - before;
  const tAfter = w - after;
  const okBefore = offsetAt(tBefore, zone) === before;
  const okAfter = offsetAt(tAfter, zone) === after;
  if (okBefore && okAfter) {
    return tBefore === tAfter ? { utc: tBefore, kind: 'ok' } : { utc: Math.min(tBefore, tAfter), kind: 'overlap' };
  }
  if (okBefore) return { utc: tBefore, kind: 'ok' };
  if (okAfter) return { utc: tAfter, kind: 'ok' };
  return { utc: tBefore, kind: 'gap' };
}

/** A LocalDateTime in `zone` as a UTC instant (RFC 5545 semantics), or null when unreadable. */
export function localToUtc(value: string, zone: string): number | null {
  const wall = parseLocalDateTime(value);
  const z = canonicalZone(zone);
  if (!wall || !z) return null;
  return resolveWallClock(wall, z).utc;
}

/** Whether a LocalDateTime is an ordinary, a skipped or a repeated wall time in `zone`. */
export function classifyLocal(value: string, zone: string): LocalTimeKind | null {
  const wall = parseLocalDateTime(value);
  const z = canonicalZone(zone);
  if (!wall || !z) return null;
  return resolveWallClock(wall, z).kind;
}

/** The instant as a LocalDateTime in `zone`. Both instants of an overlap give the same text. */
export function utcToLocal(utcMs: number, zone: string): string {
  return formatLocalDateTime(wallClockAt(utcMs, canonicalZone(zone) ?? 'UTC'));
}

/** UTC midnight of a LocalDateTime's date: how CalendarProvider stores all-day times. */
export function dateToUtcMidnight(value: string): number | null {
  const wall = parseLocalDateTime(value);
  return wall ? wallMs({ ...wall, hour: 0, minute: 0, second: 0 }) : null;
}

/** The UTC date of an instant as a LocalDateTime at midnight (`2026-10-08T00:00:00`). */
export function utcMidnightToDate(utcMs: number): string {
  return `${formatDate(wallFromMs(utcMs))}T00:00:00`;
}

/**
 * A fixed-offset zone for an instant: `Etc/GMT-2` for UTC+2 (the Etc names
 * flip the sign), `Etc/UTC` when the offset is zero or not a whole number of
 * hours. Stalwart drops a start whose local time is repeated in its zone; the
 * same instant and wall time in a fixed-offset zone survive (checked on the
 * live server).
 */
export function fixedOffsetZone(offsetMs: number): string {
  const hours = offsetMs / HOUR_MS;
  if (!Number.isInteger(hours) || hours === 0 || hours < -12 || hours > 14) return 'Etc/UTC';
  return `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`;
}

/** Compares two LocalDateTimes by their fields (a fraction or suffix is ignored). */
export function sameLocalDateTime(a: unknown, b: unknown): boolean {
  const wa = parseLocalDateTime(a);
  const wb = parseLocalDateTime(b);
  if (!wa || !wb) return wa === wb && a === b;
  return wallMs(wa) === wallMs(wb);
}

/** Orders LocalDateTimes (ISO text compares chronologically once normalised). */
export function compareLocal(a: string, b: string): number {
  const wa = parseLocalDateTime(a);
  const wb = parseLocalDateTime(b);
  if (!wa || !wb) return a < b ? -1 : a > b ? 1 : 0;
  return wallMs(wa) - wallMs(wb);
}
