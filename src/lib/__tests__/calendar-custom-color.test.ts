import { describe, expect, it } from 'vitest';
import { customColorGrid, HEX_FIELD_MAX_LENGTH, hexFieldText, normalizeHexColor } from '../calendar-custom-color';

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

describe('the hex field', () => {
  it('shows a colour typed without "#" with it once the user leaves the field', () => {
    expect(hexFieldText('3b82f6')).toBe('#3b82f6');
    expect(hexFieldText('3B82F6')).toBe('#3b82f6');
    expect(hexFieldText('#3b82f6')).toBe('#3b82f6');
    expect(hexFieldText('3b8')).toBe('#33bb88');
    // Not a colour: left as typed for the hint under the field.
    expect(hexFieldText('3b82f')).toBe('3b82f');
  });

  it('takes a pasted colour with spaces around it', () => {
    const pasted = ' #3b82f6 ';
    expect(pasted.length).toBeLessThanOrEqual(HEX_FIELD_MAX_LENGTH);
    expect(normalizeHexColor(pasted.slice(0, HEX_FIELD_MAX_LENGTH))).toBe('#3b82f6');
  });
});

describe('the calendar sheet’s hex field', () => {
  it('spells the colour out on blur and takes the longer pasted text', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const sheet = fs.readFileSync(path.resolve(__dirname, '../../components/calendar/CalendarEditSheet.tsx'), 'utf8');
    const field = sheet.slice(sheet.indexOf('value={hexInput}'), sheet.indexOf('/>', sheet.indexOf('value={hexInput}')));
    expect(field).toMatch(/onBlur=\{\(\) => setHexInput\(\(v\) => hexFieldText\(v\)\)\}/);
    expect(field).toMatch(/maxLength=\{HEX_FIELD_MAX_LENGTH\}/);
  });
});
