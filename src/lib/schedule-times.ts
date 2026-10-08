/**
 * Send-later times in the app's time zone. The presets and the Android
 * two-step picker (date, then time) work on the wall clock of that zone, so
 * "Tomorrow morning" is 08:00 there and a picked 14:00 is 14:00 there, as
 * the labels (formatQuoteDate) show them.
 */

import { fromZonedDisplayDate, toZonedDisplayDate } from './time-zone';

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

/** `base` moved to the day `picked` falls on in `timeZone`, its time of day there kept. */
export function withPickedDayIn(base: Date, picked: Date, timeZone: string): Date {
  const wall = toZonedDisplayDate(base, timeZone);
  const day = toZonedDisplayDate(picked, timeZone);
  wall.setFullYear(day.getFullYear(), day.getMonth(), day.getDate());
  return fromZonedDisplayDate(wall, timeZone);
}

/** `base` at the time of day `picked` shows in `timeZone`, to the whole minute. */
export function withPickedTimeIn(base: Date, picked: Date, timeZone: string): Date {
  const wall = toZonedDisplayDate(base, timeZone);
  const clock = toZonedDisplayDate(picked, timeZone);
  wall.setHours(clock.getHours(), clock.getMinutes(), 0, 0);
  return fromZonedDisplayDate(wall, timeZone);
}
