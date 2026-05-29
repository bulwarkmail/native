import type { Alert, CalendarEvent } from '../api/types';

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

export function remindersToAlerts(reminders: Reminder[]): Record<string, Alert> | undefined {
  if (reminders.length === 0) return undefined;
  const alerts: Record<string, Alert> = {};
  reminders.forEach((r, i) => {
    alerts[`reminder-${i + 1}`] = {
      trigger: { '@type': 'OffsetTrigger', offset: minutesBeforeToOffset(r.minutesBefore) },
      action: 'display',
    };
  });
  return alerts;
}

export function formatReminder(minutesBefore: number): string {
  if (minutesBefore === 0) return 'At time of event';
  if (minutesBefore < 0) return `${Math.abs(minutesBefore)} minutes after`;
  if (minutesBefore < 60) return `${minutesBefore} minute${minutesBefore === 1 ? '' : 's'} before`;
  if (minutesBefore < 60 * 24) {
    const h = minutesBefore / 60;
    return Number.isInteger(h) ? `${h} hour${h === 1 ? '' : 's'} before` : `${minutesBefore} minutes before`;
  }
  if (minutesBefore < 60 * 24 * 7) {
    const d = minutesBefore / (60 * 24);
    return Number.isInteger(d) ? `${d} day${d === 1 ? '' : 's'} before` : `${(minutesBefore / 60).toFixed(0)} hours before`;
  }
  const w = minutesBefore / (60 * 24 * 7);
  return Number.isInteger(w) ? `${w} week${w === 1 ? '' : 's'} before` : `${(minutesBefore / (60 * 24)).toFixed(0)} days before`;
}

// Presets offered by the reminder picker (minutes before start).
export const REMINDER_PRESETS: number[] = [
  0, 5, 10, 15, 30, 60, 120, 60 * 24, 60 * 24 * 2, 60 * 24 * 7,
];
