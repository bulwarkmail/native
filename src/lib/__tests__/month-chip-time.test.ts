import { describe, expect, it } from 'vitest';
import { monthChipShowsTime } from '../calendar-month-scroll';

describe('monthChipShowsTime', () => {
  it('drops the time in a phone-portrait cell so the title shows', () => {
    expect(monthChipShowsTime(true, 412 / 7)).toBe(false);
  });

  it('keeps the time where the cell has room', () => {
    expect(monthChipShowsTime(true, 915 / 7)).toBe(true);
  });

  it('never shows the time when the setting is off', () => {
    expect(monthChipShowsTime(false, 200)).toBe(false);
  });
});
