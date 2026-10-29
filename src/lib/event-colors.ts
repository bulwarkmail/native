// Colours for calendar events, which every view draws as a solid block of
// the calendar colour (repos/branding/APP.md, "Calendar events"). The label
// colour is computed from the fill rather than taken from the palette: a
// fixed "inverse" text colour flips with the theme while the fill does not.
// React Native has no color-mix(), so the declined/cancelled label colour is
// mixed here too.

export interface Rgba {
  /** 0–255 */
  r: number;
  g: number;
  b: number;
  /** 0–1 */
  a: number;
}

/** Label colour on fills too light for white. */
export const DARK_EVENT_TEXT = '#111827';
const WHITE = '#ffffff';

/** Share of the calendar colour in a declined or cancelled event's label. */
export const INACTIVE_TEXT_MIX = 0.55;

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function hexByte(hex: string): number {
  return parseInt(hex.length === 1 ? hex + hex : hex, 16);
}

// One rgb() channel: 0–255, or a percentage of 255.
function channel(token: string): number | null {
  const pct = token.endsWith('%');
  const n = Number(pct ? token.slice(0, -1) : token);
  if (!Number.isFinite(n)) return null;
  return clamp(pct ? (n / 100) * 255 : n, 0, 255);
}

// The alpha of rgba(): 0–1, or a percentage.
function alpha(token: string): number | null {
  const pct = token.endsWith('%');
  const n = Number(pct ? token.slice(0, -1) : token);
  if (!Number.isFinite(n)) return null;
  return clamp(pct ? n / 100 : n, 0, 1);
}

/**
 * Parses `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, and `rgb()` / `rgba()` in
 * both the comma and the space-separated syntax. Anything else (named
 * colours, hsl()) gives null.
 */
export function parseColor(input: string | null | undefined): Rgba | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();

  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(s);
  if (hex) {
    const h = hex[1];
    const short = h.length <= 4;
    const parts = short ? h.split('') : h.match(/../g) ?? [];
    const [r, g, b, a] = parts.map(hexByte);
    return { r, g, b, a: a === undefined ? 1 : a / 255 };
  }

  const fn = /^rgba?\(([^)]*)\)$/.exec(s);
  if (fn) {
    const body = fn[1].trim();
    let tokens: string[];
    let alphaToken: string | undefined;
    if (body.includes(',')) {
      tokens = body.split(',').map((t) => t.trim());
      if (tokens.length === 4) alphaToken = tokens.pop();
    } else {
      const [rgb, a] = body.split('/').map((t) => t.trim());
      tokens = rgb ? rgb.split(/\s+/) : [];
      alphaToken = a;
    }
    if (tokens.length !== 3) return null;
    const [r, g, b] = tokens.map(channel);
    const a = alphaToken === undefined ? 1 : alpha(alphaToken);
    if (r === null || g === null || b === null || a === null) return null;
    return { r, g, b, a };
  }

  return null;
}

/** WCAG relative luminance of an sRGB colour (alpha ignored). */
export function relativeLuminance({ r, g, b }: Rgba): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/**
 * Label colour for text on a solid event fill: white while white keeps 3:1
 * contrast with the fill, `#111827` on lighter fills. A colour that cannot be
 * parsed gets white, like the webmail's readableTextOn().
 */
export function readableTextOn(fill: string): string {
  const rgb = parseColor(fill);
  if (!rgb) return WHITE;
  const contrastWithWhite = 1.05 / (relativeLuminance(rgb) + 0.05);
  return contrastWithWhite >= 3 ? WHITE : DARK_EVENT_TEXT;
}

function toHexByte(n: number): string {
  return Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0');
}

/** `#rrggbb` for an opaque colour, `rgba(…)` otherwise. */
export function formatColor({ r, g, b, a }: Rgba): string {
  if (a >= 1) return `#${toHexByte(r)}${toHexByte(g)}${toHexByte(b)}`;
  const round = (n: number) => Math.round(clamp(n, 0, 255));
  return `rgba(${round(r)}, ${round(g)}, ${round(b)}, ${Number(a.toFixed(3))})`;
}

/**
 * CSS `color-mix(in srgb, a <weight>, b)`: `weight` (0–1) of `a`, the rest
 * of `b`, with premultiplied alpha as CSS does. Null when either colour
 * cannot be parsed.
 */
export function mixColors(a: string, b: string, weight: number): string | null {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return null;
  const wa = clamp(weight, 0, 1);
  const wb = 1 - wa;
  const outA = ca.a * wa + cb.a * wb;
  if (outA === 0) return formatColor({ r: 0, g: 0, b: 0, a: 0 });
  const mix = (x: number, y: number) => (x * ca.a * wa + y * cb.a * wb) / outA;
  return formatColor({ r: mix(ca.r, cb.r), g: mix(ca.g, cb.g), b: mix(ca.b, cb.b), a: outA });
}

/**
 * Label colour of a declined or cancelled event: the calendar colour mixed
 * 55% with the text colour. Falls back to the text colour when the calendar
 * colour cannot be parsed.
 */
export function inactiveEventTextColor(calendarColor: string, textColor: string): string {
  return mixColors(calendarColor, textColor, INACTIVE_TEXT_MIX) ?? textColor;
}

export interface EventBlockColors {
  /** Block background. */
  fill: string;
  /** Title and time. */
  text: string;
  /** Inset border in the calendar colour, for declined and cancelled events only. */
  border: string | null;
}

/**
 * Fill, label and border of an event block, bar or chip. Active events are
 * solid calendar colour with a computed label colour; declined and cancelled
 * ones sit on the page ground inside a calendar-coloured border.
 */
export function eventBlockColors(
  calendarColor: string,
  inactive: boolean,
  page: { background: string; text: string },
): EventBlockColors {
  if (inactive) {
    return {
      fill: page.background,
      text: inactiveEventTextColor(calendarColor, page.text),
      border: calendarColor,
    };
  }
  return { fill: calendarColor, text: readableTextOn(calendarColor), border: null };
}
