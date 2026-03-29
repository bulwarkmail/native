export const colors = {
  // Primary brand colors (matching Bulwark web)
  primary: '#3b82f6',
  primaryDark: '#2563eb',
  primaryLight: '#60a5fa',

  // Backgrounds
  background: '#ffffff',
  surface: '#f8fafc',
  surfaceHover: '#f1f5f9',

  // Text
  text: '#0f172a',
  textSecondary: '#64748b',
  textMuted: '#94a3b8',
  textInverse: '#ffffff',

  // Borders
  border: '#e2e8f0',
  borderLight: '#f1f5f9',

  // Status
  success: '#22c55e',
  warning: '#f59e0b',
  error: '#ef4444',
  info: '#3b82f6',

  // Email-specific
  unread: '#0f172a',
  read: '#64748b',
  starred: '#f59e0b',
  flagged: '#ef4444',

  // Dark mode
  dark: {
    background: '#0f172a',
    surface: '#1e293b',
    surfaceHover: '#334155',
    text: '#f8fafc',
    textSecondary: '#94a3b8',
    textMuted: '#64748b',
    border: '#334155',
    borderLight: '#1e293b',
  },
} as const;
