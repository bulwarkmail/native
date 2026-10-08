import type { ThemePalette } from '../theme/tokens';

// The drawer's per-role tints (#288), the same hues as the webmail's
// ROLE_ICON_COLOR.
const ROLE_COLOR_FIXED: Record<string, string> = {
  inbox: '#60a5fa',
  sent: '#4ade80',
  drafts: '#a78bfa',
  junk: '#f87171',
  spam: '#f87171',
  archive: '#fbbf24',
  important: '#f97316',
  flagged: '#f59e0b',
  scheduled: '#38bdf8',
  snoozed: '#c084fc',
  memos: '#fbbf24',
};

/**
 * The colour of a folder icon in the drawer. With colourful icons on, role
 * folders get their tint and Trash is muted; with them off (the
 * colorfulSidebarIcons setting) every icon takes the plain text colour, as in
 * the webmail.
 */
export function roleIconColor(
  role: string | null | undefined,
  isSelected: boolean,
  colorful: boolean,
  c: Pick<ThemePalette, 'text' | 'textSecondary' | 'textMuted'>,
): string {
  if (colorful && role === 'trash') return c.textMuted;
  // Own-property check: the role is server text, and 'constructor' is not a colour.
  if (colorful && role && Object.prototype.hasOwnProperty.call(ROLE_COLOR_FIXED, role)) return ROLE_COLOR_FIXED[role];
  return isSelected ? c.text : c.textSecondary;
}
