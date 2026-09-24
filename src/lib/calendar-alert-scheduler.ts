import { parseISO } from 'date-fns';
import type { Alert, Calendar, CalendarEvent } from '../api/types';
import { getTaskDueDate, parseDuration } from './calendar-utils';

// Pure alert maths for calendar reminders. Port of the webmail's
// lib/calendar-alerts.ts (computeFireTime / getEffectiveAlerts /
// getPendingAlerts) adapted to schedule *future* local notifications
// instead of polling for alerts that just fired.

export interface ScheduledAlert {
  /** `${eventId}:${alertId}:${fireTimeMs}` — stable across refetches. */
  key: string;
  eventId: string;
  alertId: string;
  fireTimeMs: number;
  title: string;
  body: string;
  kind: 'event' | 'task';
  // What a tap on the reminder opens (see calendar-reminder-open): the
  // stored event's raw id and account, and the occurrence.
  serverId?: string;
  accountId?: string;
  recurrenceId?: string;
  startMs?: number;
}

const DURATION_RE = /^(-?)P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;

/** ISO 8601 duration offset ("-PT15M") to signed milliseconds. */
export function parseAlertOffset(offset: string): number | null {
  const match = DURATION_RE.exec(offset);
  if (!match) return null;
  const negative = match[1] === '-';
  const weeks = parseInt(match[2] || '0', 10);
  const days = parseInt(match[3] || '0', 10);
  const hours = parseInt(match[4] || '0', 10);
  const minutes = parseInt(match[5] || '0', 10);
  const seconds = parseInt(match[6] || '0', 10);
  const ms = ((weeks * 7 * 24 * 60 * 60) + (days * 24 * 60 * 60) + (hours * 60 * 60) + (minutes * 60) + seconds) * 1000;
  return negative ? -ms : ms;
}

export function computeFireTime(event: CalendarEvent, trigger: Alert['trigger']): number | null {
  if (trigger['@type'] === 'AbsoluteTrigger') {
    if (!trigger.when) return null;
    const t = new Date(trigger.when).getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (trigger.offset === undefined) return null;
  const offsetMs = parseAlertOffset(trigger.offset);
  if (offsetMs === null) return null;

  let baseTime: number;
  if (trigger.relativeTo === 'end') {
    if (event.utcEnd) {
      baseTime = new Date(event.utcEnd).getTime();
    } else {
      const startMs = parseISO(event.start).getTime();
      if (Number.isNaN(startMs)) return null;
      baseTime = startMs + parseDuration(event.duration);
    }
  } else {
    baseTime = event.utcStart
      ? new Date(event.utcStart).getTime()
      : parseISO(event.start).getTime();
  }
  if (Number.isNaN(baseTime)) return null;
  return baseTime + offsetMs;
}

export function computeTaskFireTime(task: CalendarEvent, trigger: Alert['trigger']): number | null {
  if (trigger['@type'] === 'AbsoluteTrigger') {
    if (!trigger.when) return null;
    const t = new Date(trigger.when).getTime();
    return Number.isNaN(t) ? null : t;
  }
  if (trigger.offset === undefined) return null;
  const offsetMs = parseAlertOffset(trigger.offset);
  if (offsetMs === null) return null;
  const due = getTaskDueDate(task);
  if (!due) return null;
  return due.getTime() + offsetMs;
}

/** The event's own alerts, or the calendar defaults when `useDefaultAlerts` is set. */
export function getEffectiveAlerts(
  event: CalendarEvent,
  calendars: Calendar[],
): Record<string, Alert> | null {
  if (!event.useDefaultAlerts) return event.alerts ?? null;
  const calendarId = Object.keys(event.calendarIds ?? {})[0];
  if (!calendarId) return null;
  const calendar = calendars.find((c) => c.id === calendarId);
  if (!calendar) return null;
  return (event.showWithoutTime ? calendar.defaultAlertsWithoutTime : calendar.defaultAlertsWithTime) ?? null;
}

export function buildAlertKey(eventId: string, alertId: string, fireTimeMs: number): string {
  return `${eventId}:${alertId}:${fireTimeMs}`;
}

export interface AlertWindow {
  /** Only alerts firing after this instant are scheduled. */
  now: number;
  /** ...and before now + horizonMs (the OS caps pending notifications). */
  horizonMs: number;
  /** Hard cap on the number of alerts returned (soonest first). */
  limit?: number;
}

function formatWhen(fireTimeMs: number, startMs: number): string {
  const diffMin = Math.round((startMs - fireTimeMs) / 60000);
  if (diffMin <= 0) return 'now';
  if (diffMin < 60) return `in ${diffMin} min`;
  if (diffMin < 24 * 60) {
    const h = Math.round(diffMin / 60);
    return `in ${h} h`;
  }
  const d = Math.round(diffMin / (24 * 60));
  return `in ${d} d`;
}

/**
 * Every display alert of the given events/tasks that fires inside the
 * window, soonest first. Cancelled events, completed tasks and acknowledged
 * alerts are skipped (#572). Expanded occurrences carry their own utcStart,
 * so each occurrence yields its own alert.
 */
export function getUpcomingAlerts(
  events: CalendarEvent[],
  tasks: CalendarEvent[],
  calendars: Calendar[],
  window: AlertWindow,
): ScheduledAlert[] {
  const out: ScheduledAlert[] = [];
  const until = window.now + window.horizonMs;

  for (const event of events) {
    if (event.status === 'cancelled') continue;
    const alerts = getEffectiveAlerts(event, calendars);
    if (!alerts) continue;
    const startMs = event.utcStart ? new Date(event.utcStart).getTime() : parseISO(event.start).getTime();
    for (const [alertId, alert] of Object.entries(alerts)) {
      if (!alert?.trigger) continue;
      if (alert.action && alert.action !== 'display') continue;
      if (alert.acknowledged) continue;
      const fireTimeMs = computeFireTime(event, alert.trigger);
      if (fireTimeMs === null || fireTimeMs <= window.now || fireTimeMs > until) continue;
      out.push({
        key: buildAlertKey(event.id, alertId, fireTimeMs),
        eventId: event.id,
        alertId,
        fireTimeMs,
        title: event.title || '(No title)',
        body: Number.isNaN(startMs) ? '' : `Starts ${formatWhen(fireTimeMs, startMs)}`,
        kind: 'event',
        serverId: event.originalId ?? event.id,
        accountId: event.accountId,
        recurrenceId: event.recurrenceId,
        startMs: Number.isNaN(startMs) ? undefined : startMs,
      });
    }
  }

  for (const task of tasks) {
    if (!task.alerts) continue;
    if (task.progress === 'completed' || task.progress === 'cancelled') continue;
    for (const [alertId, alert] of Object.entries(task.alerts)) {
      if (!alert?.trigger) continue;
      if (alert.action && alert.action !== 'display') continue;
      if (alert.acknowledged) continue;
      const fireTimeMs = computeTaskFireTime(task, alert.trigger);
      if (fireTimeMs === null || fireTimeMs <= window.now || fireTimeMs > until) continue;
      out.push({
        key: buildAlertKey(task.id, alertId, fireTimeMs),
        eventId: task.id,
        alertId,
        fireTimeMs,
        title: task.title || '(No title)',
        body: 'Task due',
        kind: 'task',
        serverId: task.originalId ?? task.id,
        accountId: task.accountId,
      });
    }
  }

  out.sort((a, b) => a.fireTimeMs - b.fireTimeMs);
  return window.limit ? out.slice(0, window.limit) : out;
}
