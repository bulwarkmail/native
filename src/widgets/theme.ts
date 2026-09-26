// Home-screen widget palettes. These copy the webmail's standard theme as it
// renders (app/globals.css plus the Tailwind classes the list, calendar and
// sidebar use), not the in-app ThemePalette: in the webmail's dark mode the
// primary colour is white, while the native dark palette keeps a blue primary.
// Widgets are meant to look like the webmail, so they carry their own tokens.

import type { ColorProp } from 'react-native-android-widget';

export type WidgetScheme = 'light' | 'dark';

export interface WidgetPalette {
  scheme: WidgetScheme;
  /** Widget surface (webmail `--color-background`). */
  bg: ColorProp;
  fg: ColorProp;
  muted: ColorProp;
  /** Search pill, segmented track, quota ring track (webmail `--color-muted`). */
  mutedBg: ColorProp;
  border: ColorProp;
  /** Outer widget edge. */
  frame: ColorProp;
  primary: ColorProp;
  primaryFg: ColorProp;
  accent: ColorProp;
  accentFg: ColorProp;
  /** `bg-accent/30`, the tint of an unread message row. */
  unreadRow: ColorProp;
  unreadDot: ColorProp;
  /** Agenda day-header band. */
  dayHeader: ColorProp;
  /** "Today" label in the agenda. */
  today: ColorProp;
  /** Read subject (`text-foreground/90`). */
  subjectRead: ColorProp;
  success: ColorProp;
  successText: ColorProp;
  successBg: ColorProp;
  info: ColorProp;
  infoBg: ColorProp;
  destructive: ColorProp;
  destructiveBg: ColorProp;
  overdue: ColorProp;
  dueToday: ColorProp;
  star: ColorProp;
  /** Outline button edge (webmail `--color-input`). */
  input: ColorProp;
  /** Scheduled-send label (`sky-500/10` pill with `sky-700/300` text). */
  scheduledBg: ColorProp;
  scheduledText: ColorProp;
  warningBg: ColorProp;
  warningText: ColorProp;
  folder: {
    inbox: ColorProp;
    drafts: ColorProp;
    sent: ColorProp;
    scheduled: ColorProp;
    archive: ColorProp;
    junk: ColorProp;
  };
}

export const LIGHT: WidgetPalette = {
  scheme: 'light',
  bg: '#ffffff',
  fg: '#0f172a',
  muted: '#64748b',
  mutedBg: '#f1f5f9',
  border: '#e2e8f0',
  frame: '#e2e8f0',
  primary: '#3b82f6',
  primaryFg: '#ffffff',
  accent: '#dbeafe',
  accentFg: '#1e40af',
  unreadRow: '#f4f9ff',
  unreadDot: '#3b82f6',
  dayHeader: '#f4f7fa',
  today: '#3b82f6',
  subjectRead: '#283548',
  success: '#22c55e',
  successText: '#15803d',
  successBg: 'rgba(34, 197, 94, 0.15)',
  info: '#2563eb',
  infoBg: 'rgba(59, 130, 246, 0.15)',
  destructive: '#ef4444',
  destructiveBg: 'rgba(239, 68, 68, 0.15)',
  overdue: '#e7000b',
  dueToday: '#155dfc',
  star: '#fbbf24',
  input: '#e2e8f0',
  scheduledBg: 'rgba(0, 166, 244, 0.1)',
  scheduledText: '#0069a8',
  warningBg: 'rgba(254, 154, 0, 0.12)',
  warningText: '#973c00',
  folder: {
    inbox: '#155dfccc',
    drafts: '#7f22fecc',
    sent: '#009966cc',
    scheduled: '#0084d1',
    archive: '#e17100cc',
    junk: '#e7000bcc',
  },
};

export const DARK: WidgetPalette = {
  scheme: 'dark',
  bg: '#0a0a0a',
  fg: '#fafafa',
  muted: '#a3a3a3',
  mutedBg: '#262626',
  border: '#2d2d2d',
  frame: 'rgba(128, 128, 128, 0.3)',
  primary: '#fafafa',
  primaryFg: '#171717',
  accent: '#1e3a8a',
  accentFg: '#dbeafe',
  unreadRow: '#0f1830',
  unreadDot: '#60a5fa',
  dayHeader: '#202020',
  today: '#fafafa',
  subjectRead: '#e1e1e1',
  success: '#16a34a',
  successText: '#22c55e',
  successBg: 'rgba(22, 163, 74, 0.15)',
  info: '#60a5fa',
  infoBg: 'rgba(96, 165, 250, 0.15)',
  destructive: '#ef4444',
  destructiveBg: 'rgba(239, 68, 68, 0.15)',
  overdue: '#ff6467',
  dueToday: '#51a2ff',
  star: '#fbbf24',
  input: '#262626',
  scheduledBg: 'rgba(0, 166, 244, 0.1)',
  scheduledText: '#74d4ff',
  warningBg: 'rgba(254, 154, 0, 0.12)',
  warningText: '#ffd230',
  folder: {
    inbox: '#51a2ffcc',
    drafts: '#a684ffcc',
    sent: '#00d492cc',
    scheduled: '#00bcff',
    archive: '#ffb900cc',
    junk: '#ff6467cc',
  },
};

/** Tint a calendar colour the way event chips do (`${color}24`, ~14% alpha). */
export function chipBackground(color: string): ColorProp {
  const hex = normalizeHex(color);
  return `${hex}24` as ColorProp;
}

/** Accepts `#rgb`, `#rrggbb`, `hsl(h, s%, l%)`; anything else falls back to blue. */
export function normalizeHex(color: string | null | undefined): `#${string}` {
  if (!color) return '#3b82f6';
  const c = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase() as `#${string}`;
  if (/^#[0-9a-f]{3}$/i.test(c)) {
    const [r, g, b] = c.slice(1).split('');
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase() as `#${string}`;
  }
  if (/^#[0-9a-f]{8}$/i.test(c)) return c.slice(0, 7).toLowerCase() as `#${string}`;
  const hsl = /^hsla?\(\s*([\d.]+)\s*,\s*([\d.]+)%\s*,\s*([\d.]+)%/i.exec(c);
  if (hsl) return hslToHex(Number(hsl[1]), Number(hsl[2]), Number(hsl[3]));
  return '#3b82f6';
}

export function hslToHex(h: number, s: number, l: number): `#${string}` {
  const sat = s / 100;
  const light = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(light, 1 - light);
  const f = (n: number) => light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const hex = [f(0), f(8), f(4)]
    .map((x) => Math.round(x * 255).toString(16).padStart(2, '0'))
    .join('');
  return `#${hex}`;
}
