/**
 * The colour-blind-safe palette behind Settings > Accessibility >
 * "Colour-blind-safe colours" (colorBlindPalette). A port of the webmail's
 * lib/cvd-palette.ts (cf4d02b49).
 *
 * Tags and calendars keep the colours the user picked; this only changes how
 * they are drawn. Every colour is moved to the nearest of the Okabe-Ito
 * colours by hue: eight colours chosen to stay apart for protanopia,
 * deuteranopia and tritanopia (Okabe & Ito, "Color Universal Design", 2008).
 * Two picked colours of a similar hue (blue and indigo) can land on the same
 * one; the names next to them still tell them apart.
 */

export const CVD_COLORS = {
  vermillion: '#D55E00',
  orange: '#E69F00',
  yellow: '#F0E442',
  bluishGreen: '#009E73',
  skyBlue: '#56B4E9',
  blue: '#0072B2',
  reddishPurple: '#CC79A7',
  grey: '#999999',
} as const;

export type CvdHue = keyof typeof CVD_COLORS;

/** The hues of the tag palette (theme/tokens TAGS), as Tailwind's 500 shades. */
const PALETTE_HUES: Record<string, string> = {
  red: '#ef4444',
  orange: '#f97316',
  amber: '#f59e0b',
  yellow: '#eab308',
  lime: '#84cc16',
  green: '#22c55e',
  teal: '#14b8a6',
  cyan: '#06b6d4',
  blue: '#3b82f6',
  indigo: '#6366f1',
  purple: '#a855f7',
  pink: '#ec4899',
  gray: '#6b7280',
};

/** Hue (0-360) and saturation (0-1) of a colour, or null when it can't be read. */
function hueAndSaturation(color: string): { hue: number; saturation: number } | null {
  let r: number, g: number, b: number;
  const value = color.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(value);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) digits = digits.slice(0, 3).split('').map((d) => d + d).join('');
    if (digits.length !== 6 && digits.length !== 8) return null;
    r = parseInt(digits.slice(0, 2), 16);
    g = parseInt(digits.slice(2, 4), 16);
    b = parseInt(digits.slice(4, 6), 16);
  } else {
    const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(value);
    const hsl = /^hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/.exec(value);
    if (rgb) {
      [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    } else if (hsl) {
      return { hue: Number(hsl[1]) % 360, saturation: Number(hsl[2]) / 100 };
    } else {
      return null;
    }
  }
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  const lightness = (max + min) / 2;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
  let hue = 0;
  if (delta !== 0) {
    if (max === rn) hue = ((gn - bn) / delta) % 6;
    else if (max === gn) hue = (bn - rn) / delta + 2;
    else hue = (rn - gn) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return { hue, saturation };
}

/**
 * The palette colour for `color`: a CSS colour (#hex, rgb(), hsl()) or a
 * tag palette name ("red", "teal-light"). Null when it can't be read.
 */
export function cvdHue(color: string | null | undefined): CvdHue | null {
  if (!color) return null;
  const paletteName = color.replace(/-(light|dark)$/, '');
  const parsed = hueAndSaturation(PALETTE_HUES[paletteName] ?? color);
  if (!parsed) return null;
  const { hue, saturation } = parsed;
  if (saturation < 0.15) return 'grey';
  if (hue < 18 || hue >= 345) return 'vermillion';
  if (hue < 44) return 'orange';
  if (hue < 70) return 'yellow';
  if (hue < 165) return 'bluishGreen';
  if (hue < 200) return 'skyBlue';
  if (hue < 255) return 'blue';
  return 'reddishPurple';
}

/**
 * The colour to draw `color` in: itself, or its colour-blind-safe
 * replacement when `enabled`. A colour it can't read is drawn as it is.
 */
export function cvdColor(color: string, enabled: boolean): string {
  if (!enabled) return color;
  const hue = cvdHue(color);
  return hue ? CVD_COLORS[hue] : color;
}

/** `#RRGGBB` at `alpha`, as rgba() (React Native has no 8-digit-hex tint helper here). */
function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export interface TagSwatch { dot: string; bg: string; text: string }

/**
 * A tag palette drawn colour-blind-safe, the way the webmail draws tags with
 * the setting on (CVD_CLASSES): the dot in the palette colour, the fill as a
 * 15 % tint of it, and the label in the text colour, since several of these
 * colours are too light to read as text.
 */
export function cvdTagPalette<K extends string>(tags: Record<K, TagSwatch>, textColor: string): Record<K, TagSwatch> {
  const out = {} as Record<K, TagSwatch>;
  for (const key of Object.keys(tags) as K[]) {
    const hex = CVD_COLORS[cvdHue(key) ?? cvdHue(tags[key].dot) ?? 'grey'];
    out[key] = { dot: hex, bg: withAlpha(hex, hex === CVD_COLORS.yellow ? 0.2 : 0.15), text: textColor };
  }
  return out;
}
