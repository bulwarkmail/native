import { describe, it, expect } from 'vitest';
import {
  parseDuration,
  parseLocalDateTime,
  eventTimeRange,
  eventsOnDay,
  normalizeAllDayDuration,
  buildAllDayDuration,
  getCalendarColor,
  layoutOverlappingEvents,
  CALENDAR_COLOR_PALETTE,
} from '../calendar-utils';
import type { CalendarEvent } from '../../api/types';

function ev(partial: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: 'e',
    uid: 'u',
    title: 't',
    start: '2026-04-20T09:00:00',
    calendarIds: { 'cal-1': true },
    ...partial,
  } as CalendarEvent;
}

describe('parseDuration', () => {
  it('parses hours and minutes', () => {
    expect(parseDuration('PT1H30M')).toBe((60 + 30) * 60 * 1000);
  });
  it('parses days', () => {
    expect(parseDuration('P2D')).toBe(2 * 24 * 60 * 60 * 1000);
  });
  it('parses minutes only', () => {
    expect(parseDuration('PT45M')).toBe(45 * 60 * 1000);
  });
  it('returns 0 for undefined', () => {
    expect(parseDuration(undefined)).toBe(0);
  });
  it('returns 0 for malformed', () => {
    expect(parseDuration('not-a-duration')).toBe(0);
  });
});

describe('parseLocalDateTime', () => {
  it('parses floating local time without applying timezone shift', () => {
    const d = parseLocalDateTime('2026-04-20T09:00:00');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(3);
    expect(d.getDate()).toBe(20);
    expect(d.getHours()).toBe(9);
  });
});

describe('eventTimeRange', () => {
  it('returns start, end, allDay for a timed event with utcStart/utcEnd', () => {
    const range = eventTimeRange(ev({
      utcStart: '2026-04-20T09:00:00Z',
      utcEnd: '2026-04-20T10:00:00Z',
      duration: 'PT1H',
    }));
    expect(range.allDay).toBe(false);
    expect(range.end.getTime() - range.start.getTime()).toBe(60 * 60 * 1000);
  });

  it('falls back to start + duration when utcEnd missing', () => {
    const range = eventTimeRange(ev({ duration: 'PT2H' }));
    expect(range.end.getTime() - range.start.getTime()).toBe(2 * 60 * 60 * 1000);
  });

  it('marks allDay when showWithoutTime', () => {
    const range = eventTimeRange(ev({ showWithoutTime: true, duration: 'P1D' }));
    expect(range.allDay).toBe(true);
  });
});

describe('eventsOnDay', () => {
  it('returns events that start on the given day', () => {
    const day = new Date(2026, 3, 20);
    const events = [
      ev({ id: 'a', start: '2026-04-20T09:00:00', duration: 'PT1H' }),
      ev({ id: 'b', start: '2026-04-21T09:00:00', duration: 'PT1H' }),
    ];
    const result = eventsOnDay(events, day);
    expect(result.map((e) => e.id)).toEqual(['a']);
  });

  it('returns multi-day events overlapping the given day', () => {
    const day = new Date(2026, 3, 21);
    const events = [
      ev({
        id: 'multi',
        start: '2026-04-20T00:00:00',
        showWithoutTime: true,
        duration: 'P3D',
      }),
    ];
    const result = eventsOnDay(events, day);
    expect(result.map((e) => e.id)).toEqual(['multi']);
  });

  it('does not return events that start exactly at midnight of the next day', () => {
    const day = new Date(2026, 3, 20);
    const events = [
      ev({
        id: 'edge',
        start: '2026-04-21T00:00:00',
        duration: 'PT1H',
      }),
    ];
    expect(eventsOnDay(events, day)).toHaveLength(0);
  });
});

describe('normalizeAllDayDuration', () => {
  it('rounds up to whole days', () => {
    expect(normalizeAllDayDuration('PT25H')).toBe('P2D');
  });
  it('returns at least P1D', () => {
    expect(normalizeAllDayDuration('PT1H')).toBe('P1D');
  });
  it('returns undefined when input undefined', () => {
    expect(normalizeAllDayDuration(undefined)).toBe(undefined);
  });
});

describe('buildAllDayDuration', () => {
  it('builds a one-day duration when same day', () => {
    const start = new Date(2026, 3, 20);
    expect(buildAllDayDuration(start, start)).toBe('P1D');
  });
  it('builds a multi-day duration inclusive of end', () => {
    const start = new Date(2026, 3, 20);
    const end = new Date(2026, 3, 22);
    expect(buildAllDayDuration(start, end)).toBe('P3D');
  });
});

describe('getCalendarColor', () => {
  it('uses provided color when present', () => {
    expect(getCalendarColor({ id: 'x', color: '#ff0000' })).toBe('#ff0000');
  });

  it('falls back to a deterministic palette color', () => {
    const a = getCalendarColor({ id: 'cal-1' });
    const b = getCalendarColor({ id: 'cal-1' });
    expect(a).toBe(b);
    expect(CALENDAR_COLOR_PALETTE).toContain(a);
  });

  it('returns the first palette color when undefined', () => {
    expect(getCalendarColor(undefined)).toBe(CALENDAR_COLOR_PALETTE[0]);
  });
});

describe('layoutOverlappingEvents', () => {
  it('packs non-overlapping events into the same column', () => {
    const day = new Date(2026, 3, 20);
    const events = [
      ev({
        id: 'a', start: '2026-04-20T09:00:00',
        utcStart: '2026-04-20T09:00:00Z', utcEnd: '2026-04-20T10:00:00Z',
        duration: 'PT1H',
      }),
      ev({
        id: 'b', start: '2026-04-20T10:00:00',
        utcStart: '2026-04-20T10:00:00Z', utcEnd: '2026-04-20T11:00:00Z',
        duration: 'PT1H',
      }),
    ];
    const layout = layoutOverlappingEvents(events, day);
    expect(layout).toHaveLength(2);
    expect(layout[0].column).toBe(0);
    expect(layout[1].column).toBe(0);
    expect(layout[0].totalColumns).toBe(1);
  });

  it('places overlapping events into separate columns', () => {
    const day = new Date(2026, 3, 20);
    const events = [
      ev({
        id: 'a', start: '2026-04-20T09:00:00',
        utcStart: '2026-04-20T09:00:00Z', utcEnd: '2026-04-20T11:00:00Z',
        duration: 'PT2H',
      }),
      ev({
        id: 'b', start: '2026-04-20T10:00:00',
        utcStart: '2026-04-20T10:00:00Z', utcEnd: '2026-04-20T12:00:00Z',
        duration: 'PT2H',
      }),
    ];
    const layout = layoutOverlappingEvents(events, day);
    expect(layout).toHaveLength(2);
    const cols = layout.map((l) => l.column).sort();
    expect(cols).toEqual([0, 1]);
    expect(layout[0].totalColumns).toBe(2);
  });

  it('skips all-day events', () => {
    const day = new Date(2026, 3, 20);
    const events = [
      ev({ id: 'all', showWithoutTime: true, duration: 'P1D' }),
    ];
    expect(layoutOverlappingEvents(events, day)).toHaveLength(0);
  });
});
