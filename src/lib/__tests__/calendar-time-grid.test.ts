import { describe, it, expect } from 'vitest';
import type { CalendarEvent } from '../../api/types';
import {
  buildEventDayIndex,
  buildTimedFullDayWeekSegments,
  dayKey,
  isTimedEventFullDayOnDate,
} from '../calendar-utils';
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
  timedFullDaySegments,
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

describe('timedFullDaySegments', () => {
  const week = windowDays({ start: new Date(2026, 8, 7), end: new Date(2026, 8, 13) });

  it('finds the whole days a timed event covers', () => {
    // Tue 10:00 .. Fri 15:00 covers Wed and Thu in full.
    const segments = timedFullDaySegments([ev('trip', '2026-09-08T10:00:00', 'P3DT5H')], week);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ startIndex: 2, span: 2, continuesBefore: false, continuesAfter: false });
  });

  it('marks events that run past the given days', () => {
    const segments = timedFullDaySegments([ev('long', '2026-09-01T00:00:00', 'P20D')], week);
    expect(segments[0]).toMatchObject({ startIndex: 0, span: 7, continuesBefore: true, continuesAfter: true });
  });

  it('skips events that fill no whole day and all-day events', () => {
    const segments = timedFullDaySegments(
      [
        ev('meeting', '2026-09-08T10:00:00', 'PT1H'),
        ev('allday', '2026-09-08T00:00:00', 'P1D', { showWithoutTime: true }),
      ],
      week,
    );
    expect(segments).toEqual([]);
  });

  it('agrees with the per-day version', () => {
    const events = [
      ev('a', '2026-09-08T10:00:00', 'P3DT5H'),
      ev('b', '2026-09-07T00:00:00', 'P1D'),
      ev('c', '2026-09-12T00:00:00', 'P4D'),
      ev('d', '2026-09-09T08:00:00', 'PT2H'),
    ];
    const pick = (s: { event: CalendarEvent; startIndex: number; span: number; continuesBefore: boolean; continuesAfter: boolean }) =>
      `${s.event.id}:${s.startIndex}+${s.span}:${s.continuesBefore}:${s.continuesAfter}`;
    expect(timedFullDaySegments(events, week).map(pick).sort()).toEqual(
      buildTimedFullDayWeekSegments(events, week).map(pick).sort(),
    );
  });
});

describe('timedFullDaySegments across DST changes', () => {
  // Europe and the US change clocks on these weekends; whichever zone the
  // tests run in, the strip must agree with the grid's per-day test.
  const spans = [
    { start: new Date(2026, 2, 5), end: new Date(2026, 2, 31) },
    { start: new Date(2026, 9, 20), end: new Date(2026, 10, 5) },
  ];
  const events = [
    ev('conf-eu-spring', '2026-03-27T09:00:00', 'P4D'),
    ev('trip-us-spring', '2026-03-07T00:00:00', 'P3D'),
    ev('trip-eu-fall', '2026-10-24T00:00:00', 'P2D'),
    ev('camp-us-fall', '2026-10-30T12:00:00', 'P4DT2H'),
    ev('nearly', '2026-10-25T00:00:00', 'PT23H59M59S'),
  ];

  for (const span of spans) {
    const days = windowDays(span);

    it(`matches the per-day version (${dayKey(span.start)})`, () => {
      const key = (s: { event: CalendarEvent; startIndex: number; span: number; continuesBefore: boolean; continuesAfter: boolean }) =>
        `${s.event.id}:${s.startIndex}+${s.span}:${s.continuesBefore}:${s.continuesAfter}`;
      expect(timedFullDaySegments(events, days).map(key).sort()).toEqual(
        buildTimedFullDayWeekSegments(events, days).map(key).sort(),
      );
    });

    it(`puts an event in the strip exactly on the days the grid leaves it out (${dayKey(span.start)})`, () => {
      const segments = timedFullDaySegments(events, days);
      for (const event of events) {
        days.forEach((day, i) => {
          const inStrip = segments.some(
            (s) => s.event === event && i >= s.startIndex && i < s.startIndex + s.span,
          );
          expect(inStrip, `${event.id} on ${dayKey(day)}`).toBe(isTimedEventFullDayOnDate(event, day));
        });
      }
    });
  }
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
