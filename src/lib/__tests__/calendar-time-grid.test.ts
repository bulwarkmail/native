import { describe, it, expect } from 'vitest';
import type { CalendarEvent } from '../../api/types';
import { buildEventDayIndex, dayKey } from '../calendar-utils';
import {
  computeScrollWindow,
  freshScrollWindowState,
  growScrollWindow,
} from '../calendar-scroll-window';
import {
  buildAllDaySegments,
  headerColumnRange,
  hourAtOffset,
  timeGridFocusColumn,
  windowDays,
} from '../calendar-time-grid';

const opts = { weekStartsOn: 1 as const };
const ev = (id: string, start: string, duration: string, extra: Partial<CalendarEvent> = {}) =>
  ({ id, title: id, start, duration, ...extra }) as CalendarEvent;

describe('windowDays', () => {
  it('has one column per day of the window, midnight to midnight', () => {
    const days = windowDays({ start: new Date(2026, 9, 24), end: new Date(2026, 9, 27) });
    expect(days.map(dayKey)).toEqual(['2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27']);
    // Across the DST change the days stay on local midnight.
    expect(days.every((d) => d.getHours() === 0)).toBe(true);
  });

  it('grows at the start by the added days only', () => {
    const state = freshScrollWindowState('day', new Date(2026, 8, 9));
    const before = windowDays(computeScrollWindow(state, opts));
    const after = windowDays(computeScrollWindow(growScrollWindow(state, 'before'), opts));
    expect(after.length - before.length).toBe(30);
    expect(after.slice(30).map(dayKey)).toEqual(before.map(dayKey));
  });
});

describe('timeGridFocusColumn', () => {
  const win = computeScrollWindow(
    growScrollWindow(freshScrollWindowState('week', new Date(2026, 8, 9)), 'before'),
    opts,
  );
  const count = windowDays(win).length;

  it('aligns the focused week in the week view', () => {
    const col = timeGridFocusColumn(win, new Date(2026, 8, 10), 'week', 1, count);
    expect(dayKey(windowDays(win)[col])).toBe('2026-09-07');
  });

  it('aligns the focused day in the day view', () => {
    const col = timeGridFocusColumn(win, new Date(2026, 8, 10, 15), 'day', 1, count);
    expect(dayKey(windowDays(win)[col])).toBe('2026-09-10');
  });

  it('stays inside the columns', () => {
    expect(timeGridFocusColumn(win, new Date(2020, 0, 1), 'day', 1, count)).toBe(0);
    expect(timeGridFocusColumn(win, new Date(2030, 0, 1), 'day', 1, count)).toBe(count - 1);
  });
});

describe('headerColumnRange', () => {
  it('covers the screen plus two screens either side', () => {
    expect(headerColumnRange(20, 7, 100)).toEqual({ from: 6, to: 40 });
    expect(headerColumnRange(20, 1, 100)).toEqual({ from: 18, to: 22 });
  });

  it('is clamped to the columns there are', () => {
    expect(headerColumnRange(0, 7, 10)).toEqual({ from: 0, to: 9 });
  });
});

describe('buildAllDaySegments', () => {
  const days = windowDays({ start: new Date(2026, 8, 7), end: new Date(2026, 8, 20) });

  it('cuts bars at every week so each part carries its title', () => {
    const index = buildEventDayIndex([
      ev('holiday', '2026-09-10T00:00:00', 'P7D', { showWithoutTime: true }),
    ]);
    const segments = buildAllDaySegments(index, days, 7);
    expect(segments.map((s) => [s.startIndex, s.span, s.continuesBefore, s.continuesAfter])).toEqual([
      [3, 4, false, true],
      [7, 3, true, false],
    ]);
  });

  it('cuts per day in the day view', () => {
    const index = buildEventDayIndex([
      ev('holiday', '2026-09-10T00:00:00', 'P2D', { showWithoutTime: true }),
    ]);
    expect(buildAllDaySegments(index, days, 1).map((s) => s.startIndex)).toEqual([3, 4]);
  });

  it('includes timed events that fill a day and packs overlaps into rows', () => {
    const index = buildEventDayIndex([
      ev('a', '2026-09-08T00:00:00', 'P2D', { showWithoutTime: true }),
      ev('b', '2026-09-09T00:00:00', 'P1D', { showWithoutTime: true }),
      ev('c', '2026-09-08T00:00:00', 'P1D'),
      ev('meeting', '2026-09-08T10:00:00', 'PT1H'),
    ]);
    const segments = buildAllDaySegments(index, days, 7);
    expect(segments.map((s) => s.event.id).sort()).toEqual(['a', 'b', 'c']);
    const rows = Math.max(...segments.map((s) => s.row)) + 1;
    expect(rows).toBe(2);
  });

  it('is empty without all-day events', () => {
    const index = buildEventDayIndex([ev('meeting', '2026-09-08T10:00:00', 'PT1H')]);
    expect(buildAllDaySegments(index, days, 7)).toEqual([]);
  });
});

describe('hourAtOffset', () => {
  it('maps a press in a column to its hour', () => {
    expect(hourAtOffset(0, 48)).toBe(0);
    expect(hourAtOffset(47.9, 48)).toBe(0);
    expect(hourAtOffset(48 * 13 + 5, 48)).toBe(13);
    expect(hourAtOffset(48 * 30, 48)).toBe(23);
    expect(hourAtOffset(-4, 48)).toBe(0);
  });
});
