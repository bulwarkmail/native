import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALL_DAY_MAX_ROWS,
  allDayRowCounts,
  allDayStripLayout,
} from '../calendar-all-day';

describe('allDayStripLayout', () => {
  it('caps the strip at three rows', () => {
    expect(DEFAULT_ALL_DAY_MAX_ROWS).toBe(3);
    expect(allDayStripLayout([1, 5, 2], false)).toEqual({ visibleRows: 3, hiddenCount: 2, expandable: true });
  });

  it('shows every row once expanded', () => {
    expect(allDayStripLayout([1, 5, 2], true)).toEqual({ visibleRows: 5, hiddenCount: 0, expandable: true });
  });

  it('offers no toggle for three rows or fewer', () => {
    expect(allDayStripLayout([3, 1], false)).toEqual({ visibleRows: 3, hiddenCount: 0, expandable: false });
    expect(allDayStripLayout([2], true)).toEqual({ visibleRows: 2, hiddenCount: 0, expandable: false });
  });

  it('is empty without days or rows', () => {
    expect(allDayStripLayout([], false)).toEqual({ visibleRows: 0, hiddenCount: 0, expandable: false });
    expect(allDayStripLayout([0, 0], false).visibleRows).toBe(0);
  });
});

describe('allDayRowCounts', () => {
  const seg = (startIndex: number, span: number, row: number) => ({ startIndex, span, row });

  it('counts the rows each shown day needs', () => {
    const counts = allDayRowCounts([seg(0, 2, 0), seg(1, 1, 3), seg(3, 1, 1)], 4);
    expect(counts).toEqual([1, 4, 0, 2]);
  });

  it('ignores columns outside the shown days', () => {
    expect(allDayRowCounts([seg(5, 1, 4)], 3)).toEqual([0, 0, 0]);
  });
});
