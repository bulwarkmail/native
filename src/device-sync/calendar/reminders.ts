/**
 * Alerts ↔ Reminders rows (docs/device-sync.md, "Other properties" and
 * "Reminder owner").
 *
 * A Reminders row is "minutes before the start" plus a method, so only an
 * offset alert relative to the start (or with no `relativeTo`) that fires at
 * or before it is shown; alerts relative to the end, absolute alerts and
 * alerts after the start stay on the server. The app's
 * `offsetToMinutesBefore` rejects the valid `+PT15M` (and fractions), so
 * offsets are read with this module's own duration parser.
 */
import type { Alert } from '../../api/types';
import { Reminders } from '../android-columns';
import type { CalendarLike } from '../wire';
import type { Row } from '../types';
import { minutesBeforeToOffset } from '../../lib/calendar-alerts';
import { durationSeconds, parseDuration } from './duration';
import { reminderActionFromDevice, reminderMethodToDevice } from './values';

export interface ReminderValue {
  minutes: number;
  /** Reminders.METHOD, normalised: EMAIL (2) or ALERT (1). */
  method: number;
}

type Alerts = Record<string, Alert> | null | undefined;

/**
 * The alerts that are in force: with `useDefaultAlerts` the calendar's
 * defaults for timed or all-day events (and the event's own `alerts` are
 * ignored, as the server and the app's scheduler do), else the event's own.
 */
export function effectiveAlerts(
  event: { useDefaultAlerts?: boolean | null; alerts?: Alerts; showWithoutTime?: boolean | null },
  calendar: CalendarLike | undefined,
): Record<string, Alert> {
  if (event.useDefaultAlerts) {
    const defaults = event.showWithoutTime ? calendar?.defaultAlertsWithoutTime : calendar?.defaultAlertsWithTime;
    return { ...(defaults ?? {}) };
  }
  return { ...(event.alerts ?? {}) };
}

/** The reminder an alert shows as, or null when a Reminders row cannot hold it. */
export function alertReminder(alert: Alert | null | undefined): ReminderValue | null {
  const trigger = alert?.trigger;
  if (!trigger || typeof trigger !== 'object') return null;
  const type = trigger['@type'];
  if (type !== undefined && type !== 'OffsetTrigger') return null;
  if (trigger.offset === undefined || trigger.when !== undefined) return null;
  if (trigger.relativeTo !== undefined && trigger.relativeTo !== null && trigger.relativeTo !== 'start') return null;
  const d = parseDuration(trigger.offset);
  if (!d) return null;
  const seconds = durationSeconds(d);
  if (seconds > 0) return null;
  return { minutes: Math.round(-seconds / 60), method: reminderMethodToDevice(alert.action) };
}

export function isRepresentableAlert(alert: Alert | null | undefined): boolean {
  return alertReminder(alert) !== null;
}

export function reminderRow(value: ReminderValue): Row {
  return { [Reminders.MINUTES]: value.minutes, [Reminders.METHOD]: value.method };
}

/** Reminders rows for the alerts that have one, in the alerts' order. */
export function reminderRows(alerts: Alerts): Row[] {
  return Object.values(alerts ?? {})
    .map(alertReminder)
    .filter((r): r is ReminderValue => r !== null)
    .map(reminderRow);
}

/**
 * A device row as a reminder, or null for one that means nothing to the
 * server (MINUTES = -1 is "the app's default").
 */
export function rowReminder(row: Row): ReminderValue | null {
  const minutes = Number(row[Reminders.MINUTES]);
  if (!Number.isInteger(minutes) || minutes < 0) return null;
  return { minutes, method: reminderMethodToDevice(reminderActionFromDevice(row[Reminders.METHOD])) };
}

const keyOf = (r: ReminderValue) => `${r.minutes}/${r.method}`;

/** Two reminder lists as multisets of (minutes, method). */
export function sameReminders(a: Row[], b: Row[]): boolean {
  const count = (rows: Row[]) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const v = rowReminder(r);
      if (v) m.set(keyOf(v), (m.get(keyOf(v)) ?? 0) + 1);
    }
    return m;
  };
  const ca = count(a);
  const cb = count(b);
  if (ca.size !== cb.size) return false;
  for (const [k, n] of ca) if (cb.get(k) !== n) return false;
  return true;
}

/** A new alert for a device reminder, shaped like the app's reminder picker writes them. */
export function reminderAlert(value: ReminderValue): Alert {
  return {
    '@type': 'Alert',
    trigger: { '@type': 'OffsetTrigger', offset: minutesBeforeToOffset(value.minutes), relativeTo: 'start' },
    action: reminderActionFromDevice(value.method),
  };
}

/**
 * The alerts after the device's reminders replaced the representable ones:
 * existing alerts whose (minutes, method) a reminder still has keep their
 * key and value, the others go, unmatched reminders are added under minted
 * keys, and alerts a Reminders row can't hold stay as they are.
 */
export function remindersToAlerts(
  current: Record<string, Alert>,
  reminders: Row[],
  mintKey: (taken: Iterable<string>) => string,
): { alerts: Record<string, Alert>; removed: string[]; added: Record<string, Alert> } {
  const wanted = reminders.map(rowReminder).filter((r): r is ReminderValue => r !== null);
  const pool = new Map<string, number>();
  for (const r of wanted) pool.set(keyOf(r), (pool.get(keyOf(r)) ?? 0) + 1);
  const alerts: Record<string, Alert> = {};
  const removed: string[] = [];
  for (const [key, alert] of Object.entries(current)) {
    const r = alertReminder(alert);
    if (!r) {
      alerts[key] = alert;
      continue;
    }
    const left = pool.get(keyOf(r)) ?? 0;
    if (left > 0) {
      pool.set(keyOf(r), left - 1);
      alerts[key] = alert;
    } else {
      removed.push(key);
    }
  }
  const added: Record<string, Alert> = {};
  for (const r of wanted) {
    const left = pool.get(keyOf(r)) ?? 0;
    if (left <= 0) continue;
    pool.set(keyOf(r), left - 1);
    const key = mintKey([...Object.keys(current), ...Object.keys(added)]);
    added[key] = reminderAlert(r);
    alerts[key] = added[key];
  }
  return { alerts, removed, added };
}
