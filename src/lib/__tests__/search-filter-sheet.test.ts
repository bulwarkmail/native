import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { filterButtonLabel, filterSheetFrame, keepCustomSize, sizeChipLabel } from '../search-utils';

// The search filter sheet (walkthrough on a Pixel 7): it did not scroll and
// its last row was cut off, the size fields sat under the keyboard, the size
// chip read "Larger than (KB): 1 KB", and after Clear the filter button was
// still announced with a count while "Custom size" stayed picked.

const t = (_key: string, fallback: string, values?: Record<string, string | number>) =>
  fallback.replace(/\{(\w+)\}/g, (_m, k: string) => String(values?.[k] ?? ''));
const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

describe('search filter sheet', () => {
  it('names a size chip without the field placeholder', () => {
    expect(sizeChipLabel('min', '1', t)).toBe('Larger than 1 KB');
    expect(sizeChipLabel('max', '250', t)).toBe('Smaller than 250 KB');
  });

  it('puts the filter count in the button label, and drops it at zero', () => {
    expect(filterButtonLabel(0, t)).toBe('Advanced search filters');
    expect(filterButtonLabel(2, t)).toBe('Advanced search filters, 2 active');
  });

  it('lets "Custom size" go once the sheet is closed with no size left', () => {
    expect(keepCustomSize(true, false, undefined, undefined)).toBe(false);
    expect(keepCustomSize(true, false, '', '')).toBe(false);
    // Picked in the open sheet, nothing typed yet: it stays.
    expect(keepCustomSize(true, true, undefined, undefined)).toBe(true);
    expect(keepCustomSize(true, false, '10', undefined)).toBe(true);
  });

  it('keeps the sheet between the system bars and above the keyboard', () => {
    // Pixel 7: 915 high, 24 status bar, 48 navigation bar.
    expect(filterSheetFrame(915, 24, 48, 0, 16)).toEqual({ paddingTop: 40, paddingBottom: 64, maxHeight: 811 });
    // Keyboard up, window not resized (edge to edge): the sheet ends above it.
    expect(filterSheetFrame(915, 24, 48, 300, 16)).toEqual({ paddingTop: 40, paddingBottom: 316, maxHeight: 559 });
    // A window that already shrank for the keyboard does not lose it twice.
    expect(filterSheetFrame(615, 24, 48, 300, 16, 300)).toEqual({ paddingTop: 40, paddingBottom: 64, maxHeight: 511 });
  });

  it('wires the helpers into the list screen', () => {
    const list = read('screens/EmailListScreen.tsx');
    expect(list).toMatch(/accessibilityLabel=\{filterButtonLabel\(activeFilterCount, t\)\}/);
    expect(list).not.toMatch(/accessibilityValue=\{activeFilterCount/);
    expect(list).toMatch(/label=\{sizeChipLabel\('min', filters\.minSizeKb \?\? '', t\)\}/);
    expect(list).toMatch(/<View style=\{\[styles\.filterMenu, \{ maxHeight: filterFrame\.maxHeight \}\]\}>/);
    expect(list).not.toMatch(/maxHeight: '85%'/);
    expect(list).toMatch(/onPress=\{clearFilters\}/);
    expect(list).toMatch(/key=\{filterFormKey\}/);
    expect((list.match(/onFocus=\{revealSizeFields\}/g) ?? []).length).toBe(2);
  });
});
