/**
 * Send-later times in the app's time zone. The presets and the Android
 * two-step picker (date, then time) work on the wall clock of that zone, so
 * "Tomorrow morning" is 08:00 there and a picked 14:00 is 14:00 there, as
 * the labels (formatQuoteDate) show them.
 */

import { fromZonedDisplayDate, getWallClock, localDateTimeToInstant, toZonedDisplayDate, type WallClock } from './time-zone';

const HOUR_MS = 3600 * 1000;

/** 08:00 tomorrow on the wall clock of `timeZone`. */
export function tomorrowMorning(now: Date, timeZone: string): Date {
  const wall = toZonedDisplayDate(now, timeZone);
  wall.setDate(wall.getDate() + 1);
  wall.setHours(8, 0, 0, 0);
  return fromZonedDisplayDate(wall, timeZone);
}

/** The schedule presets ("In 1 hour", "In 3 hours", "Tomorrow morning") as instants. */
export function schedulePresetTimes(now: Date, timeZone: string): { in1h: Date; in3h: Date; tomorrowMorning: Date } {
  return {
    in1h: new Date(now.getTime() + HOUR_MS),
    in3h: new Date(now.getTime() + 3 * HOUR_MS),
    tomorrowMorning: tomorrowMorning(now, timeZone),
  };
}

// A picked day and time are combined as wall-clock fields and converted from
// the digits, never through a device-local Date: a time the device's own zone
// skips (its DST gap) would move by the gap.
function instantOfWallClock(w: WallClock, timeZone: string, fallback: Date): Date {
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  const local = `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
  return localDateTimeToInstant(local, timeZone) ?? fallback;
}

/** `base` moved to the day `picked` falls on in `timeZone`, its time of day there kept. */
export function withPickedDayIn(base: Date, picked: Date, timeZone: string): Date {
  if (isNaN(base.getTime()) || isNaN(picked.getTime())) return base;
  const day = getWallClock(picked, timeZone);
  const clock = getWallClock(base, timeZone);
  return instantOfWallClock({ ...clock, year: day.year, month: day.month, day: day.day }, timeZone, base);
}

/** `base` at the time of day `picked` shows in `timeZone`, to the whole minute. */
export function withPickedTimeIn(base: Date, picked: Date, timeZone: string): Date {
  if (isNaN(base.getTime()) || isNaN(picked.getTime())) return base;
  const day = getWallClock(base, timeZone);
  const clock = getWallClock(picked, timeZone);
  return instantOfWallClock({ ...day, hour: clock.hour, minute: clock.minute, second: 0 }, timeZone, base);
}
