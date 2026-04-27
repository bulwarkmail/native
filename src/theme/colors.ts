import { useColorScheme } from 'react-native';
import { useSettingsStore } from '../stores/settings-store';
import { LIGHT_COLORS, DARK_COLORS, type ThemePalette } from './tokens';

export type { ThemePalette };

/**
 * Returns the active palette for the current render. Resolves the user's
 * theme preference ('light' | 'dark' | 'system') against the OS scheme.
 *
 * Prefer this hook in new and migrated components. Static `import { colors }`
 * still works for not-yet-migrated code (it always returns the dark palette).
 */
export function useColors(): ThemePalette {
  const themePref = useSettingsStore((s) => s.theme);
  const systemScheme = useColorScheme();
  const resolved =
    themePref === 'system'
      ? systemScheme === 'light' ? 'light' : 'dark'
      : themePref;
  return resolved === 'light' ? LIGHT_COLORS : DARK_COLORS;
}

/**
 * Resolves the user's theme preference to a concrete 'light' | 'dark'.
 * Useful for components that need to choose icons/imagery rather than colors.
 */
export function useResolvedTheme(): 'light' | 'dark' {
  const themePref = useSettingsStore((s) => s.theme);
  const systemScheme = useColorScheme();
  if (themePref === 'system') return systemScheme === 'light' ? 'light' : 'dark';
  return themePref;
}
