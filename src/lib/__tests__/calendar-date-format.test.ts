import { describe, expect, it } from 'vitest';
import { formatCalendarDate } from '../date-format';

const oct15 = new Date(2026, 9, 15, 10, 0);

describe('formatCalendarDate', () => {
  it('puts the day before the month in German', () => {
    const s = formatCalendarDate(oct15, 'de', 'weekdayMonthDay');
    expect(s).toMatch(/15\. Okt/);
    expect(s).not.toMatch(/Okt\.? 15/);
  });

  it('keeps the US order in English', () => {
    expect(formatCalendarDate(oct15, 'en-US', 'weekdayMonthDay')).toBe('Thu, Oct 15');
    expect(formatCalendarDate(oct15, 'en', 'monthDayYear')).toBe('Oct 15, 2026');
  });

  it('names the weekday in full with the year for an all-day date', () => {
    expect(formatCalendarDate(oct15, 'de', 'longWeekdayMonthDayYear')).toMatch(/^Donnerstag, 15\. Okt\.? 2026$/);
  });
});
