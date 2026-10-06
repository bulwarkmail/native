import { describe, expect, it } from 'vitest';
import {
  calendarTaskEvents,
  filterTasksByCalendars,
  groupTasksByDueDay,
  isTaskDone,
  isTaskEvent,
  taskDueDayKey,
  taskIdOfEvent,
} from '../calendar-tasks';
import { allDayRowCounts, allDayStripLayout } from '../calendar-all-day';
import type { CalendarEvent } from '../../api/types';

// #1107: the month, week and day views place tasks on their due day and
// hide tasks from calendars switched off in the drawer.

function makeTask(id: string, overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id,
    '@type': 'Task',
    uid: id,
    title: 'Task ' + id,
    start: '',
    due: '2026-09-10',
    showWithoutTime: true,
    progress: 'needs-action',
    calendarIds: { 'cal-1': true },
    ...overrides,
  } as CalendarEvent;
}

describe('filterTasksByCalendars', () => {
  it('keeps tasks in at least one visible calendar', () => {
    const tasks = [
      makeTask('a', { calendarIds: { 'cal-1': true } }),
      makeTask('b', { calendarIds: { 'cal-2': true } }),
      makeTask('c', { calendarIds: { 'cal-2': true, 'cal-3': true } }),
    ];
    expect(filterTasksByCalendars(tasks, ['cal-1', 'cal-3']).map((t) => t.id)).toEqual(['a', 'c']);
    expect(filterTasksByCalendars(tasks, [])).toEqual([]);
  });
});

describe('taskDueDayKey', () => {
  it('is the local day of the due date, with or without a time', () => {
    expect(taskDueDayKey(makeTask('a', { due: '2026-09-10' }))).toBe('2026-09-10');
    expect(taskDueDayKey(makeTask('a', { due: '2026-09-10T23:30:00', showWithoutTime: false }))).toBe('2026-09-10');
  });

  it('is null for tasks without a usable due date', () => {
    expect(taskDueDayKey(makeTask('a', { due: undefined }))).toBeNull();
    expect(taskDueDayKey(makeTask('a', { due: 'not a date' }))).toBeNull();
  });
});

describe('groupTasksByDueDay', () => {
  it('groups by due day and skips tasks without one', () => {
    const map = groupTasksByDueDay([
      makeTask('a', { due: '2026-09-10' }),
      makeTask('b', { due: '2026-09-11' }),
      makeTask('c', { due: undefined }),
      makeTask('d', { due: '2026-09-10T09:00:00', showWithoutTime: false }),
    ]);
    expect([...map.keys()].sort()).toEqual(['2026-09-10', '2026-09-11']);
    expect(map.get('2026-09-10')?.map((t) => t.id).sort()).toEqual(['a', 'd']);
  });

  it('orders a day by untimed first, then due time, then title', () => {
    const map = groupTasksByDueDay([
      makeTask('late', { due: '2026-09-10T17:00:00', showWithoutTime: false, title: 'A' }),
      makeTask('early', { due: '2026-09-10T08:00:00', showWithoutTime: false, title: 'Z' }),
      makeTask('allday-b', { due: '2026-09-10', title: 'B' }),
      makeTask('allday-a', { due: '2026-09-10', title: 'A' }),
    ]);
    expect(map.get('2026-09-10')?.map((t) => t.id)).toEqual(['allday-a', 'allday-b', 'early', 'late']);
  });

  it('is empty for no tasks', () => {
    expect(groupTasksByDueDay(undefined).size).toBe(0);
    expect(groupTasksByDueDay([]).size).toBe(0);
  });
});

describe('calendarTaskEvents', () => {
  it('leaves out tasks of hidden calendars and tasks without a due date', () => {
    const out = calendarTaskEvents(
      [
        makeTask('shown'),
        makeTask('hidden', { calendarIds: { 'cal-2': true } }),
        makeTask('nodue', { due: undefined }),
      ],
      ['cal-1'],
    );
    expect(out.map((e) => e.id)).toEqual(['task:shown']);
  });

  it('keeps completed tasks, to be drawn struck through', () => {
    const [done] = calendarTaskEvents([makeTask('a', { progress: 'completed' })], ['cal-1']);
    expect(isTaskEvent(done)).toBe(true);
    expect(taskIdOfEvent(done)).toBe('a');
    expect(isTaskDone(done)).toBe(true);
    expect(isTaskDone(makeTask('b'))).toBe(false);
  });

  it('puts date-only and all-day tasks in the all-day strip', () => {
    const out = calendarTaskEvents(
      [
        makeTask('date', { due: '2026-09-10', showWithoutTime: undefined }),
        makeTask('allday', { due: '2026-09-10T00:00:00', showWithoutTime: true }),
        makeTask('timed', { due: '2026-09-10T09:00:00', showWithoutTime: false, timeZone: 'UTC' }),
      ],
      ['cal-1'],
    );
    const byId = Object.fromEntries(out.map((e) => [e.id, e]));
    expect(byId['task:date'].showWithoutTime).toBe(true);
    expect(byId['task:date'].start).toBe('2026-09-10T00:00:00');
    expect(byId['task:allday'].showWithoutTime).toBe(true);
    expect(byId['task:timed'].showWithoutTime).toBe(false);
    expect(byId['task:timed'].utcStart).toBe('2026-09-10T09:00:00.000Z');
  });

  it('counts all-day tasks toward the strip row cap', () => {
    const tasks = ['a', 'b', 'c', 'd'].map((id) => makeTask(id));
    const items = calendarTaskEvents(tasks, ['cal-1']).filter((e) => e.showWithoutTime);
    // Four one-day items on one column: four rows, three shown.
    const segments = items.map((_, row) => ({ startIndex: 0, span: 1, row }));
    expect(allDayStripLayout(allDayRowCounts(segments, 0, 7), false)).toEqual({
      visibleRows: 3,
      hiddenCount: 1,
      expandable: true,
    });
  });
});
