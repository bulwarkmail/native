import { useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { useSettingsStore } from '../stores/settings-store';
import { LIGHT_COLORS, DARK_COLORS, type ThemePalette } from './tokens';
import type { FontSize } from '../stores/settings-store';
import { getBuiltinTheme } from './builtin-themes';

export type { ThemePalette };

const paletteCache = new Map<string, ThemePalette>();

/**
 * Base light/dark palette with the active built-in theme's overrides applied
 * (Settings → Themes). Memoised per (scheme, theme) pair so `useColors()`
 * keeps returning a stable object for `useMemo(() => makeStyles(c), [c])`.
 */
export function resolvePalette(scheme: 'light' | 'dark', themeId: string | null): ThemePalette {
  const base = scheme === 'light' ? LIGHT_COLORS : DARK_COLORS;
  const theme = getBuiltinTheme(themeId);
  if (!theme) return base;
  const key = `${scheme}:${theme.id}`;
  const cached = paletteCache.get(key);
  if (cached) return cached;
  const merged: ThemePalette = { ...base, ...(scheme === 'light' ? theme.light : theme.dark) };
  paletteCache.set(key, merged);
  return merged;
}

const scaledCache = new Map<string, ThemePalette>();

/**
 * `resolvePalette` with one identity per font size. The palette's values do
 * not depend on the size, but every `useMemo(() => makeStyles(c), [c])` keys
 * on the palette, so a new identity makes those styles rebuild with the
 * rescaled `typography`.
 */
export function scaledPalette(scheme: 'light' | 'dark', themeId: string | null, fontSize: FontSize): ThemePalette {
  const key = `${scheme}:${themeId ?? ''}:${fontSize}`;
  const cached = scaledCache.get(key);
  if (cached) return cached;
  const palette = { ...resolvePalette(scheme, themeId) };
  scaledCache.set(key, palette);
  return palette;
}

/**
 * Returns the active palette for the current render. Resolves the user's
 * theme preference ('light' | 'dark' | 'system') against the OS scheme and
 * applies the selected built-in theme.
 *
 * Prefer this hook in new and migrated components. Static `import { colors }`
 * still works for not-yet-migrated code (it always returns the dark palette).
 */
export function useColors(): ThemePalette {
  const themePref = useSettingsStore((s) => s.theme);
  const activeThemeId = useSettingsStore((s) => s.activeThemeId);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const systemScheme = useColorScheme();
  const resolved =
    themePref === 'system'
      ? systemScheme === 'light' ? 'light' : 'dark'
      : themePref;
  return useMemo(
    () => scaledPalette(resolved, activeThemeId, fontSize),
    [resolved, activeThemeId, fontSize],
  );
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
