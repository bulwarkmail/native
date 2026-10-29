import { describe, expect, it } from 'vitest';
import {
  agendaDays,
  busyBlocks,
  countdownTarget,
  dueKind,
  eventsOnDay,
  freeTime,
  monthGrid,
  nextEvent,
  sortTasks,
  startOfWeek,
} from '../derive';
import type { EventItem, TaskItem } from '../snapshot';

// Monday 28 September 2026, 09:05 local time.
const NOW = new Date(2026, 8, 28, 9, 5).getTime();
const at = (day: number, h: number, m = 0) => new Date(2026, 8, day, h, m).getTime();

function ev(id: string, start: number, end: number, extra: Partial<EventItem> = {}): EventItem {
  return {
    id,
    serverId: id,
    title: id,
    start,
    end,
    allDay: false,
    color: '#22c55e',
    calendarName: 'Work',
    participants: [],
    ...extra,
  };
}

const standup = ev('standup', at(28, 9, 30), at(28, 10));
const dentist = ev('dentist', at(29, 10), at(29, 11), { color: '#3b82f6' });
const lunch = ev('lunch', at(30, 12, 30), at(30, 13, 30));
const party = ev('party', new Date(2026, 9, 1).getTime(), new Date(2026, 9, 2).getTime(), { allDay: true, color: '#3b82f6' });
const review = ev('review', new Date(2026, 9, 1, 14).getTime(), new Date(2026, 9, 1, 16).getTime());
const trip = ev('trip', new Date(2026, 9, 4).getTime(), new Date(2026, 9, 5).getTime(), { allDay: true, color: '#3b82f6' });
const earlier = ev('earlier', at(28, 7), at(28, 8));
const EVENTS = [earlier, standup, dentist, lunch, party, review, trip];

describe('calendar views', () => {
  it('finds the next timed event and whether it is running', () => {
    expect(nextEvent(EVENTS, NOW)?.event.id).toBe('standup');
    expect(nextEvent(EVENTS, NOW)?.running).toBe(false);
    expect(nextEvent(EVENTS, at(28, 9, 45))?.running).toBe(true);
  });

  it('lists a day with all-day events first', () => {
    const thursday = new Date(2026, 9, 1).getTime();
    expect(eventsOnDay(EVENTS, thursday).map((e) => e.id)).toEqual(['party', 'review']);
  });

  it('drops finished events from today in the agenda', () => {
    const days = agendaDays(EVENTS, NOW, 3);
    expect(days.map((d) => d.events.map((e) => e.id))).toEqual([['standup'], ['dentist'], ['lunch']]);
  });

  it('starts the week on the configured day', () => {
    expect(new Date(startOfWeek(NOW, 1)).getDate()).toBe(28);
    expect(new Date(startOfWeek(NOW, 0)).getDate()).toBe(27);
  });

  it('builds the month as whole weeks with dots and today', () => {
    const weeks = monthGrid(EVENTS, NOW, 1);
    expect(weeks).toHaveLength(5);
    expect(weeks[0][0].day).toBe(31);
    expect(weeks[0][0].inMonth).toBe(false);
    const today = weeks.flat().find((c) => c.isToday);
    expect(today?.day).toBe(28);
    expect(today?.dots).toEqual(['#22c55e']);
  });

  it('places busy blocks inside working hours', () => {
    const [block] = busyBlocks(EVENTS, new Date(2026, 8, 29).getTime());
    expect(block.from).toBeCloseTo(0.2);
    expect(block.to).toBeCloseTo(0.3);
  });

  it('works out free time and the longest gap left today', () => {
    const free = freeTime(EVENTS, NOW);
    expect(free.busyNow).toBe(false);
    expect(free.next?.id).toBe('standup');
    expect(free.longestGap).toEqual({ from: at(28, 10), to: at(28, 18) });
  });

  it('counts down to the next all-day or multi-day event', () => {
    expect(countdownTarget(EVENTS, NOW)?.id).toBe('party');
  });
});

describe('tasks', () => {
  const task = (id: string, due: number | undefined, done = false, dueHasTime = false): TaskItem => ({
    id, serverId: id, title: id, due, dueHasTime, done, calendarName: 'Personal', color: '#3b82f6',
  });

  it('classifies due dates', () => {
    expect(dueKind(task('a', at(26, 0)), NOW)).toBe('overdue');
    expect(dueKind(task('b', at(28, 0)), NOW)).toBe('today');
    expect(dueKind(task('c', at(28, 8), false, true), NOW)).toBe('overdue');
    expect(dueKind(task('d', at(29, 0)), NOW)).toBe('tomorrow');
    expect(dueKind(task('e', undefined), NOW)).toBe('none');
  });

  it('puts overdue first and done last', () => {
    const sorted = sortTasks([
      task('done', at(20, 0), true),
      task('later', new Date(2026, 9, 3).getTime()),
      task('none', undefined),
      task('today', at(28, 0)),
      task('overdue', at(26, 0)),
    ], NOW);
    expect(sorted.map((t) => t.id)).toEqual(['overdue', 'today', 'later', 'none', 'done']);
  });
});
