// Custom calendar colours (native #90): a hex field and a grid of shades
// under the presets, where the webmail offers a colour input
// (components/settings/calendar-management-settings.tsx).

/** `input` as "#rrggbb" (from "#abc", "abc", "#AABBCC"…), or null when it is no hex colour. */
export function normalizeHexColor(input: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  const hex = m[1].length === 3 ? m[1].split('').map((ch) => ch + ch).join('') : m[1];
  return `#${hex.toLowerCase()}`;
}

function hslToHex(h: number, s: number, l: number): string {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

/** Rows of shades (dark, mid, light) over twelve hues, then a grey row. */
export function customColorGrid(): string[][] {
  const hues = Array.from({ length: 12 }, (_, i) => i * 30);
  const rows = [0.3, 0.45, 0.65].map((l) => hues.map((h) => hslToHex(h, 0.7, l)));
  rows.push(Array.from({ length: 12 }, (_, i) => hslToHex(0, 0, 0.1 + (i * 0.8) / 11)));
  return rows;
}
