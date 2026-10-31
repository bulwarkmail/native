import { useCallback, useMemo } from 'react';
import { useColorScheme } from 'react-native';
import { useSettingsStore } from '../stores/settings-store';
import { LIGHT_COLORS, DARK_COLORS, type ThemePalette } from './tokens';
import { getBuiltinTheme } from './builtin-themes';
import { cvdColor, cvdTagPalette } from '../lib/cvd-palette';

export type { ThemePalette };

const paletteCache = new Map<string, ThemePalette>();

/**
 * Base light/dark palette with the active built-in theme's overrides applied
 * (Settings → Themes). Memoised per (scheme, theme) pair so `useColors()`
 * keeps returning a stable object for `useMemo(() => makeStyles(c), [c])`.
 *
 * With "Colour-blind-safe colours" (Settings → Accessibility, webmail
 * colorBlindPalette) the tag colours are drawn in that palette
 * (lib/cvd-palette): every place that draws a tag from `c.tags` follows,
 * as the webmail's tag formatter does. The picked colours stay in
 * `tagsAsPicked` for the colour picker and tag settings.
 */
export function resolvePalette(scheme: 'light' | 'dark', themeId: string | null, colorBlind = false): ThemePalette {
  const base = scheme === 'light' ? LIGHT_COLORS : DARK_COLORS;
  const theme = getBuiltinTheme(themeId);
  if (!theme && !colorBlind) return base;
  const key = `${scheme}:${theme?.id ?? ''}:${colorBlind ? 'cvd' : ''}`;
  const cached = paletteCache.get(key);
  if (cached) return cached;
  let merged: ThemePalette = theme ? { ...base, ...(scheme === 'light' ? theme.light : theme.dark) } : base;
  if (colorBlind) {
    merged = { ...merged, tags: cvdTagPalette(merged.tags, merged.text), tagsAsPicked: merged.tags };
  }
  paletteCache.set(key, merged);
  return merged;
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
  const colorBlind = useSettingsStore((s) => s.colorBlindPalette);
  const systemScheme = useColorScheme();
  const resolved =
    themePref === 'system'
      ? systemScheme === 'light' ? 'light' : 'dark'
      : themePref;
  return useMemo(() => resolvePalette(resolved, activeThemeId, colorBlind), [resolved, activeThemeId, colorBlind]);
}

/**
 * Draws a colour the user picked (a calendar's, a tag's hex) in the
 * colour-blind-safe palette while that setting is on, and as it is otherwise
 * (webmail hooks/use-cvd-color.ts). For colours that don't come from
 * `c.tags`, such as calendar colours from the server.
 */
export function useCvdColor(): (color: string) => string {
  const enabled = useSettingsStore((s) => s.colorBlindPalette);
  return useCallback((color: string) => cvdColor(color, enabled), [enabled]);
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
