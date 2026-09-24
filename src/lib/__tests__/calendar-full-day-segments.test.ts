import { describe, it, expect } from 'vitest';
import { addDays } from 'date-fns';
import type { CalendarEvent } from '../../api/types';
import {
  buildTimedFullDayWeekSegments,
  dayKey,
  isTimedEventFullDayOnDate,
  type CalendarWeekSegment,
} from '../calendar-utils';
import { windowDays } from '../calendar-time-grid';

// buildTimedFullDayWeekSegments only tests each event on the days it spans
// (#759: the scrolling grids pass months of days). It must give what testing
// every day gives, DST days included.

const ev = (id: string, start: string, duration: string, extra: Partial<CalendarEvent> = {}) =>
  ({ id, title: id, start, duration, ...extra }) as CalendarEvent;

// The per-day algorithm it replaced.
function reference(events: CalendarEvent[], days: Date[]): CalendarWeekSegment[] {
  const out: CalendarWeekSegment[] = [];
  for (const event of events) {
    let runStart = -1;
    for (let i = 0; i <= days.length; i++) {
      const full = i < days.length && isTimedEventFullDayOnDate(event, days[i]);
      if (full && runStart < 0) runStart = i;
      if (!full && runStart >= 0) {
        out.push({
          event,
          startIndex: runStart,
          span: i - runStart,
          row: -1,
          continuesBefore: isTimedEventFullDayOnDate(event, addDays(days[runStart], -1)),
          continuesAfter: isTimedEventFullDayOnDate(event, addDays(days[i - 1], 1)),
        });
        runStart = -1;
      }
    }
  }
  return out;
}

const key = (s: CalendarWeekSegment) =>
  `${s.event.id}:${s.startIndex}+${s.span}:${s.continuesBefore}:${s.continuesAfter}`;

describe('buildTimedFullDayWeekSegments', () => {
  const week = windowDays({ start: new Date(2026, 8, 7), end: new Date(2026, 8, 13) });

  it('finds the whole days a timed event covers', () => {
    // Tue 10:00 .. Fri 15:00 covers Wed and Thu in full.
    const segments = buildTimedFullDayWeekSegments([ev('trip', '2026-09-08T10:00:00', 'P3DT5H')], week);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ startIndex: 2, span: 2, continuesBefore: false, continuesAfter: false });
  });

  it('marks events that run past the given days', () => {
    const segments = buildTimedFullDayWeekSegments([ev('long', '2026-09-01T00:00:00', 'P20D')], week);
    expect(segments[0]).toMatchObject({ startIndex: 0, span: 7, continuesBefore: true, continuesAfter: true });
  });

  it('skips events that fill no whole day, all-day events and events outside the days', () => {
    const segments = buildTimedFullDayWeekSegments(
      [
        ev('meeting', '2026-09-08T10:00:00', 'PT1H'),
        ev('allday', '2026-09-08T00:00:00', 'P1D', { showWithoutTime: true }),
        ev('later', '2026-10-08T00:00:00', 'P2D'),
        ev('broken', 'not a date', 'P1D'),
      ],
      week,
    );
    expect(segments).toEqual([]);
  });

  // Europe and the US change clocks on these weekends.
  const spans = [
    { start: new Date(2026, 2, 5), end: new Date(2026, 2, 31) },
    { start: new Date(2026, 9, 20), end: new Date(2026, 10, 5) },
    { start: new Date(2026, 8, 7), end: new Date(2026, 8, 13) },
  ];
  const events = [
    ev('conf-eu-spring', '2026-03-27T09:00:00', 'P4D'),
    ev('trip-us-spring', '2026-03-07T00:00:00', 'P3D'),
    ev('trip-eu-fall', '2026-10-24T00:00:00', 'P2D'),
    ev('camp-us-fall', '2026-10-30T12:00:00', 'P4DT2H'),
    ev('nearly', '2026-10-25T00:00:00', 'PT23H59M59S'),
    ev('trip', '2026-09-08T10:00:00', 'P3DT5H'),
    ev('day', '2026-09-07T00:00:00', 'P1D'),
    ev('tail', '2026-09-12T00:00:00', 'P4D'),
    ev('long', '2026-01-01T00:00:00', 'P400D'),
  ];

  for (const span of spans) {
    const days = windowDays(span);

    it(`matches testing every day (${dayKey(span.start)})`, () => {
      expect(buildTimedFullDayWeekSegments(events, days).map(key).sort()).toEqual(
        reference(events, days).map(key).sort(),
      );
    });

    it(`covers exactly the days the grid leaves out (${dayKey(span.start)})`, () => {
      const segments = buildTimedFullDayWeekSegments(events, days);
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
