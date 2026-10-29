/**
 * An event's timing ↔ DTSTART, DTEND, DURATION, EVENT_TIMEZONE and ALL_DAY
 * (docs/device-sync.md, "Timing" and "DST edges").
 *
 * - Timed events are written at the instant of `start` in `timeZone`;
 *   floating events (no zone) in the device zone, which the row's
 *   EVENT_TIMEZONE then records.
 * - All-day events are UTC midnight of the date with EVENT_TIMEZONE `UTC`,
 *   the only form CalendarProvider accepts.
 * - Single events get DTEND (days nominal in the zone), recurring masters a
 *   DURATION (`P<n>D` all-day, `P<seconds>S` timed), exceptions DTEND.
 *
 * Uploads go the other way only for a changed timing: the start is read back
 * in the event's zone (floating stays floating, all-day stays a date), and a
 * start whose wall time repeats in the zone is flagged, because Stalwart
 * drops such a start.
 */
import { Events } from '../android-columns';
import type { Row } from '../types';
import {
  allDayDays,
  addDuration,
  durationBetween,
  durationSeconds,
  formatAospDuration,
  formatJsDuration,
  parseDuration,
  type Duration,
} from './duration';
import {
  DAY_MS,
  canonicalZone,
  classifyLocal,
  dateToUtcMidnight,
  fixedOffsetZone,
  localToUtc,
  offsetAt,
  utcMidnightToDate,
  utcToLocal,
} from './zoned-time';

export interface TimingSource {
  start?: string | null;
  duration?: string | null;
  timeZone?: string | null;
  showWithoutTime?: boolean | null;
}

export interface EventZone {
  /** The zone timed values are computed in; `UTC` for all-day events. */
  zone: string;
  allDay: boolean;
  /** No usable `timeZone`: written in the device zone. */
  floating: boolean;
}

export function eventZone(event: TimingSource, deviceZone: string): EventZone {
  if (event.showWithoutTime) return { zone: 'UTC', allDay: true, floating: false };
  const zone = canonicalZone(event.timeZone);
  if (zone) return { zone, allDay: false, floating: false };
  return { zone: canonicalZone(deviceZone) ?? 'UTC', allDay: false, floating: true };
}

/** The timing cells of an event (or of one instance, `recurring` false). Null when `start` is unreadable. */
export function timingCells(event: TimingSource, recurring: boolean, deviceZone: string): Row | null {
  const { zone, allDay } = eventZone(event, deviceZone);
  const duration = parseDuration(event.duration ?? 'PT0S') ?? { negative: false, days: 0, seconds: 0 };
  if (allDay) {
    const dtstart = dateToUtcMidnight(event.start ?? '');
    if (dtstart === null) return null;
    const days = allDayDays(duration);
    return {
      [Events.DTSTART]: dtstart,
      [Events.DTEND]: recurring ? null : dtstart + days * DAY_MS,
      [Events.DURATION]: recurring ? `P${days}D` : null,
      [Events.EVENT_TIMEZONE]: 'UTC',
      [Events.ALL_DAY]: 1,
    };
  }
  const dtstart = localToUtc(event.start ?? '', zone);
  if (dtstart === null) return null;
  const nonNegative: Duration = duration.negative ? { negative: false, days: 0, seconds: 0 } : duration;
  return {
    [Events.DTSTART]: dtstart,
    [Events.DTEND]: recurring ? null : addDuration(dtstart, nonNegative, zone),
    [Events.DURATION]: recurring ? formatAospDuration(durationSeconds(nonNegative), false) : null,
    [Events.EVENT_TIMEZONE]: zone,
    [Events.ALL_DAY]: 0,
  };
}

/** The timing a row holds, as JSCalendar properties. */
export interface RowTiming {
  start: string;
  duration: string;
  /** The zone the start is in; null for floating and for all-day events without one. */
  timeZone: string | null;
  showWithoutTime: boolean;
  /** Whether `start` names a repeated wall time in `timeZone` (Stalwart drops those). */
  ambiguous: boolean;
  /** The instant of the start, for fixed-offset fallbacks. */
  dtstart: number;
}

export interface RowTimingContext {
  /** The event's timing on the server (the shadow), for what an edit left alone. */
  server: TimingSource | null;
  /** EVENT_TIMEZONE as last written by device sync (the baseline), to tell a zone change from none. */
  baselineZone: string | null;
  recurring: boolean;
  deviceZone: string;
}

const truthy = (v: unknown) => Number(v ?? 0) === 1;

/**
 * JSCalendar timing from a row: all-day rows give a date and whole days;
 * timed rows give the start in the event's zone and the duration with whole
 * days nominal. A floating event stays floating while its row keeps the
 * zone it was written in; a zone the user picked (or an all-day event made
 * timed) becomes the event's `timeZone`. An EVENT_TIMEZONE Intl doesn't know
 * is read as Android reads it, as GMT.
 */
export function rowTiming(cells: Row, ctx: RowTimingContext): RowTiming | null {
  const dtstart = Number(cells[Events.DTSTART]);
  if (cells[Events.DTSTART] === null || cells[Events.DTSTART] === undefined || !Number.isFinite(dtstart)) return null;
  const allDay = truthy(cells[Events.ALL_DAY]);
  const lengthOf = (zone: string): Duration => {
    if (ctx.recurring || cells[Events.DTEND] === null || cells[Events.DTEND] === undefined) {
      const d = parseDuration(cells[Events.DURATION]);
      if (!d || d.negative) return { negative: false, days: 0, seconds: 0 };
      const s = durationSeconds(d);
      return { negative: false, days: Math.floor(s / 86_400), seconds: s % 86_400 };
    }
    return durationBetween(dtstart, Number(cells[Events.DTEND]), zone);
  };
  if (allDay) {
    const d = lengthOf('UTC');
    const days = allDayDays(d);
    const keepZone = ctx.server?.showWithoutTime ? (ctx.server.timeZone ?? null) : null;
    return {
      start: utcMidnightToDate(dtstart),
      duration: formatJsDuration(days, 0),
      timeZone: keepZone,
      showWithoutTime: true,
      ambiguous: false,
      dtstart,
    };
  }
  const rowZoneRaw = String(cells[Events.EVENT_TIMEZONE] ?? '');
  const rowZone = canonicalZone(rowZoneRaw);
  const zoneUnchanged = ctx.baselineZone !== null && rowZoneRaw === ctx.baselineZone;
  const server = ctx.server;
  const serverTimed = !!server && !server.showWithoutTime;
  let timeZone: string | null;
  let computeIn: string;
  if (serverTimed && zoneUnchanged && !canonicalZone(server!.timeZone)) {
    // Floating on the server (or a zone Intl doesn't know): shown in the zone it was written in.
    timeZone = server!.timeZone ?? null;
    computeIn = rowZone ?? 'UTC';
  } else if (serverTimed && zoneUnchanged && server!.timeZone) {
    timeZone = server!.timeZone;
    computeIn = canonicalZone(server!.timeZone)!;
  } else if (rowZone) {
    timeZone = rowZone;
    computeIn = rowZone;
  } else {
    timeZone = 'Etc/UTC';
    computeIn = 'UTC';
  }
  const start = utcToLocal(dtstart, computeIn);
  const d = lengthOf(computeIn);
  return {
    start,
    duration: formatJsDuration(d.days, d.seconds),
    timeZone,
    showWithoutTime: false,
    ambiguous: timeZone !== null && classifyLocal(start, computeIn) === 'overlap',
    dtstart,
  };
}

/**
 * The same instant and wall time in a fixed-offset zone, for a start that is
 * a repeated wall time in its own zone (non-recurring events only).
 */
export function fixedOffsetTiming(timing: RowTiming): RowTiming {
  const zone = fixedOffsetZone(offsetAt(timing.dtstart, timing.timeZone ? canonicalZone(timing.timeZone) ?? 'UTC' : 'UTC'));
  const computeIn = canonicalZone(zone) ?? 'UTC';
  return { ...timing, timeZone: zone, start: utcToLocal(timing.dtstart, computeIn), ambiguous: false };
}
