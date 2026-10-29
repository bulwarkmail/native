import { describe, it, expect } from 'vitest';
import { filesGridLayout } from '../files-grid';

describe('filesGridLayout', () => {
  it('keeps three columns on a phone', () => {
    expect(filesGridLayout(411).columns).toBe(3);
  });

  it('adds columns on a wide window instead of growing the cells', () => {
    const { columns, cellWidth } = filesGridLayout(1200);
    expect(columns).toBeGreaterThan(3);
    expect(cellWidth).toBeLessThan(160);
    expect(cellWidth).toBeGreaterThanOrEqual(112);
  });

  it('fits the cells and gaps into the width', () => {
    for (const width of [360, 411, 800, 1200, 2000]) {
      const { columns, cellWidth } = filesGridLayout(width);
      expect(cellWidth * columns + 8 * (columns - 1) + 16).toBeLessThanOrEqual(width);
    }
  });
});
