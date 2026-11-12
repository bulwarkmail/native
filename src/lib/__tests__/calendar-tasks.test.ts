import { describe, it, expect } from 'vitest';
import { expandTaskOccurrences, seriesCompletionUpdates, taskChips } from '../calendar-tasks';
import type { CalendarEvent } from '../../api/types';

// #1621: task chips dropped the rules, so a repeating task showed only on its
// first due date.
const weekly = {
  id: 't1', '@type': 'Task', title: 'Bins', progress: 'needs-action',
  due: '2026-11-02T09:00:00', calendarIds: { c: true },
  recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly' }],
} as unknown as CalendarEvent;

const range = [new Date('2026-11-01T00:00:00'), new Date('2026-11-30T00:00:00')] as const;

describe('repeating tasks on the calendar', () => {
  it('shows a weekly task on every day it is due', () => {
    const { events, targets } = taskChips([weekly], ...range);
    expect(events.map((e) => e.start)).toEqual([
      '2026-11-02T09:00:00', '2026-11-09T09:00:00', '2026-11-16T09:00:00', '2026-11-23T09:00:00', '2026-11-30T09:00:00',
    ]);
    expect(new Set(events.map((e) => e.id)).size).toBe(5);
    expect(targets.get(events[1].id)).toEqual({ taskId: 't1', recurrenceId: '2026-11-09T09:00:00', completed: false });
  });

  it('honours overrides: a moved day, a done day, an excluded day', () => {
    const task = {
      ...weekly,
      recurrenceOverrides: {
        '2026-11-09T09:00:00': { due: '2026-11-10T18:00:00' },
        '2026-11-16T09:00:00': { progress: 'completed' },
        '2026-11-23T09:00:00': { excluded: true },
      },
    } as unknown as CalendarEvent;
    const { events, targets } = taskChips([task], ...range);
    expect(events.map((e) => e.start)).toEqual([
      '2026-11-02T09:00:00', '2026-11-10T18:00:00', '2026-11-16T09:00:00', '2026-11-30T09:00:00',
    ]);
    expect(events[2].title).toBe('☑ Bins');
    expect(targets.get(events[2].id)?.completed).toBe(true);
  });

  it('keeps a single task as one chip and leaves done ones out', () => {
    const single = { ...weekly, id: 's', recurrenceRules: undefined } as CalendarEvent;
    const done = { ...single, id: 'd', progress: 'completed' } as CalendarEvent;
    const { events, targets } = taskChips([single, done], ...range);
    expect(events.map((e) => e.id)).toEqual(['task:s']);
    expect(targets.get('task:s')).toEqual({ taskId: 's', completed: false });
  });

  it('reads an all-day task by its date', () => {
    const allDay = { ...weekly, due: '2026-11-02T00:00:00', showWithoutTime: true } as CalendarEvent;
    expect(expandTaskOccurrences([allDay], ...range).map((o) => o.recurrenceId).slice(0, 2))
      .toEqual(['2026-11-02T00:00:00', '2026-11-09T00:00:00']);
  });
});

describe('checking off a repeating task', () => {
  it('moves the series to its next due date and shifts the start along', () => {
    const task = { ...weekly, start: '2026-11-01T09:00:00' } as CalendarEvent;
    expect(seriesCompletionUpdates(task)).toEqual({
      progress: 'needs-action', due: '2026-11-09T09:00:00', start: '2026-11-08T09:00:00',
    });
  });

  it('uses up one of a counted rule', () => {
    const task = { ...weekly, recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'daily', count: 3 }] } as unknown as CalendarEvent;
    expect(seriesCompletionUpdates(task)).toMatchObject({
      due: '2026-11-03T09:00:00',
      recurrenceRules: [{ frequency: 'daily', count: 2 }],
    });
  });

  it('completes a task that does not repeat, or whose rule has run out', () => {
    expect(seriesCompletionUpdates({ ...weekly, recurrenceRules: undefined } as CalendarEvent)).toBeNull();
    const over = { ...weekly, recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'daily', until: '2026-11-02T09:00:00' }] } as unknown as CalendarEvent;
    expect(seriesCompletionUpdates(over)).toBeNull();
  });
});
