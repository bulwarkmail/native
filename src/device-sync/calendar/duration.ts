/**
 * Durations in the three dialects device sync meets (docs/device-sync.md,
 * "Timing"):
 *
 * - JSCalendar (RFC 8984 §1.4.6) on the server: weeks, days and a time part
 *   with fractional seconds; `P1W` arrives from CalDAV DTENDs. The app's own
 *   parsers ignore weeks (`P1W` → 0) and signs, so none of them is reused.
 * - AOSP's calendarcommon2 Duration in the DURATION column: `[+-]P` then
 *   `<digits><W|D|H|M|S>`, `T` ignored, `M` always minutes, no fractions and
 *   no `Y`. All-day rows must say `P<n>D`: CalendarProvider rewrites `P<n>S`
 *   with `Integer.parseInt` and throws on anything else ending in `S`.
 * - Whole days are nominal (a calendar day in the event's zone), the rest is
 *   exact time.
 */
import {
  addToWall,
  canonicalZone,
  resolveWallClock,
  wallClockAt,
  wallMs,
  type WallClock,
} from './zoned-time';

export interface Duration {
  negative: boolean;
  /** Whole nominal days (weeks included). */
  days: number;
  /** The exact part in seconds (may be fractional). */
  seconds: number;
}

const DAY_S = 86_400;

/**
 * Parses any duration either side writes: RFC 8984/5545 text, signed or not,
 * weeks and days, `M` as minutes, a fraction on the seconds, lower case, and
 * AOSP's forms (`P3600S`, `P1DT0S`, `P0DT1H30M0S`). Null for anything else
 * (years, months before the time part, an empty `P`).
 */
export function parseDuration(text: unknown): Duration | null {
  if (typeof text !== 'string') return null;
  const m = /^([+-])?P(.*)$/.exec(text.trim().toUpperCase());
  if (!m || !m[2]) return null;
  let days = 0;
  let seconds = 0;
  let any = false;
  const token = /^(?:T|(\d+(?:[.,]\d+)?)([WDHMS]))/;
  let rest = m[2];
  while (rest) {
    const t = token.exec(rest);
    if (!t) return null;
    rest = rest.slice(t[0].length);
    if (t[0] === 'T') continue;
    const unit = t[2];
    const fractional = /[.,]/.test(t[1]);
    if (fractional && unit !== 'S') return null;
    const n = Number(t[1].replace(',', '.'));
    any = true;
    if (unit === 'W') days += n * 7;
    else if (unit === 'D') days += n;
    else if (unit === 'H') seconds += n * 3600;
    else if (unit === 'M') seconds += n * 60;
    else seconds += n;
  }
  if (!any) return null;
  return { negative: m[1] === '-', days, seconds };
}

/** Total seconds with a day counted as 24 hours, signed: CalendarProvider's arithmetic. */
export function durationSeconds(d: Duration): number {
  const total = d.days * DAY_S + d.seconds;
  return d.negative ? -total : total;
}

/** Seconds of a duration text, or null when it can't be read. */
export function durationTextSeconds(text: unknown): number | null {
  const d = parseDuration(text);
  return d ? durationSeconds(d) : null;
}

/**
 * A JSCalendar Duration in the strict grammar: `P<n>D`, `T<h>H<m>M<s>S` with
 * minutes kept between hours and seconds (`PT1H0M5S`; `PT1H5S` is not
 * valid), whole seconds, never weeks, `PT0S` for zero. Negative input is
 * treated as zero: an event's duration is unsigned.
 */
export function formatJsDuration(days: number, seconds: number): string {
  const d = Math.max(0, Math.floor(days));
  let s = Math.max(0, Math.round(seconds));
  let out = 'P';
  if (d > 0) out += `${d}D`;
  if (s > 0) {
    const h = Math.floor(s / 3600);
    s -= h * 3600;
    const min = Math.floor(s / 60);
    s -= min * 60;
    out += 'T';
    if (h > 0) out += `${h}H`;
    if (min > 0 || (h > 0 && s > 0)) out += `${min}M`;
    if (s > 0) out += `${s}S`;
  }
  return out === 'P' ? 'PT0S' : out;
}

/** A fixed number of seconds as a JSCalendar duration, with whole days split off as nominal days. */
export function formatJsDurationSeconds(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  return formatJsDuration(Math.floor(s / DAY_S), s % DAY_S);
}

/**
 * The DURATION column: `P<n>D` for all-day rows (at least one day; a time
 * part is rounded up), `P<seconds>S` for timed rows. Never a fraction, a
 * `Y`, a sign or weeks.
 */
export function formatAospDuration(totalSeconds: number, allDay: boolean): string {
  if (allDay) return `P${Math.max(1, Math.ceil(totalSeconds / DAY_S))}D`;
  return `P${Math.max(0, Math.round(totalSeconds))}S`;
}

/** Whole days of an all-day duration on the device: at least one, a time part rounded up. */
export function allDayDays(d: Duration | null): number {
  if (!d || d.negative) return 1;
  return Math.max(1, Math.ceil((d.days * DAY_S + d.seconds) / DAY_S));
}

/**
 * The end of a duration that starts at `startUtc`: whole days in the zone's
 * wall clock, then exact seconds. With no whole days the start instant is
 * used as is, so a start that is the second instant of a repeated hour does
 * not collapse onto the first one.
 */
export function addDuration(startUtc: number, d: Duration, zone: string): number {
  const days = d.negative ? 0 : d.days;
  const seconds = d.negative ? 0 : d.seconds;
  if (days === 0) return startUtc + Math.round(seconds * 1000);
  const z = canonicalZone(zone) ?? 'UTC';
  const wall = wallClockAt(startUtc, z);
  const shifted = resolveWallClock(addToWall(wall, days), z).utc + (startUtc % 1000 + 1000) % 1000;
  return shifted + Math.round(seconds * 1000);
}

/**
 * DTSTART/DTEND as a duration with whole days nominal in `zone` and the rest
 * exact: 00:00 to 00:00 the next day is `P1D` even across a DST change.
 */
export function durationBetween(startUtc: number, endUtc: number, zone: string): Duration {
  if (!(endUtc > startUtc)) return { negative: false, days: 0, seconds: 0 };
  const z = canonicalZone(zone) ?? 'UTC';
  const sw = wallClockAt(startUtc, z);
  const ew = wallClockAt(endUtc, z);
  let days = Math.round((dateMs(ew) - dateMs(sw)) / 86_400_000);
  if (timeOfDay(ew) < timeOfDay(sw)) days -= 1;
  days = Math.max(0, days);
  let anchor = days > 0 ? addDuration(startUtc, { negative: false, days, seconds: 0 }, z) : startUtc;
  while (days > 0 && anchor > endUtc) {
    days -= 1;
    anchor = days > 0 ? addDuration(startUtc, { negative: false, days, seconds: 0 }, z) : startUtc;
  }
  return { negative: false, days, seconds: Math.max(0, (endUtc - anchor) / 1000) };
}

function dateMs(w: WallClock): number {
  return wallMs({ ...w, hour: 0, minute: 0, second: 0 });
}

function timeOfDay(w: WallClock): number {
  return w.hour * 3600 + w.minute * 60 + w.second;
}

/** Equal lengths with a day counted as 24 hours (`PT24H` and `P1D` are the same to CalendarProvider). */
export function sameDurationLength(a: unknown, b: unknown): boolean {
  const sa = durationTextSeconds(a);
  const sb = durationTextSeconds(b);
  if (sa === null || sb === null) return (a ?? null) === (b ?? null);
  return sa === sb;
}
