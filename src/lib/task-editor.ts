import { format } from 'date-fns';
import type { CalendarEvent } from '../api/types';
import { getTaskDueDisplayDate, isDateOnlyDue } from './calendar-utils';
import {
  formatWallClock,
  fromDisplayDate,
  getEffectiveTimeZone,
  isValidTimeZone,
} from './calendar-timezone';

export type PriorityLevel = 'none' | 'high' | 'medium' | 'low';

// RFC 8984 priority 0-9 <-> the three levels the editor offers (webmail's
// task-modal mapping).
export function priorityToLevel(p: number | undefined): PriorityLevel {
  if (p === undefined) return 'none';
  if (p >= 1 && p <= 4) return 'high';
  if (p === 5) return 'medium';
  if (p >= 6 && p <= 9) return 'low';
  return 'none';
}

export function levelToPriority(l: PriorityLevel): number {
  switch (l) {
    case 'high': return 1;
    case 'medium': return 5;
    case 'low': return 9;
    default: return 0;
  }
}

/** What the tasks sheet's inline editor holds while the user types. */
export interface TaskEditorState {
  id: string | null;
  title: string;
  description: string;
  due: Date | null;
  withTime: boolean;
  priority: PriorityLevel;
  calendarId: string;
}

export function emptyTaskEditor(calendarId: string): TaskEditorState {
  return { id: null, title: '', description: '', due: null, withTime: false, priority: 'none', calendarId };
}

export function taskEditorFromTask(
  task: Pick<CalendarEvent, 'id' | 'title' | 'description' | 'due' | 'timeZone' | 'showWithoutTime' | 'priority' | 'calendarIds'>,
  fallbackCalendarId: string,
): TaskEditorState {
  return {
    id: task.id,
    title: task.title || '',
    description: task.description || '',
    // In the calendar's time zone, like events (see getTaskDueDisplayDate).
    due: getTaskDueDisplayDate(task),
    withTime: !!task.due && !isDateOnlyDue(task),
    priority: priorityToLevel(task.priority),
    calendarId: Object.keys(task.calendarIds || {})[0] || fallbackCalendarId,
  };
}

type ExistingTask = Pick<CalendarEvent, 'calendarIds'>
  & Partial<Pick<CalendarEvent, 'id' | 'title' | 'due' | 'timeZone' | 'showWithoutTime'>>;

/** Did the editor leave the due of `existing` as it was shown? */
function dueUnchanged(editor: TaskEditorState, existing: ExistingTask | undefined): boolean {
  if (!existing?.due || !editor.due) return false;
  const shown = getTaskDueDisplayDate(existing as Pick<CalendarEvent, 'due' | 'timeZone' | 'showWithoutTime'>);
  return !!shown
    && shown.getTime() === editor.due.getTime()
    && editor.withTime === !isDateOnlyDue(existing);
}

/**
 * The task properties the editor writes. `existing` is the task being
 * edited (undefined for a new one); a changed calendar is only sent when it
 * differs from the one the task is in. A due the user left alone is not
 * sent at all, so saving never moves it; a changed one is converted from the
 * calendar's zone into the zone the task lives in.
 */
export function buildTaskEditorChanges(
  editor: TaskEditorState,
  existing?: ExistingTask,
): Partial<CalendarEvent> {
  const data: Partial<CalendarEvent> = {
    title: editor.title.trim(),
    description: editor.description.trim(),
    priority: levelToPriority(editor.priority),
  };
  if (editor.id && dueUnchanged(editor, existing)) {
    // Keep the stored due, zone and all-day flag.
  } else if (editor.due) {
    if (editor.withTime) {
      // The editor shows the due as a wall clock in the calendar's zone.
      // Keep a timed task in its own zone; a new, floating or date-only one
      // takes the calendar's.
      const ownZone = existing?.due && !isDateOnlyDue(existing) && isValidTimeZone(existing.timeZone)
        ? existing.timeZone
        : null;
      const zone = ownZone ?? getEffectiveTimeZone();
      data.due = formatWallClock(fromDisplayDate(editor.due), zone);
      data.showWithoutTime = false;
      data.timeZone = zone;
    } else {
      data.due = format(editor.due, "yyyy-MM-dd'T'00:00:00");
      data.showWithoutTime = true;
      data.timeZone = null;
    }
  } else if (editor.id) {
    data.due = null;
  }
  if (editor.id) {
    const currentCalendar = existing ? Object.keys(existing.calendarIds || {})[0] : undefined;
    if (editor.calendarId && currentCalendar && editor.calendarId !== currentCalendar) {
      data.calendarIds = { [editor.calendarId]: true };
    }
  }
  return data;
}

export type TaskSaveResult = { ok: true } | { ok: false; message?: string };

/**
 * Create or update the task in the editor. Never throws: a refusal comes
 * back as `{ ok: false }` with the server's reason, so the sheet can say so
 * and keep what the user typed instead of clearing the editor.
 */
export async function submitTaskEditor(
  editor: TaskEditorState,
  tasks: CalendarEvent[],
  handlers: {
    onCreate: (task: Partial<CalendarEvent>, calendarId: string) => Promise<void> | void;
    onUpdate?: (id: string, changes: Partial<CalendarEvent>) => Promise<void> | void;
  },
): Promise<TaskSaveResult> {
  try {
    if (editor.id) {
      const existing = tasks.find((task) => task.id === editor.id);
      await handlers.onUpdate?.(editor.id, buildTaskEditorChanges(editor, existing));
    } else {
      await handlers.onCreate(
        { ...buildTaskEditorChanges(editor), progress: 'needs-action' },
        editor.calendarId,
      );
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error && err.message ? err.message : undefined };
  }
}
