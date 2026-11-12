// Repeating tasks on the calendar grid and their tick. Ported from the
// webmail's lib/calendar-tasks.ts and the toggle in stores/task-store.ts
// (#1621): a repeating task shows on every day it is due, an occurrence is
// ticked through the series' recurrenceOverrides, and checking off the series
// itself moves it to its next due (or start) date.
import { endOfDay, format, parseISO, startOfDay } from 'date-fns';
import type { CalendarEvent } from '../api/types';
import { generateDates, getNextRecurrenceDate } from './recurrence-expansion';
import { getTaskDueDate } from './calendar-utils';

type TaskOverride = Partial<CalendarEvent> & { excluded?: boolean };

/** One day a repeating task is due on, as the series has it then. */
export interface TaskOccurrence {
  /** The series: the task as the store holds it. */
  series: CalendarEvent;
  /** The recurrenceOverrides key of this occurrence. */
  recurrenceId: string;
  /** The series with this occurrence's due and its override applied. */
  task: CalendarEvent;
}

/**
 * recurrenceOverrides key of a task occurrence. JSCalendar keys overrides by
 * LocalDateTime, also for all-day tasks (T00:00:00), as the event expansion does.
 */
export function taskRecurrenceId(task: Pick<CalendarEvent, 'showWithoutTime'>, date: Date): string {
  return format(date, task.showWithoutTime ? "yyyy-MM-dd'T'00:00:00" : "yyyy-MM-dd'T'HH:mm:ss");
}

/** Override for an occurrence; also finds entries written under the former date-only key. */
export function findTaskOverride(
  overrides: Record<string, unknown> | null | undefined,
  recurrenceId: string,
): TaskOverride | undefined {
  if (!overrides) return undefined;
  return (overrides[recurrenceId]
    ?? (recurrenceId.endsWith('T00:00:00') ? overrides[recurrenceId.slice(0, 10)] : undefined)) as TaskOverride | undefined;
}

function occurrence(task: CalendarEvent, date: Date, recurrenceId: string, override: TaskOverride | undefined): TaskOccurrence {
  const key = format(date, 'yyyy-MM-dd');
  const { excluded: _excluded, ...fields } = override ?? {};
  return {
    series: task,
    recurrenceId,
    task: {
      ...task,
      ...fields,
      // Still the series' own ids: the occurrence is written through it.
      id: task.id,
      originalId: task.originalId,
      due: override?.due || (task.showWithoutTime ? key : format(date, "yyyy-MM-dd'T'HH:mm:ss")),
    },
  };
}

/**
 * The days each repeating task is due on between `rangeStart` and
 * `rangeEnd`, with the series' overrides applied; excluded days are left
 * out. Tasks that don't repeat, or have no valid due date, give none.
 */
export function expandTaskOccurrences(tasks: CalendarEvent[], rangeStart: Date, rangeEnd: Date): TaskOccurrence[] {
  const from = startOfDay(rangeStart);
  const until = endOfDay(rangeEnd);
  const out: TaskOccurrence[] = [];
  for (const task of tasks) {
    if (!task.due || !task.recurrenceRules?.length) continue;
    const due = parseISO(task.due);
    if (Number.isNaN(due.getTime())) continue;
    const overrides = (task.recurrenceOverrides || {}) as Record<string, TaskOverride>;
    const seen = new Set<string>();
    for (const rule of task.recurrenceRules) {
      for (const date of generateDates(due, rule, from, until, true)) {
        const key = format(date, 'yyyy-MM-dd');
        if (seen.has(key)) continue;
        seen.add(key);
        const recurrenceId = taskRecurrenceId(task, date);
        const override = findTaskOverride(overrides, recurrenceId);
        if (override?.excluded) continue;
        out.push(occurrence(task, date, recurrenceId, override));
      }
    }
    // Overrides on dates the rules don't give (an RDATE, a moved occurrence).
    for (const [overrideKey, override] of Object.entries(overrides)) {
      if (!override || override.excluded) continue;
      const date = parseISO(overrideKey);
      if (Number.isNaN(date.getTime()) || date < from || date > until) continue;
      const key = format(date, 'yyyy-MM-dd');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(occurrence(task, date, taskRecurrenceId(task, date), override));
    }
  }
  return out;
}

/** Prefix of a task chip's id on the grid (calendar-time-grid's TASK_CHIP_ID_PREFIX). */
const CHIP_PREFIX = 'task:';
/** Between a series' id and an occurrence's recurrenceId in a chip id; in no JMAP id. */
const OCCURRENCE_SEP = '#occ#';

/** What a tap on a task chip acts on: the task, and for an occurrence its recurrenceId. */
export interface TaskChipTarget {
  taskId: string;
  recurrenceId?: string;
  completed: boolean;
}

/**
 * Task chips for the calendar grid between `rangeStart` and `rangeEnd`: open
 * tasks with a due date on the day they are due, a repeating task on every
 * day it is due. A done occurrence stays on the grid (ticked) so it can be
 * opened again; a done or cancelled task that doesn't repeat is left out.
 */
export function taskChips(
  tasks: CalendarEvent[],
  rangeStart: Date,
  rangeEnd: Date,
): { events: CalendarEvent[]; targets: Map<string, TaskChipTarget> } {
  const events: CalendarEvent[] = [];
  const targets = new Map<string, TaskChipTarget>();
  const chip = (task: CalendarEvent, chipId: string, done: boolean): CalendarEvent => {
    const due = task.due!;
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(due);
    const allDay = !!task.showWithoutTime || dateOnly;
    return {
      ...task,
      id: chipId,
      start: dateOnly ? `${due}T00:00:00` : due,
      showWithoutTime: allDay,
      duration: allDay ? 'P1D' : 'PT30M',
      // The due is wall time in the task's zone; place the chip at the
      // instant, like events.
      utcStart: allDay ? undefined : getTaskDueDate(task)?.toISOString(),
      utcEnd: undefined,
      title: `${done ? '☑' : '☐'} ${task.title || ''}`.trim(),
      recurrenceRules: undefined,
      recurrenceOverrides: undefined,
      recurrenceId: undefined,
    };
  };
  for (const task of tasks) {
    if (!task.due || task.recurrenceRules?.length) continue;
    if (task.progress === 'completed' || task.progress === 'cancelled') continue;
    const chipId = `${CHIP_PREFIX}${task.id}`;
    events.push(chip(task, chipId, false));
    targets.set(chipId, { taskId: task.id, completed: false });
  }
  for (const occ of expandTaskOccurrences(tasks, rangeStart, rangeEnd)) {
    if (occ.task.progress === 'cancelled') continue;
    const done = occ.task.progress === 'completed';
    const chipId = `${CHIP_PREFIX}${occ.series.id}${OCCURRENCE_SEP}${occ.recurrenceId}`;
    events.push(chip(occ.task, chipId, done));
    targets.set(chipId, { taskId: occ.series.id, recurrenceId: occ.recurrenceId, completed: done });
  }
  return { events, targets };
}

/**
 * JMAP patch setting one override on the series: a patch path into an
 * existing recurrenceOverrides map, the whole map when there is none yet.
 */
export function overridePatch(
  series: Pick<CalendarEvent, 'recurrenceOverrides'>,
  recurrenceId: string,
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const clean = { ...entry };
  if (typeof clean.due === 'string' && !clean.due.includes('T')) clean.due = `${clean.due}T00:00:00`;
  return Object.keys(series.recurrenceOverrides ?? {}).length > 0
    ? { [`recurrenceOverrides/${recurrenceId}`]: clean }
    : { recurrenceOverrides: { [recurrenceId]: clean } };
}

/** The override entry that ticks (or unticks) one occurrence, keeping what the entry had. */
export function occurrenceToggleEntry(series: CalendarEvent, recurrenceId: string): Record<string, unknown> {
  const existing = findTaskOverride(series.recurrenceOverrides, recurrenceId) ?? {};
  const progress = existing.progress ?? series.progress;
  const entry: Record<string, unknown> = {
    ...existing,
    progress: progress === 'completed' ? 'needs-action' : 'completed',
  };
  for (const key of ['id', 'uid', '@type', 'calendarIds', 'recurrenceRules', 'recurrenceOverrides']) delete entry[key];
  return entry;
}

/**
 * What checking off a repeating task does to the series: it moves to its next
 * due date (a series without one, by its start), its start shifted along,
 * and stays open. A rule with a count loses the occurrence that was done.
 * Null when the task doesn't repeat, is already done, or has no next date:
 * then the tick completes it as any other task.
 */
export function seriesCompletionUpdates(task: CalendarEvent): Partial<CalendarEvent> | null {
  const ref = task.due || task.start;
  if (task.progress === 'completed' || !task.recurrenceRules?.length || !ref) return null;
  const refDate = parseISO(ref);
  if (Number.isNaN(refDate.getTime())) return null;
  const nextDate = getNextRecurrenceDate(refDate, task.recurrenceRules[0]);
  if (!nextDate) return null;
  // LocalDateTime also for all-day tasks: keeps consistency across serializations.
  const pattern = task.showWithoutTime ? "yyyy-MM-dd'T'00:00:00" : "yyyy-MM-dd'T'HH:mm:ss";
  const newDue = task.due ? format(nextDate, pattern) : null;
  let newStart = task.start && !task.due ? format(nextDate, pattern) : task.start;
  if (task.start && task.due) {
    const oldDue = parseISO(task.due);
    const oldStart = parseISO(task.start);
    if (!Number.isNaN(oldDue.getTime()) && !Number.isNaN(oldStart.getTime())) {
      newStart = format(new Date(oldStart.getTime() + nextDate.getTime() - oldDue.getTime()), pattern);
    }
  }
  // Moving the anchor restarts the count, so the completed occurrence is used up here.
  const [rule, ...otherRules] = task.recurrenceRules;
  return {
    progress: 'needs-action',
    ...(newDue ? { due: newDue } : {}),
    ...(newStart ? { start: newStart } : {}),
    ...(rule.count != null ? { recurrenceRules: [{ ...rule, count: rule.count - 1 }, ...otherRules] } : {}),
  };
}
