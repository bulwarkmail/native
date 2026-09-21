import { describe, it, expect } from 'vitest';
import { format, startOfWeek } from 'date-fns';
import { applyCalendarNavigation, shiftViewDate } from '../calendar-navigation';

function ymd(d: Date): string {
  return format(d, 'yyyy-MM-dd');
}

describe('shiftViewDate', () => {
  it('moves a week at a time in week view', () => {
    const wed = new Date(2026, 8, 16); // Wed 16 Sep 2026
    expect(ymd(shiftViewDate('week', wed, 1))).toBe('2026-09-23');
    expect(ymd(shiftViewDate('week', wed, -1))).toBe('2026-09-09');
  });

  it('moves a month at a time in month view', () => {
    const d = new Date(2026, 8, 16);
    expect(ymd(shiftViewDate('month', d, 1))).toBe('2026-10-16');
    expect(ymd(shiftViewDate('month', d, -1))).toBe('2026-08-16');
  });
});

describe('applyCalendarNavigation', () => {
  it('week prev/next moves the selected day with the visible week', () => {
    const current = new Date(2026, 8, 16);
    const selected = new Date(2026, 8, 16);
    const next = applyCalendarNavigation('week', current, selected, 1);

    expect(ymd(next.currentDate)).toBe('2026-09-23');
    expect(ymd(next.selectedDate)).toBe('2026-09-23');
    expect(ymd(startOfWeek(next.selectedDate, { weekStartsOn: 1 }))).toBe('2026-09-21');
    expect(ymd(startOfWeek(next.currentDate, { weekStartsOn: 1 }))).toBe(
      ymd(startOfWeek(next.selectedDate, { weekStartsOn: 1 })),
    );
  });

  it('week nav still moves the grid when selectedDate has drifted from currentDate', () => {
    // Header was already advanced (currentDate) while the grid stayed on
    // selectedDate — the original week-view paging bug.
    const current = new Date(2026, 8, 23);
    const selected = new Date(2026, 8, 16);
    const next = applyCalendarNavigation('week', current, selected, 1);

    expect(ymd(next.currentDate)).toBe('2026-09-30');
    expect(ymd(next.selectedDate)).toBe('2026-09-30');
  });

  it('month prev/next keeps the highlighted day', () => {
    const current = new Date(2026, 8, 1);
    const selected = new Date(2026, 8, 16);
    const next = applyCalendarNavigation('month', current, selected, 1);

    expect(ymd(next.currentDate)).toBe('2026-10-01');
    expect(ymd(next.selectedDate)).toBe('2026-09-16');
  });
});
