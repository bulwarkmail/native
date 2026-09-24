import type { Alert, CalendarEvent } from '../api/types';
import { formatMessage, type MessageParams } from '../i18n/format';

// A reminder, expressed as "minutes before the event start". 0 means "at the
// time of the event". Negative values (reminder *after* start) are preserved
// on round-trip but the picker only offers non-negative presets.
export interface Reminder {
  /** Minutes before start. 0 = at time of event. */
  minutesBefore: number;
}

const DURATION_RE = /^(-?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

// Parse an ISO 8601 duration offset ("-PT15M", "-P1D", "PT0S") to minutes.
// Positive return value = minutes *before* the anchor (JSCalendar offsets for
// reminders are negative, e.g. "-PT15M" fires 15 min before start).
export function offsetToMinutesBefore(offset: string | undefined): number | null {
  if (!offset) return null;
  const m = DURATION_RE.exec(offset);
  if (!m) return null;
  const negative = m[1] === '-';
  const weeks = parseInt(m[2] || '0', 10);
  const days = parseInt(m[3] || '0', 10);
  const hours = parseInt(m[4] || '0', 10);
  const minutes = parseInt(m[5] || '0', 10);
  const seconds = parseInt(m[6] || '0', 10);
  const totalMinutes = weeks * 7 * 24 * 60 + days * 24 * 60 + hours * 60 + minutes + Math.round(seconds / 60);
  // A negative offset (fires before start) is a positive "minutesBefore".
  // `|| 0` collapses -0 to 0 so callers get a clean "at time of event".
  return (negative ? totalMinutes : -totalMinutes) || 0;
}

export function minutesBeforeToOffset(minutesBefore: number): string {
  if (minutesBefore === 0) return 'PT0S';
  const sign = minutesBefore > 0 ? '-' : '';
  let mins = Math.abs(minutesBefore);
  const days = Math.floor(mins / (24 * 60));
  mins -= days * 24 * 60;
  const hours = Math.floor(mins / 60);
  mins -= hours * 60;
  let out = 'P';
  if (days > 0) out += `${days}D`;
  if (hours > 0 || mins > 0) {
    out += 'T';
    if (hours > 0) out += `${hours}H`;
    if (mins > 0) out += `${mins}M`;
  }
  if (out === 'P') out = 'PT0M';
  return `${sign}${out}`;
}

// Pull the list of reminders out of an event's `alerts` map. Only display-style
// offset alerts relative to start are surfaced in the editor; anything exotic is
// dropped from the UI list (but the event keeps it until the user saves).
export function alertsToReminders(alerts: CalendarEvent['alerts']): Reminder[] {
  if (!alerts) return [];
  const out: Reminder[] = [];
  for (const alert of Object.values(alerts)) {
    const trigger = alert?.trigger;
    if (!trigger) continue;
    if (trigger.offset === undefined) continue; // skip AbsoluteTriggers in the picker
    const minutesBefore = offsetToMinutesBefore(trigger.offset);
    if (minutesBefore === null) continue;
    out.push({ minutesBefore });
  }
  // De-dupe + sort soonest-to-event last (largest lead time first).
  const seen = new Set<number>();
  return out
    .filter((r) => (seen.has(r.minutesBefore) ? false : (seen.add(r.minutesBefore), true)))
    .sort((a, b) => b.minutesBefore - a.minutesBefore);
}

// Alerts the picker can't represent (absolute triggers, end-relative offsets,
// non-display actions) — kept as-is so a save doesn't drop them.
export function preservedAlerts(alerts: CalendarEvent['alerts']): Record<string, Alert> {
  const out: Record<string, Alert> = {};
  if (!alerts) return out;
  for (const [id, alert] of Object.entries(alerts)) {
    const trigger = alert?.trigger;
    if (!trigger) continue;
    const representable =
      trigger.offset !== undefined &&
      (trigger.relativeTo === undefined || trigger.relativeTo === 'start') &&
      (!alert.action || alert.action === 'display') &&
      offsetToMinutesBefore(trigger.offset) !== null;
    if (!representable) out[id] = alert;
  }
  return out;
}

export function remindersToAlerts(
  reminders: Reminder[],
  preserved: Record<string, Alert> = {},
): Record<string, Alert> | undefined {
  if (reminders.length === 0 && Object.keys(preserved).length === 0) return undefined;
  const alerts: Record<string, Alert> = { ...preserved };
  let n = 0;
  for (const r of reminders) {
    let key = `reminder-${++n}`;
    while (key in alerts) key = `reminder-${++n}`;
    alerts[key] = {
      '@type': 'Alert',
      trigger: { '@type': 'OffsetTrigger', offset: minutesBeforeToOffset(r.minutesBefore), relativeTo: 'start' },
      action: 'display',
    };
  }
  return alerts;
}

type Translate = (key: string, fallback?: string, params?: MessageParams) => string;
// Without a translator: the English text, plurals resolved.
const plain: Translate = (key, fallback, params) => formatMessage(fallback ?? key, params, 'en');

/** "15 minutes before", "1 day before", "At time of event" in the language of `t`. */
export function formatReminder(minutesBefore: number, t: Translate = plain): string {
  const minutes = (count: number) =>
    t('calendar.alerts.minutes_before', '{count, plural, one {# minute before} other {# minutes before}}', { count });
  const hours = (count: number) =>
    t('calendar.alerts.hours_before', '{count, plural, one {# hour before} other {# hours before}}', { count });
  const days = (count: number) =>
    t('calendar.alerts.days_before', '{count, plural, one {# day before} other {# days before}}', { count });
  const weeks = (count: number) =>
    t('calendar.alerts.weeks_before', '{count, plural, one {# week before} other {# weeks before}}', { count });

  if (minutesBefore === 0) return t('calendar.alerts.at_time', 'At time of event');
  if (minutesBefore < 0) {
    return t('calendar.alerts.minutes_after', '{count, plural, one {# minute after} other {# minutes after}}', {
      count: Math.abs(minutesBefore),
    });
  }
  if (minutesBefore < 60) return minutes(minutesBefore);
  if (minutesBefore < 60 * 24) {
    const h = minutesBefore / 60;
    return Number.isInteger(h) ? hours(h) : minutes(minutesBefore);
  }
  if (minutesBefore < 60 * 24 * 7) {
    const d = minutesBefore / (60 * 24);
    return Number.isInteger(d) ? days(d) : hours(Math.round(minutesBefore / 60));
  }
  const w = minutesBefore / (60 * 24 * 7);
  return Number.isInteger(w) ? weeks(w) : days(Math.round(minutesBefore / (60 * 24)));
}

export type ReminderUnit = 'minutes' | 'hours' | 'days' | 'weeks';

export const REMINDER_UNIT_MINUTES: Record<ReminderUnit, number> = {
  minutes: 1,
  hours: 60,
  days: 60 * 24,
  weeks: 60 * 24 * 7,
};

// Presets offered by the reminder picker (minutes before start).
export const REMINDER_PRESETS: number[] = [
  0, 5, 10, 15, 30, 60, 120, 60 * 24, 60 * 24 * 2, 60 * 24 * 7,
];
