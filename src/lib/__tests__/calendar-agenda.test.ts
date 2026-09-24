import { describe, it, expect } from 'vitest';
import type { CalendarEvent } from '../../api/types';
import { buildEventDayIndex, dayKey } from '../calendar-utils';
import { buildAgendaDays, findAgendaFocusIndex } from '../calendar-agenda';

const ev = (id: string, start: string, duration = 'PT1H', extra: Partial<CalendarEvent> = {}) =>
  ({ id, title: id, start, duration, ...extra }) as CalendarEvent;

const keys = (days: Array<{ date: Date }>) => days.map((d) => dayKey(d.date));

describe('buildAgendaDays', () => {
  const index = buildEventDayIndex([
    ev('aug', '2026-08-20T10:00:00'),
    ev('sep1', '2026-09-10T09:00:00'),
    ev('sep2', '2026-09-10T08:00:00'),
    ev('oct', '2026-10-05T10:00:00'),
    ev('trip', '2026-09-29T00:00:00', 'P3D', { showWithoutTime: true }),
    ev('dec', '2026-12-01T10:00:00'),
  ]);
  const loaded = { start: new Date(2026, 8, 1), end: new Date(2026, 9, 31) };

  it('lists the loaded days that have events, in order', () => {
    const days = buildAgendaDays(index, loaded, new Date(2026, 8, 10, 12));
    expect(keys(days)).toEqual(['2026-09-10', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-05']);
    // Buckets keep the day index's order (by start time).
    expect(days[0].data.map((e) => e.id)).toEqual(['sep2', 'sep1']);
  });

  it('adds an empty "Today" row when today is loaded but has no events', () => {
    const days = buildAgendaDays(index, loaded, new Date(2026, 8, 24, 8));
    expect(keys(days)).toContain('2026-09-24');
    const today = days.find((d) => dayKey(d.date) === '2026-09-24');
    expect(today?.data).toEqual([]);
    expect(keys(days)).toEqual([...keys(days)].sort());
  });

  it('leaves out today when it was never fetched', () => {
    const days = buildAgendaDays(index, loaded, new Date(2027, 0, 5));
    expect(keys(days)).not.toContain('2027-01-05');
  });

  it('shows nothing while none of the window is loaded', () => {
    expect(buildAgendaDays(index, null, new Date(2026, 8, 24))).toEqual([]);
  });

  it('grows with the loaded range as the window extends', () => {
    const wider = { start: new Date(2026, 7, 1), end: new Date(2026, 11, 31) };
    const days = buildAgendaDays(index, wider, new Date(2026, 8, 10));
    expect(keys(days)[0]).toBe('2026-08-20');
    expect(keys(days).at(-1)).toBe('2026-12-01');
  });
});

describe('findAgendaFocusIndex', () => {
  const days = [new Date(2026, 8, 10), new Date(2026, 8, 24), new Date(2026, 9, 5)].map((date) => ({ date }));

  it('finds the first day at or after the focus', () => {
    expect(findAgendaFocusIndex(days, new Date(2026, 8, 24, 18))).toBe(1);
    expect(findAgendaFocusIndex(days, new Date(2026, 8, 25))).toBe(2);
    expect(findAgendaFocusIndex(days, new Date(2026, 0, 1))).toBe(0);
  });

  it('is -1 past the last day', () => {
    expect(findAgendaFocusIndex(days, new Date(2026, 9, 6))).toBe(-1);
  });
});
