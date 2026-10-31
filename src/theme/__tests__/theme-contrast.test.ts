import { describe, expect, it } from 'vitest';
import { DARK_COLORS, LIGHT_COLORS, type ThemePalette } from '../tokens';
import { BUILTIN_THEMES } from '../builtin-themes';

// Text contrast of every built-in theme, light and dark (WCAG 1.4.3, webmail
// 9f6c7b99c and lib/__tests__/theme-contrast.test.ts). Grey text used to sit
// at 2.6:1 on white (textMuted #94a3b8) and 3.2:1 on dark surfaces (#737373
// on #262626); it carries dates, previews, hints and placeholders all over
// the app.

type Rgb = [number, number, number];

function parse(color: string): { rgb: Rgb; a: number } {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
  if (hex) {
    const v = hex[1].length === 3 ? hex[1].split('').map((ch) => ch + ch).join('') : hex[1];
    return { rgb: [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)) as Rgb, a: 1 };
  }
  const rgba = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(color);
  if (!rgba) throw new Error(`unparsed colour ${color}`);
  return { rgb: [Number(rgba[1]), Number(rgba[2]), Number(rgba[3])], a: rgba[4] === undefined ? 1 : Number(rgba[4]) };
}

/** Opaque rgb of `color`, laid over `under` when it has alpha. */
function solid(color: string, under: Rgb): Rgb {
  const c = parse(color);
  return c.rgb.map((v, i) => v * c.a + under[i] * (1 - c.a)) as Rgb;
}

function luminance([r, g, b]: Rgb): number {
  const [lr, lg, lb] = [r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

function ratio(fg: string, ground: string, page: string): number {
  const bg = solid(ground, solid(page, [255, 255, 255]));
  const l1 = luminance(solid(fg, bg));
  const l2 = luminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

const palettes: Array<[string, ThemePalette]> = [
  ['default light', LIGHT_COLORS],
  ['default dark', DARK_COLORS],
  ...BUILTIN_THEMES.flatMap((theme): Array<[string, ThemePalette]> => [
    [`${theme.name} light`, { ...LIGHT_COLORS, ...theme.light } as ThemePalette],
    [`${theme.name} dark`, { ...DARK_COLORS, ...theme.dark } as ThemePalette],
  ]),
];

const TEXT = ['text', 'textSecondary', 'textMuted', 'mutedForeground'] as const;
// The grounds text is drawn on: the page, cards, sheets and popovers, and
// the grey fills of rows, chips and inputs.
const GROUNDS = ['background', 'surface', 'card', 'popover', 'secondary', 'muted'] as const;

describe.each(palettes)('%s', (_name, palette) => {
  it.each(TEXT)('%s reaches 4.5:1 on every ground', (fg) => {
    for (const ground of GROUNDS) {
      expect(ratio(palette[fg], palette[ground], palette.background), `${fg} ${palette[fg]} on ${ground} ${palette[ground]}`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });
});
