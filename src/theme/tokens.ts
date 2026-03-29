// Qui Dark Theme — exact values from Bulwark Webmail's builtin-themes.ts
export const colors = {
  // Primary brand (Qui theme)
  primary: '#3b82f6',
  primaryDark: '#2563eb',
  primaryLight: '#60a5fa',
  primaryBg: '#172554',
  primaryBgHover: '#1e40af',
  primaryForeground: '#ffffff',

  // Backgrounds (Qui dark)
  background: '#09090b',
  surface: '#18181b',       // --color-secondary / --color-muted
  surfaceHover: '#1f1f23',
  surfaceActive: '#27272a',
  card: '#141414',          // --color-card
  cardForeground: '#fafafa',

  // Text (Qui dark)
  text: '#fafafa',          // --color-foreground
  textSecondary: '#a1a1aa', // --color-muted-foreground
  textMuted: '#71717a',
  textInverse: '#ffffff',
  textLink: '#60a5fa',

  // Borders (Qui dark)
  border: '#27272a',        // --color-border / --color-input
  borderLight: '#18181b',
  borderFocus: '#3b82f6',   // --color-ring

  // Status
  success: '#16a34a',
  successBg: '#052e16',
  successForeground: '#ffffff',
  warning: '#ca8a04',
  warningBg: '#422006',
  warningForeground: '#ffffff',
  error: '#ef4444',         // --color-destructive
  errorBg: '#450a0a',
  errorForeground: '#fafafa',
  info: '#60a5fa',
  infoForeground: '#ffffff',

  // Email-specific
  unread: '#60a5fa',        // --color-unread
  read: '#a1a1aa',
  starred: '#fbbf24',       // amber-400
  flagged: '#ef4444',
  draft: '#a78bfa',
  // Border variants (for inline opacity hacks)
  primaryBorder: 'rgba(59, 130, 246, 0.19)',      // primary + '30'
  errorBorder: 'rgba(239, 68, 68, 0.25)',         // error + '40'

  // Calendar event colors
  calendar: {
    blue: '#60a5fa',
    purple: '#a78bfa',
    green: '#4ade80',
    orange: '#fbbf24',
    red: '#f87171',
    pink: '#f472b6',
    teal: '#2dd4bf',
    indigo: '#818cf8',
     // Dark-mode backgrounds for colored icons (replaces hardcoded light colors)
     purpleBg: 'rgba(167, 139, 250, 0.08)',  // purple-950/30 dark
     tealBg: 'rgba(45, 212, 191, 0.08)',     // teal-950/30 dark
     indigoBg: 'rgba(129, 140, 248, 0.08)',  // indigo-950/30 dark
     pinkBg: 'rgba(244, 114, 182, 0.08)',    // pink-950/30 dark
     orangeBg: 'rgba(251, 191, 36, 0.08)',   // orange-950/30 dark
  },

  // Tag colors — from KEYWORD_PALETTE in stores/settings-store.ts
  // dark mode: bg-{color}-950/30, dot: bg-{color}-500, text: {color}-400
  tags: {
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
  },

  // Navigation — matches web nav-rail
  navActive: '#3b82f6',
  navInactive: '#71717a',     // --color-muted-foreground
  navBadge: '#ef4444',        // red-500

  // Secondary / Muted (Qui dark)
  secondary: '#18181b',
  secondaryForeground: '#fafafa',
  muted: '#18181b',
  mutedForeground: '#a1a1aa',

  // Accent (Qui dark)
  accent: '#172554',
  accentForeground: '#93c5fd',

  // Selection (Qui dark)
  selection: 'rgba(59, 130, 246, 0.25)',
  selectionForeground: '#93c5fd',

  // Popover (Qui dark)
  popover: '#18181b',
  popoverForeground: '#fafafa',

  // Chart colors (Qui dark)
  chart1: '#60a5fa',
  chart2: '#4ade80',
  chart3: '#fbbf24',
  chart4: '#f87171',
  chart5: '#a78bfa',
} as const;

// Spacing matches Tailwind's rem scale converted to px
export const spacing = {
  xs: 4,     // 0.25rem
  sm: 8,     // 0.5rem
  md: 12,    // 0.75rem
  lg: 16,    // 1rem
  xl: 20,    // 1.25rem
  xxl: 24,   // 1.5rem
  xxxl: 32,  // 2rem
} as const;

// Border radii matching Tailwind's rounded-* scale
export const radius = {
  xs: 4,      // rounded
  sm: 6,      // rounded-md
  md: 8,      // rounded-lg
  lg: 12,     // rounded-xl
  xl: 16,     // rounded-2xl
  full: 9999, // rounded-full
} as const;

// Typography matching web's Tailwind text-* classes
export const typography = {
  // Headings
  h1: { fontSize: 24, fontWeight: '700' as const, lineHeight: 32 },     // text-2xl
  h2: { fontSize: 20, fontWeight: '700' as const, lineHeight: 28 },     // text-xl
  h3: { fontSize: 18, fontWeight: '600' as const, lineHeight: 28 },     // text-lg
  // Body = text-sm (14px) — the web uses text-sm for almost all content
  body: { fontSize: 14, fontWeight: '400' as const, lineHeight: 20 },
  bodyMedium: { fontSize: 14, fontWeight: '500' as const, lineHeight: 20 },
  bodySemibold: { fontSize: 14, fontWeight: '600' as const, lineHeight: 20 },
  bodyBold: { fontSize: 14, fontWeight: '700' as const, lineHeight: 20 },
  // Base = text-base (16px) — used for email content body
  base: { fontSize: 16, fontWeight: '400' as const, lineHeight: 24 },
  baseMedium: { fontSize: 16, fontWeight: '500' as const, lineHeight: 24 },
  // Caption = text-xs (12px)
  caption: { fontSize: 12, fontWeight: '400' as const, lineHeight: 16 },
  captionMedium: { fontSize: 12, fontWeight: '500' as const, lineHeight: 16 },
  // Small = 10px — for tags, badges, tab labels
  small: { fontSize: 10, fontWeight: '500' as const, lineHeight: 14 },
  tabLabel: { fontSize: 10, fontWeight: '500' as const, lineHeight: 14 },
} as const;

// Component-specific sizes matching web
export const componentSizes = {
  // Avatars (web: w-8/w-10/w-12)
  avatarSm: 32,
  avatarMd: 40,
  avatarLg: 48,
  // Nav icons (web: w-5 h-5 = 20px)
  navIcon: 20,
  // Status icons (web: w-3.5 h-3.5 = 14px)
  statusIcon: 14,
  // Mobile header height (web: h-14 = 56px)
  headerHeight: 56,
  // Input height (web: h-10 = 40px)
  inputHeight: 40,
  // Button heights
  buttonSm: 36,   // h-9
  buttonMd: 40,    // h-10
  buttonLg: 44,    // h-11
  // Tag dot (web: w-1.5 h-1.5 = 6px)
  tagDot: 6,
  // Event dot (web: w-1.5 h-1.5 = 6px)
  eventDot: 6,
  // Toggle switch (web: h-6 w-11)
  toggleHeight: 24,
  toggleWidth: 44,
  toggleThumb: 16,
  // FAB (standard material)
  fab: 56,
  // Nav badge (web: min-w-4 h-4 = 16px)
  badgeSize: 16,
} as const;
