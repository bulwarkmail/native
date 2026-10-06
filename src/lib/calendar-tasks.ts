import { format, parseISO } from 'date-fns';
import type { CalendarEvent } from '../api/types';
import { getTaskDueDate } from './calendar-utils';

// Tasks shown on the calendar grid. Port of webmail's lib/calendar-tasks.ts
// (#1107): only tasks with a due date, and only those in a calendar the
// drawer currently shows, the same rule the events follow.

/** A task placed on the grid is an event whose id carries this prefix. */
export const TASK_EVENT_PREFIX = 'task:';

export function isTaskEvent(event: Pick<CalendarEvent, 'id'>): boolean {
  return event.id.startsWith(TASK_EVENT_PREFIX);
}

/** The task a grid task event stands for. */
export function taskIdOfEvent(event: Pick<CalendarEvent, 'id'>): string {
  return event.id.slice(TASK_EVENT_PREFIX.length);
}

/** Completed and cancelled tasks are drawn struck through. */
export function isTaskDone(task: Pick<CalendarEvent, 'progress'>): boolean {
  return task.progress === 'completed' || task.progress === 'cancelled';
}

export function filterTasksByCalendars(tasks: CalendarEvent[], selectedCalendarIds: string[]): CalendarEvent[] {
  const selected = new Set(selectedCalendarIds);
  return tasks.filter((task) => Object.keys(task.calendarIds ?? {}).some((id) => selected.has(id)));
}

/** yyyy-MM-dd of the day a task is due, or null when it has no valid due date. */
export function taskDueDayKey(task: Pick<CalendarEvent, 'due'>): string | null {
  if (!task.due) return null;
  const due = parseISO(task.due);
  if (Number.isNaN(due.getTime())) return null;
  return format(due, 'yyyy-MM-dd');
}

/**
 * Tasks keyed by the day they are due. Within a day, tasks without a time
 * come first, then by due time and title, so the order does not depend on
 * the order the server returned them in.
 */
export function groupTasksByDueDay(tasks: CalendarEvent[] | undefined): Map<string, CalendarEvent[]> {
  const map = new Map<string, CalendarEvent[]>();
  if (!tasks?.length) return map;
  for (const task of tasks) {
    const key = taskDueDayKey(task);
    if (!key) continue;
    const existing = map.get(key);
    if (existing) existing.push(task);
    else map.set(key, [task]);
  }
  for (const dayTasks of map.values()) {
    dayTasks.sort((a, b) => {
      const aTimed = a.showWithoutTime ? 0 : 1;
      const bTimed = b.showWithoutTime ? 0 : 1;
      if (aTimed !== bTimed) return aTimed - bTimed;
      const byDue = (a.due ?? '').localeCompare(b.due ?? '');
      if (byDue !== 0) return byDue;
      return (a.title ?? '').localeCompare(b.title ?? '');
    });
  }
  return map;
}

/**
 * The grid items for the tasks in `visibleCalendarIds`: a date-only or
 * all-day task is an all-day item (the week view's strip, where it counts
 * toward the row cap), a timed one a 30-minute block at its due instant.
 * Done tasks are kept, to be drawn struck through.
 */
export function calendarTaskEvents(tasks: CalendarEvent[], visibleCalendarIds: string[]): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const dayTasks of groupTasksByDueDay(filterTasksByCalendars(tasks, visibleCalendarIds)).values()) {
    for (const task of dayTasks) {
      const due = task.due as string;
      const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(due);
      const allDay = !!task.showWithoutTime || dateOnly;
      out.push({
        ...task,
        id: `${TASK_EVENT_PREFIX}${task.id}`,
        start: dateOnly ? `${due}T00:00:00` : due,
        showWithoutTime: allDay,
        duration: allDay ? 'P1D' : 'PT30M',
        // The due is wall time in the task's zone; place the block at the
        // instant, like events.
        utcStart: allDay ? undefined : getTaskDueDate(task)?.toISOString(),
        utcEnd: undefined,
        recurrenceRules: undefined,
        recurrenceId: undefined,
      });
    }
  }
  return out;
}
