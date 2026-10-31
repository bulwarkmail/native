import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { CalendarEvent } from '../../api/types';
import type { CalendarWeekSegment } from '../calendar-utils';
import {
  ALL_DAY_COLLAPSED_ROWS,
  allDayRowsInView,
  packAllDaySegments,
  shownAllDayRows,
} from '../calendar-time-grid';

// The week grids' all-day area was sized from every week of the scroll
// window, packed task chips in among the events, and grew without limit
// (file 10 "week all-day area (#1122)"). Webmail calendar-week-view.

const seg = (id: string, startIndex: number, span = 1, title = id): CalendarWeekSegment => ({
  event: { id, title, start: '2026-11-02T00:00:00', showWithoutTime: true } as CalendarEvent,
  startIndex,
  span,
  row: 0,
  continuesBefore: false,
  continuesAfter: false,
});

const rowsOf = (segments: CalendarWeekSegment[]) =>
  Object.fromEntries(segments.map((s) => [s.event.id, s.row]));

describe('week all-day area', () => {
  it("stacks each day's tasks under that day's events", () => {
    // "a task" sorts before "b event" by title; packed together it took row 0.
    const packed = packAllDaySegments([
      seg('task:1', 1, 1, 'a task'),
      seg('trip', 0, 3, 'b trip'),
      seg('event', 1, 1, 'b event'),
      seg('task:2', 1, 1, 'c task'),
      seg('task:3', 4, 1, 'd task'),
    ]);
    expect(rowsOf(packed)).toEqual({ trip: 0, event: 1, 'task:1': 2, 'task:2': 3, 'task:3': 0 });
  });

  it('is sized from the days in view', () => {
    const packed = packAllDaySegments([seg('a', 0), seg('b', 0), seg('c', 0), seg('d', 0), seg('e', 8)]);
    expect(allDayRowsInView(packed, 0, 6)).toBe(4);
    // The next week holds one event: no empty rows from the crowded day.
    expect(allDayRowsInView(packed, 7, 13)).toBe(1);
    expect(allDayRowsInView(packed, 14, 20)).toBe(0);
  });

  it('shows three rows until expanded', () => {
    expect(ALL_DAY_COLLAPSED_ROWS).toBe(3);
    expect(shownAllDayRows(5, false)).toBe(3);
    expect(shownAllDayRows(5, true)).toBe(5);
    expect(shownAllDayRows(2, false)).toBe(2);
  });

  // No RN renderer in the test env: check the grids' wiring.
  it('is drawn that way by both week grids', () => {
    const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '../../components/calendar', rel), 'utf8');
    const scroll = read('TimeGridScrollView.tsx');
    expect(scroll).toMatch(/allDayRowsInView\(allDaySegments, anchorIndex, anchorIndex \+ perScreen - 1\)/);
    expect(scroll).toMatch(/s\.row < allDayShownRows/);
    expect(scroll).toMatch(/<AllDayToggle/);
    const week = read('WeekView.tsx');
    expect(week).toMatch(/return packAllDaySegments\(\[\.\.\.explicit, \.\.\.timedFull\]\);/);
    expect(week).toMatch(/allDaySegments\.filter\(\(segment\) => segment\.row < allDayRowCount\)/);
    expect(week).toMatch(/<AllDayToggle/);
  });
});
