import { describe, expect, it } from 'vitest';
import { customColorGrid, normalizeHexColor } from '../calendar-custom-color';

describe('normalizeHexColor', () => {
  it('takes a typed hex colour in its usual spellings', () => {
    expect(normalizeHexColor('#1A2B3C')).toBe('#1a2b3c');
    expect(normalizeHexColor('1a2b3c')).toBe('#1a2b3c');
    expect(normalizeHexColor(' #abc ')).toBe('#aabbcc');
  });

  it('refuses what is no hex colour', () => {
    for (const bad of ['', '#12345', 'red', '#ggg000', '#1234567']) expect(normalizeHexColor(bad)).toBeNull();
  });
});

describe('customColorGrid', () => {
  it('offers distinct hex colours in rows of twelve', () => {
    const grid = customColorGrid();
    expect(grid).toHaveLength(4);
    const all = grid.flat();
    expect(all.every((c) => /^#[0-9a-f]{6}$/.test(c))).toBe(true);
    expect(new Set(all).size).toBe(all.length);
    expect(grid[1][0]).toBe('#c32222');
  });
});
