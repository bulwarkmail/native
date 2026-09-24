import React from 'react';
import type { CalendarEvent } from '../api/types';
import { getEvents } from '../api/calendar';
import {
  loadEventsInRange,
  mapServerEventToStoreEvent,
  useCalendarStore,
} from '../stores/calendar-store';
import { useLocaleStore } from '../stores/locale-store';
import { useToastStore } from '../stores/toast-store';
import { seriesIdOf } from './recurrence-instances';
import {
  usePendingCalendarOpen,
  type CalendarReminderTarget,
} from '../navigation/pending-calendar-open';

// Opening the event or task behind a tapped calendar reminder. The reminder
// was scheduled from its own upcoming window (calendar-notifications), so the
// event is usually not among the ones the Calendar tab has loaded; it is
// looked up by its server identity instead of the store id alone, which for
// an expanded occurrence only lives as long as the loaded window.

const DAY_MS = 24 * 60 * 60 * 1000;

function matchesTarget(event: CalendarEvent, target: CalendarReminderTarget): boolean {
  if (event.id === target.eventId) return true;
  if (!target.serverId || seriesIdOf(event) !== target.serverId) return false;
  return (event.accountId ?? undefined) === (target.accountId ?? undefined)
    && (event.recurrenceId ?? undefined) === (target.recurrenceId ?? undefined);
}

/**
 * The event (or occurrence) a reminder points at: from the loaded window,
 * else from the day around its start, else the stored event itself (a
 * series' base event when the occurrence moved away). `null` when it no
 * longer exists.
 */
export async function resolveReminderEvent(
  target: CalendarReminderTarget,
): Promise<CalendarEvent | null> {
  const store = useCalendarStore.getState();
  const loaded = store.events.find((e) => matchesTarget(e, target));
  if (loaded) return loaded;

  if (store.calendars.length === 0) await store.fetchCalendars();
  const { calendars } = useCalendarStore.getState();
  if (target.startMs !== undefined && calendars.length > 0) {
    try {
      const around = await loadEventsInRange(
        calendars,
        calendars.map((c) => c.id),
        new Date(target.startMs - DAY_MS).toISOString(),
        new Date(target.startMs + DAY_MS).toISOString(),
      );
      const found = around.find((e) => matchesTarget(e, target));
      if (found) return found;
    } catch {
      // Try the event itself below.
    }
  }
  if (!target.serverId) return null;
  const [event] = await getEvents([target.serverId], target.accountId);
  return event ? mapServerEventToStoreEvent(event, calendars, target.accountId) : null;
}

/** The task a reminder points at, loading the tasks when they aren't yet. */
export async function resolveReminderTask(
  target: CalendarReminderTarget,
): Promise<CalendarEvent | null> {
  const find = () => useCalendarStore.getState().tasks.find((task) =>
    task.id === target.eventId
    || (!!target.serverId
      && seriesIdOf(task) === target.serverId
      && (task.accountId ?? undefined) === (target.accountId ?? undefined)));
  const loaded = find();
  if (loaded) return loaded;
  const store = useCalendarStore.getState();
  if (store.calendars.length === 0) await store.fetchCalendars();
  await useCalendarStore.getState().fetchTasks();
  return find() ?? null;
}

export interface ReminderOpenHandlers {
  onEvent: (event: CalendarEvent) => void;
  onTask: (taskId: string) => void;
}

/** Open what the reminder points at; says so when it is gone. */
export async function openReminderTarget(
  target: CalendarReminderTarget,
  handlers: ReminderOpenHandlers,
): Promise<boolean> {
  try {
    if (target.kind === 'task') {
      const task = await resolveReminderTask(target);
      if (task) {
        handlers.onTask(task.id);
        return true;
      }
    } else {
      const event = await resolveReminderEvent(target);
      if (event) {
        handlers.onEvent(event);
        return true;
      }
    }
  } catch {
    // Offline or refused: report it like a missing event.
  }
  const t = useLocaleStore.getState().t;
  useToastStore.getState().addToast({
    type: 'error',
    title: target.kind === 'task'
      ? t('calendar.tasks.not_found', 'This task is no longer available.')
      : t('deep_link.event_not_found', 'This event is no longer available.'),
  });
  return false;
}

/**
 * For the Calendar tab: open the event or task of a tapped reminder
 * (parked in pending-calendar-open by the notification response listener).
 */
export function useCalendarReminderOpen(handlers: ReminderOpenHandlers): void {
  const pending = usePendingCalendarOpen((s) => s.target);
  const handlersRef = React.useRef(handlers);
  handlersRef.current = handlers;
  React.useEffect(() => {
    if (!pending) return;
    const target = usePendingCalendarOpen.getState().consume();
    if (!target) return;
    void openReminderTarget(target, {
      onEvent: (event) => handlersRef.current.onEvent(event),
      onTask: (id) => handlersRef.current.onTask(id),
    });
  }, [pending]);
}
