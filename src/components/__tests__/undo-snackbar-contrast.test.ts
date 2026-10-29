import { describe, expect, it } from 'vitest';
import { DARK_COLORS, LIGHT_COLORS, type ThemePalette } from '../../theme/tokens';
import { BUILTIN_THEMES } from '../../theme/builtin-themes';
import { undoSnackbarColors } from '../undo-snackbar-colors';

// The undo bar (UndoSnackbar) is drawn in the text colour. Its UNDO button
// used the primary colour, which is white in the default dark theme: white
// on white, so in dark mode the bar showed "Email archived" and no visible
// way to undo. The bound is 3:1, not 4.5:1, because Solarized's own text
// and background are a little under 4.5:1.

function luminance(hex: string): number {
  const v = hex.replace('#', '');
  const full = v.length === 3 ? v.split('').map((ch) => ch + ch).join('') : v.slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const palettes: Array<[string, ThemePalette]> = [
  ['default light', LIGHT_COLORS],
  ['default dark', DARK_COLORS],
  ...BUILTIN_THEMES.flatMap((theme): Array<[string, ThemePalette]> => [
    [`${theme.name} light`, { ...LIGHT_COLORS, ...theme.light } as ThemePalette],
    [`${theme.name} dark`, { ...DARK_COLORS, ...theme.dark } as ThemePalette],
  ]),
];

describe('undo bar', () => {
  it.each(palettes)('UNDO is readable on the bar (%s)', (_name, palette) => {
    const { bar, action } = undoSnackbarColors(palette);
    expect(contrast(action, bar)).toBeGreaterThanOrEqual(3);
  });
});
