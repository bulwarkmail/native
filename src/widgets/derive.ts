// Views that depend on the current time, computed when a widget draws rather
// than when the snapshot was fetched. Pure functions of (snapshot, now), so
// they are unit-tested without the widget runtime.

import { addDays, startOfDay } from './format';
import type { EventItem, TaskItem, WidgetSnapshot } from './snapshot';

const DAY = 86400000;

/** Events overlapping [dayStart, dayStart + 1 day), all-day first, then by start. */
export function eventsOnDay(events: EventItem[], dayStart: number): EventItem[] {
  const dayEnd = addDays(dayStart, 1);
  return events
    .filter((e) => e.start < dayEnd && (e.end > dayStart || (e.end === e.start && e.start >= dayStart)))
    .sort((a, b) => (a.allDay === b.allDay ? a.start - b.start : a.allDay ? -1 : 1));
}

/** Timed events that have not ended yet, soonest first. */
export function upcomingTimed(events: EventItem[], now: number): EventItem[] {
  return events.filter((e) => !e.allDay && e.end > now).sort((a, b) => a.start - b.start);
}

/** The next timed event (running or upcoming) and whether it has started. */
export function nextEvent(events: EventItem[], now: number): { event: EventItem; running: boolean } | null {
  const [event] = upcomingTimed(events, now);
  if (!event) return null;
  return { event, running: event.start <= now };
}

export interface AgendaDay {
  dayStart: number;
  events: EventItem[];
}

/**
 * Days from today with at least one event still relevant (today drops the
 * events that already ended), up to `maxDays` days with events.
 */
export function agendaDays(events: EventItem[], now: number, maxDays: number, horizonDays = 14): AgendaDay[] {
  const out: AgendaDay[] = [];
  const today = startOfDay(now);
  for (let i = 0; i < horizonDays && out.length < maxDays; i++) {
    const day = addDays(today, i);
    const list = eventsOnDay(events, day).filter((e) => i > 0 || e.allDay || e.end > now);
    if (list.length > 0) out.push({ dayStart: day, events: list });
  }
  return out;
}

/** Start of the week containing `ms` for the given first weekday (0 Sun, 1 Mon). */
export function startOfWeek(ms: number, weekStart: 0 | 1): number {
  const day = startOfDay(ms);
  const dow = new Date(day).getDay();
  const diff = (dow - weekStart + 7) % 7;
  return addDays(day, -diff);
}

export interface MonthCell {
  dayStart: number;
  day: number;
  inMonth: boolean;
  isToday: boolean;
  /** Distinct calendar colours with events that day, at most three. */
  dots: string[];
}

/** The month containing `now` as whole weeks (5 or 6 rows). */
export function monthGrid(events: EventItem[], now: number, weekStart: 0 | 1): MonthCell[][] {
  const first = new Date(now);
  first.setDate(1);
  first.setHours(0, 0, 0, 0);
  const month = first.getMonth();
  const today = startOfDay(now);
  let cursor = startOfWeek(first.getTime(), weekStart);
  const weeks: MonthCell[][] = [];
  do {
    const week: MonthCell[] = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(cursor);
      const dots: string[] = [];
      for (const e of eventsOnDay(events, cursor)) {
        if (!dots.includes(e.color)) dots.push(e.color);
        if (dots.length === 3) break;
      }
      week.push({
        dayStart: cursor,
        day: d.getDate(),
        inMonth: d.getMonth() === month,
        isToday: cursor === today,
        dots,
      });
      cursor = addDays(cursor, 1);
    }
    weeks.push(week);
  } while (new Date(cursor).getMonth() === month);
  return weeks;
}

export interface BusyBlock {
  /** Fraction of the visible window, 0..1. */
  from: number;
  to: number;
  color: string;
}

/**
 * Timed events of one day clipped to [startHour, endHour) as fractions of that
 * window - the week and free-time bars.
 */
export function busyBlocks(events: EventItem[], dayStart: number, startHour = 8, endHour = 18): BusyBlock[] {
  const winStart = dayStart + startHour * 3600000;
  const winEnd = dayStart + endHour * 3600000;
  const span = winEnd - winStart;
  return eventsOnDay(events, dayStart)
    .filter((e) => !e.allDay && e.end > winStart && e.start < winEnd)
    .map((e) => ({
      from: (Math.max(e.start, winStart) - winStart) / span,
      to: (Math.min(e.end, winEnd) - winStart) / span,
      color: e.color,
    }));
}

export interface FreeTime {
  /** The next timed event today, if any. */
  next: EventItem | null;
  /** True when an event is running right now. */
  busyNow: boolean;
  /** Longest free stretch left today inside working hours, if any. */
  longestGap: { from: number; to: number } | null;
}

export function freeTime(events: EventItem[], now: number, startHour = 8, endHour = 18): FreeTime {
  const today = startOfDay(now);
  const winEnd = today + endHour * 3600000;
  const timed = eventsOnDay(events, today).filter((e) => !e.allDay);
  const busyNow = timed.some((e) => e.start <= now && e.end > now);
  const next = timed.find((e) => e.start > now) ?? null;

  let cursor = Math.max(now, today + startHour * 3600000);
  let longest: { from: number; to: number } | null = null;
  for (const e of timed.filter((x) => x.end > cursor).sort((a, b) => a.start - b.start)) {
    if (e.start > cursor) {
      const gap = { from: cursor, to: Math.min(e.start, winEnd) };
      if (gap.to > gap.from && (!longest || gap.to - gap.from > longest.to - longest.from)) longest = gap;
    }
    cursor = Math.max(cursor, e.end);
    if (cursor >= winEnd) break;
  }
  if (cursor < winEnd) {
    const gap = { from: cursor, to: winEnd };
    if (!longest || gap.to - gap.from > longest.to - longest.from) longest = gap;
  }
  return { next, busyNow, longestGap: longest };
}

export type DueKind = 'overdue' | 'today' | 'tomorrow' | 'later' | 'none';

export function dueKind(task: TaskItem, now: number): DueKind {
  if (task.due === undefined) return 'none';
  const today = startOfDay(now);
  const dueDay = startOfDay(task.due);
  if (task.dueHasTime ? task.due < now : dueDay < today) return 'overdue';
  if (dueDay === today) return 'today';
  if (dueDay === addDays(today, 1)) return 'tomorrow';
  return 'later';
}

/** Open tasks first (overdue, then by due date, undated last), completed after. */
export function sortTasks(tasks: TaskItem[], now: number): TaskItem[] {
  const rank: Record<DueKind, number> = { overdue: 0, today: 1, tomorrow: 2, later: 3, none: 4 };
  return [...tasks].sort((a, b) => {
    if (a.done !== b.done) return a.done ? 1 : -1;
    const ra = rank[dueKind(a, now)];
    const rb = rank[dueKind(b, now)];
    if (ra !== rb) return ra - rb;
    return (a.due ?? Number.MAX_SAFE_INTEGER) - (b.due ?? Number.MAX_SAFE_INTEGER);
  });
}

/** Tasks that count for "today": overdue, due today, or completed today-ish. */
export function tasksDueNow(tasks: TaskItem[], now: number): TaskItem[] {
  return tasks.filter((t) => {
    const kind = dueKind(t, now);
    return kind === 'overdue' || kind === 'today';
  });
}

/**
 * The event a countdown should point at: the next all-day or multi-day event
 * that starts after today, else the next timed event on a later day.
 */
export function countdownTarget(events: EventItem[], now: number): EventItem | null {
  const tomorrow = addDays(startOfDay(now), 1);
  const later = events.filter((e) => e.start >= tomorrow).sort((a, b) => a.start - b.start);
  return later.find((e) => e.allDay || e.end - e.start >= DAY) ?? later[0] ?? null;
}

export function daysUntil(ms: number, now: number): number {
  return Math.round((startOfDay(ms) - startOfDay(now)) / DAY);
}

/** Birthdays in the next `days` days, soonest first. */
export function upcomingBirthdays(snapshot: WidgetSnapshot, now: number, days = 45) {
  const today = startOfDay(now);
  const until = addDays(today, days);
  return snapshot.calendar.birthdays
    .filter((b) => b.date >= today && b.date < until)
    .sort((a, b) => a.date - b.date);
}
