// Mirrors the webmail design tokens defined in app/globals.css.
// Two palettes (light + dark) live here; consumers should call `useColors()`
// from theme/colors.tsx to pick the active one based on the user's setting.
// The `colors` export below is kept as a "dark-default" fallback for
// not-yet-migrated StyleSheets so they keep rendering while migration is
// underway.

interface CalendarColors {
  blue: string; purple: string; green: string; orange: string;
  red: string; pink: string; teal: string; indigo: string;
  purpleBg: string; tealBg: string; indigoBg: string; pinkBg: string; orangeBg: string;
}

interface TagColor { dot: string; bg: string; text: string; }
interface TagColors {
  red: TagColor; orange: TagColor; yellow: TagColor; green: TagColor;
  blue: TagColor; purple: TagColor; pink: TagColor; teal: TagColor;
  cyan: TagColor; indigo: TagColor; amber: TagColor; lime: TagColor; gray: TagColor;
}

export interface ThemePalette {
  // Brand
  primary: string;
  primaryDark: string;
  primaryLight: string;
  primaryBg: string;
  primaryBgHover: string;
  primaryForeground: string;
  primaryBorder: string;

  // Surfaces
  background: string;
  surface: string;
  surfaceHover: string;
  surfaceActive: string;
  card: string;
  cardForeground: string;

  // Text
  text: string;
  textSecondary: string;
  textMuted: string;
  textInverse: string;
  textLink: string;

  // Borders
  border: string;
  borderLight: string;
  borderFocus: string;

  // Status
  success: string;
  successBg: string;
  successForeground: string;
  warning: string;
  warningBg: string;
  warningForeground: string;
  error: string;
  errorBg: string;
  errorForeground: string;
  errorBorder: string;
  info: string;
  infoForeground: string;

  // Email-specific
  unread: string;
  read: string;
  starred: string;
  flagged: string;
  draft: string;

  // Calendar
  calendar: CalendarColors;

  // Tags
  tags: TagColors;

  // Navigation
  navActive: string;
  navInactive: string;
  navBadge: string;

  // Secondary / muted / accent
  secondary: string;
  secondaryForeground: string;
  muted: string;
  mutedForeground: string;
  accent: string;
  accentForeground: string;

  // Selection
  selection: string;
  selectionForeground: string;

  // Popover
  popover: string;
  popoverForeground: string;

  // Charts
  chart1: string; chart2: string; chart3: string; chart4: string; chart5: string;
}

const TAGS: TagColors = {
  red:    { dot: '#ef4444', bg: 'rgba(69,10,10,0.30)',  text: '#f87171' },
  orange: { dot: '#f97316', bg: 'rgba(67,20,7,0.30)',   text: '#fb923c' },
  yellow: { dot: '#eab308', bg: 'rgba(66,32,6,0.30)',   text: '#fbbf24' },
  green:  { dot: '#22c55e', bg: 'rgba(5,46,22,0.30)',   text: '#4ade80' },
  blue:   { dot: '#3b82f6', bg: 'rgba(23,37,84,0.30)',  text: '#60a5fa' },
  purple: { dot: '#a855f7', bg: 'rgba(59,7,100,0.30)',  text: '#c084fc' },
  pink:   { dot: '#ec4899', bg: 'rgba(80,7,36,0.30)',   text: '#f472b6' },
  teal:   { dot: '#14b8a6', bg: 'rgba(4,47,46,0.30)',   text: '#2dd4bf' },
  cyan:   { dot: '#06b6d4', bg: 'rgba(8,51,68,0.30)',   text: '#22d3ee' },
  indigo: { dot: '#6366f1', bg: 'rgba(30,27,75,0.30)',  text: '#818cf8' },
  amber:  { dot: '#f59e0b', bg: 'rgba(69,26,3,0.30)',   text: '#fbbf24' },
  lime:   { dot: '#84cc16', bg: 'rgba(26,46,5,0.30)',   text: '#a3e635' },
  gray:   { dot: '#6b7280', bg: 'rgba(3,7,18,0.30)',    text: '#9ca3af' },
};

export const DARK_COLORS: ThemePalette = {
  primary: '#3b82f6',
  primaryDark: '#2563eb',
  primaryLight: '#60a5fa',
  primaryBg: '#172554',
  primaryBgHover: '#1e40af',
  primaryForeground: '#ffffff',
  primaryBorder: 'rgba(59, 130, 246, 0.19)',

  background: '#09090b',
  surface: '#18181b',
  surfaceHover: '#1f1f23',
  surfaceActive: '#27272a',
  card: '#141414',
  cardForeground: '#fafafa',

  text: '#fafafa',
  textSecondary: '#a1a1aa',
  textMuted: '#71717a',
  textInverse: '#0f172a',
  textLink: '#60a5fa',

  border: '#27272a',
  borderLight: '#18181b',
  borderFocus: '#3b82f6',

  success: '#16a34a',
  successBg: '#052e16',
  successForeground: '#ffffff',
  warning: '#ca8a04',
  warningBg: '#422006',
  warningForeground: '#ffffff',
  error: '#ef4444',
  errorBg: '#450a0a',
  errorForeground: '#fafafa',
  errorBorder: 'rgba(239, 68, 68, 0.25)',
  info: '#60a5fa',
  infoForeground: '#ffffff',

  unread: '#60a5fa',
  read: '#a1a1aa',
  starred: '#fbbf24',
  flagged: '#ef4444',
  draft: '#a78bfa',

  calendar: {
    blue: '#60a5fa', purple: '#a78bfa', green: '#4ade80', orange: '#fbbf24',
    red: '#f87171', pink: '#f472b6', teal: '#2dd4bf', indigo: '#818cf8',
    purpleBg: 'rgba(167, 139, 250, 0.08)',
    tealBg: 'rgba(45, 212, 191, 0.08)',
    indigoBg: 'rgba(129, 140, 248, 0.08)',
    pinkBg: 'rgba(244, 114, 182, 0.08)',
    orangeBg: 'rgba(251, 191, 36, 0.08)',
  },

  tags: TAGS,

  navActive: '#3b82f6',
  navInactive: '#71717a',
  navBadge: '#ef4444',

  secondary: '#18181b',
  secondaryForeground: '#fafafa',
  muted: '#18181b',
  mutedForeground: '#a1a1aa',
  accent: '#172554',
  accentForeground: '#93c5fd',

  selection: 'rgba(59, 130, 246, 0.25)',
  selectionForeground: '#93c5fd',

  popover: '#18181b',
  popoverForeground: '#fafafa',

  chart1: '#60a5fa', chart2: '#4ade80', chart3: '#fbbf24', chart4: '#f87171', chart5: '#a78bfa',
};

const LIGHT_TAGS: TagColors = {
  // For light mode, dot stays as the saturated swatch but bg gets lighter and text gets darker.
  red:    { dot: '#ef4444', bg: 'rgba(254,226,226,0.6)',  text: '#b91c1c' },
  orange: { dot: '#f97316', bg: 'rgba(254,237,213,0.6)',  text: '#c2410c' },
  yellow: { dot: '#eab308', bg: 'rgba(254,249,195,0.6)',  text: '#a16207' },
  green:  { dot: '#22c55e', bg: 'rgba(220,252,231,0.6)',  text: '#15803d' },
  blue:   { dot: '#3b82f6', bg: 'rgba(219,234,254,0.6)',  text: '#1d4ed8' },
  purple: { dot: '#a855f7', bg: 'rgba(243,232,255,0.6)',  text: '#7e22ce' },
  pink:   { dot: '#ec4899', bg: 'rgba(252,231,243,0.6)',  text: '#be185d' },
  teal:   { dot: '#14b8a6', bg: 'rgba(204,251,241,0.6)',  text: '#0f766e' },
  cyan:   { dot: '#06b6d4', bg: 'rgba(207,250,254,0.6)',  text: '#0e7490' },
  indigo: { dot: '#6366f1', bg: 'rgba(224,231,255,0.6)',  text: '#4338ca' },
  amber:  { dot: '#f59e0b', bg: 'rgba(254,243,199,0.6)',  text: '#b45309' },
  lime:   { dot: '#84cc16', bg: 'rgba(236,252,203,0.6)',  text: '#4d7c0f' },
  gray:   { dot: '#6b7280', bg: 'rgba(243,244,246,0.6)',  text: '#374151' },
};

export const LIGHT_COLORS: ThemePalette = {
  primary: '#3b82f6',
  primaryDark: '#2563eb',
  primaryLight: '#60a5fa',
  primaryBg: '#dbeafe',
  primaryBgHover: '#bfdbfe',
  primaryForeground: '#ffffff',
  primaryBorder: 'rgba(59, 130, 246, 0.25)',

  background: '#ffffff',
  surface: '#f8fafc',
  surfaceHover: '#f1f5f9',
  surfaceActive: '#e2e8f0',
  card: '#ffffff',
  cardForeground: '#0f172a',

  text: '#0f172a',
  textSecondary: '#64748b',
  textMuted: '#94a3b8',
  textInverse: '#ffffff',
  textLink: '#1d4ed8',

  border: '#e2e8f0',
  borderLight: '#f1f5f9',
  borderFocus: '#94a3b8',

  success: '#22c55e',
  successBg: '#dcfce7',
  successForeground: '#ffffff',
  warning: '#eab308',
  warningBg: '#fef9c3',
  warningForeground: '#ffffff',
  error: '#ef4444',
  errorBg: '#fee2e2',
  errorForeground: '#ffffff',
  errorBorder: 'rgba(239, 68, 68, 0.30)',
  info: '#3b82f6',
  infoForeground: '#ffffff',

  unread: '#3b82f6',
  read: '#64748b',
  starred: '#eab308',
  flagged: '#ef4444',
  draft: '#a855f7',

  calendar: {
    blue: '#3b82f6', purple: '#a855f7', green: '#22c55e', orange: '#f59e0b',
    red: '#ef4444', pink: '#ec4899', teal: '#14b8a6', indigo: '#6366f1',
    purpleBg: 'rgba(168, 85, 247, 0.10)',
    tealBg: 'rgba(20, 184, 166, 0.10)',
    indigoBg: 'rgba(99, 102, 241, 0.10)',
    pinkBg: 'rgba(236, 72, 153, 0.10)',
    orangeBg: 'rgba(245, 158, 11, 0.10)',
  },

  tags: LIGHT_TAGS,

  navActive: '#3b82f6',
  navInactive: '#64748b',
  navBadge: '#ef4444',

  secondary: '#f8fafc',
  secondaryForeground: '#0f172a',
  muted: '#f1f5f9',
  mutedForeground: '#64748b',
  accent: '#dbeafe',
  accentForeground: '#1e40af',

  selection: 'rgba(59, 130, 246, 0.18)',
  selectionForeground: '#1e40af',

  popover: '#ffffff',
  popoverForeground: '#0f172a',

  chart1: '#3b82f6', chart2: '#22c55e', chart3: '#f59e0b', chart4: '#ef4444', chart5: '#8b5cf6',
};

// Backwards-compat: not-yet-migrated StyleSheets keep importing `colors` and
// see the dark palette. Migrate component-by-component to `useColors()`.
export const colors = DARK_COLORS;

export const spacing = {
  xs: 4, sm: 8, md: 12, lg: 16, xl: 20, xxl: 24, xxxl: 32,
} as const;

export const radius = {
  xs: 4, sm: 6, md: 8, lg: 12, xl: 16, full: 9999,
} as const;

export const typography = {
  h1: { fontSize: 24, fontWeight: '700' as const, lineHeight: 32 },
  h2: { fontSize: 20, fontWeight: '700' as const, lineHeight: 28 },
  h3: { fontSize: 18, fontWeight: '600' as const, lineHeight: 28 },
  body: { fontSize: 14, fontWeight: '400' as const, lineHeight: 20 },
  bodyMedium: { fontSize: 14, fontWeight: '500' as const, lineHeight: 20 },
  bodySemibold: { fontSize: 14, fontWeight: '600' as const, lineHeight: 20 },
  bodyBold: { fontSize: 14, fontWeight: '700' as const, lineHeight: 20 },
  base: { fontSize: 16, fontWeight: '400' as const, lineHeight: 24 },
  baseMedium: { fontSize: 16, fontWeight: '500' as const, lineHeight: 24 },
  caption: { fontSize: 12, fontWeight: '400' as const, lineHeight: 16 },
  captionMedium: { fontSize: 12, fontWeight: '500' as const, lineHeight: 16 },
  small: { fontSize: 10, fontWeight: '500' as const, lineHeight: 14 },
  tabLabel: { fontSize: 10, fontWeight: '500' as const, lineHeight: 14 },
} as const;

export const componentSizes = {
  avatarSm: 32, avatarMd: 40, avatarLg: 48,
  navIcon: 20, statusIcon: 14,
  headerHeight: 56, inputHeight: 40,
  buttonSm: 36, buttonMd: 40, buttonLg: 44,
  tagDot: 6, eventDot: 6,
  toggleHeight: 24, toggleWidth: 44, toggleThumb: 16,
  fab: 56, badgeSize: 16,
} as const;
