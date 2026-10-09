import { describe, it, expect, afterEach } from 'vitest';
import { applyFontScale, CHROME_MAX_FONT_SCALE, FONT_SCALE, fontPx } from '../../theme/tokens';
import { dayKey } from '../calendar-utils';
import {
  computeScrollWindow,
  freshScrollWindowState,
  growScrollWindow,
} from '../calendar-scroll-window';
import {
  dayIndexIn,
  monthFocusRow,
  monthKeyOf,
  monthChipRowHeight,
  monthMask,
  sampledRow,
  weekDays,
  windowWeekStarts,
} from '../calendar-month-scroll';

const opts = { weekStartsOn: 1 as const };

describe('windowWeekStarts', () => {
  it('has one row per week of the window, each starting on the first weekday', () => {
    const win = computeScrollWindow(freshScrollWindowState('month', new Date(2026, 8, 9)), opts);
    const weeks = windowWeekStarts(win);
    // 2026-07-27 .. 2026-11-08 is 15 weeks.
    expect(weeks).toHaveLength(15);
    expect(dayKey(weeks[0])).toBe('2026-07-27');
    expect(dayKey(weeks[14])).toBe('2026-11-02');
    expect(weeks.every((w) => w.getDay() === 1)).toBe(true);
  });

  it('keeps whole days across the DST change', () => {
    const win = { start: new Date(2026, 9, 19), end: new Date(2026, 10, 1) };
    const weeks = windowWeekStarts(win);
    expect(weeks.map(dayKey)).toEqual(['2026-10-19', '2026-10-26']);
    expect(weeks[1].getHours()).toBe(0);
  });

  it('adds rows above when the window grows into the past', () => {
    const state = freshScrollWindowState('month', new Date(2026, 8, 9));
    const before = windowWeekStarts(computeScrollWindow(state, opts));
    const after = windowWeekStarts(computeScrollWindow(growScrollWindow(state, 'before'), opts));
    const added = after.length - before.length;
    expect(added).toBeGreaterThanOrEqual(4);
    // The rows that were there keep their dates, shifted down by `added`.
    expect(after.slice(added).map(dayKey)).toEqual(before.map(dayKey));
  });
});

describe('weekDays', () => {
  it('lists the seven days of a week', () => {
    expect(weekDays(new Date(2026, 8, 28)).map(dayKey)).toEqual([
      '2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
    ]);
  });
});

describe('monthFocusRow', () => {
  const win = computeScrollWindow(
    growScrollWindow(freshScrollWindowState('month', new Date(2026, 8, 9)), 'before'),
    opts,
  );
  const count = windowWeekStarts(win).length;

  it('is the row of the week that starts the month grid', () => {
    const row = monthFocusRow(win, new Date(2026, 9, 20), count, opts);
    // October 2026's grid starts on Monday 2026-09-28.
    expect(dayKey(windowWeekStarts(win)[row])).toBe('2026-09-28');
  });

  it('stays inside the list', () => {
    expect(monthFocusRow(win, new Date(2020, 0, 1), count, opts)).toBe(0);
    expect(monthFocusRow(win, new Date(2030, 0, 1), count, opts)).toBe(count - 1);
  });
});

describe('sampledRow', () => {
  it('picks the row under 40% of the viewport', () => {
    // 6 rows of 54px: the sample line is 129.6px below the top.
    expect(sampledRow(0, 324, 54, 20)).toBe(2);
    expect(sampledRow(54 * 5, 324, 54, 20)).toBe(7);
  });

  it('clamps to the rows there are', () => {
    expect(sampledRow(-50, 324, 54, 20)).toBe(1);
    expect(sampledRow(100000, 324, 54, 20)).toBe(19);
    expect(sampledRow(0, 324, 54, 0)).toBe(0);
  });
});

describe('monthMask / monthKeyOf', () => {
  it('marks the days of the month in focus', () => {
    const days = weekDays(new Date(2026, 8, 28)); // Sep 28 .. Oct 4
    expect(monthMask(days, monthKeyOf(new Date(2026, 8, 1)))).toBe(0b0000111);
    expect(monthMask(days, monthKeyOf(new Date(2026, 9, 1)))).toBe(0b1111000);
    expect(monthMask(days, monthKeyOf(new Date(2026, 10, 1)))).toBe(0);
  });

  it('tells months of different years apart', () => {
    expect(monthKeyOf(new Date(2026, 0, 1))).not.toBe(monthKeyOf(new Date(2027, 0, 1)));
    expect(monthKeyOf(new Date(2026, 11, 31)) + 1).toBe(monthKeyOf(new Date(2027, 0, 1)));
  });
});

describe('dayIndexIn', () => {
  const days = weekDays(new Date(2026, 8, 28));

  it('finds a day in the row regardless of the time', () => {
    expect(dayIndexIn(days, new Date(2026, 9, 1, 23, 30))).toBe(3);
    expect(dayIndexIn(days, new Date(2026, 8, 28))).toBe(0);
  });

  it('is -1 outside the row', () => {
    expect(dayIndexIn(days, new Date(2026, 9, 5))).toBe(-1);
    expect(dayIndexIn(days, new Date(2026, 8, 27))).toBe(-1);
    expect(dayIndexIn([], new Date())).toBe(-1);
  });
});

describe('monthChipRowHeight', () => {
  afterEach(() => applyFontScale(1));

  // What a chip row holds: 4px padding above and below, the 36px day circle,
  // 2px, then two chips (an 11px line and 1px padding each, 1px apart) or one
  // chip, 1px and a 10px "+N" line. Lines grow with the font size setting and
  // the OS scale, which Android applies to lineHeight up to the chrome cap.
  function content(osScale: number): number {
    const line = (px: number) => fontPx(px) * Math.min(osScale, CHROME_MAX_FONT_SCALE);
    const chip = line(11) + 2;
    return 4 + 36 + 2 + Math.max(2 * chip + 1, chip + 1 + line(10)) + 4;
  }

  it('keeps the 74px row at Medium with no OS scale', () => {
    expect(monthChipRowHeight(1)).toBe(74);
  });

  it('grows with the font size setting and fits two chips, or a chip and +N, at Large', () => {
    const medium = monthChipRowHeight(1);
    applyFontScale(FONT_SCALE.large);
    expect(monthChipRowHeight(1)).toBeGreaterThan(medium);
    expect(monthChipRowHeight(1)).toBeGreaterThanOrEqual(content(1));
  });

  it('fits the OS font scale up to the chrome cap, and no further', () => {
    applyFontScale(FONT_SCALE.large);
    expect(monthChipRowHeight(1.3)).toBeGreaterThanOrEqual(content(1.3));
    expect(monthChipRowHeight(2)).toBe(monthChipRowHeight(CHROME_MAX_FONT_SCALE));
    expect(monthChipRowHeight(0.85)).toBe(monthChipRowHeight(1));
  });

  it('is a whole number of pixels, so rows and getItemLayout offsets agree', () => {
    for (const factor of Object.values(FONT_SCALE)) {
      applyFontScale(factor);
      for (const os of [1, 1.15, 1.3, 2]) expect(Number.isInteger(monthChipRowHeight(os))).toBe(true);
    }
  });
});
