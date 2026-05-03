// Dynamic theme hooks that read settings the user can change at runtime.
// The static tokens in `./tokens` cover the baseline; these hooks return
// scaled / preference-driven variants so screens can react to settings
// without a relaunch.

import { useMemo } from 'react';
import { useSettingsStore } from '../stores/settings-store';
import { typography as baseTypography, spacing as baseSpacing } from './tokens';

export type FontScale = 'small' | 'medium' | 'large';
export type DensityKind = 'extra-compact' | 'compact' | 'regular' | 'comfortable';

const FONT_SCALE: Record<FontScale, number> = {
  small: 0.92,
  medium: 1,
  large: 1.12,
};

// How tall an email-list-style row should be. Mirrors the webmail
// `--density-item-py` token, halved for the per-side padding.
const ROW_PADY: Record<DensityKind, number> = {
  'extra-compact': 4,
  compact: 8,
  regular: 12,
  comfortable: 16,
};

// Vertical gap between rows (used for the FlatList separator strength too).
const ROW_GAP: Record<DensityKind, number> = {
  'extra-compact': 2,
  compact: 6,
  regular: 10,
  comfortable: 14,
};

function scaleStyle(
  style: { fontSize: number; lineHeight: number; fontWeight: '400' | '500' | '600' | '700' },
  factor: number,
) {
  return {
    fontSize: Math.round(style.fontSize * factor),
    lineHeight: Math.round(style.lineHeight * factor),
    fontWeight: style.fontWeight,
  };
}

export function useTypography() {
  const fontSize = useSettingsStore((s) => s.fontSize);
  return useMemo(() => {
    const f = FONT_SCALE[fontSize] ?? 1;
    if (f === 1) return baseTypography;
    return {
      h1: scaleStyle(baseTypography.h1, f),
      h2: scaleStyle(baseTypography.h2, f),
      h3: scaleStyle(baseTypography.h3, f),
      body: scaleStyle(baseTypography.body, f),
      bodyMedium: scaleStyle(baseTypography.bodyMedium, f),
      bodySemibold: scaleStyle(baseTypography.bodySemibold, f),
      bodyBold: scaleStyle(baseTypography.bodyBold, f),
      base: scaleStyle(baseTypography.base, f),
      baseMedium: scaleStyle(baseTypography.baseMedium, f),
      caption: scaleStyle(baseTypography.caption, f),
      captionMedium: scaleStyle(baseTypography.captionMedium, f),
      small: scaleStyle(baseTypography.small, f),
      tabLabel: scaleStyle(baseTypography.tabLabel, f),
    };
  }, [fontSize]);
}

export function useDensity() {
  const density = useSettingsStore((s) => s.density);
  return useMemo(
    () => ({
      kind: density,
      rowPaddingVertical: ROW_PADY[density] ?? ROW_PADY.regular,
      rowGap: ROW_GAP[density] ?? ROW_GAP.regular,
      // Compact modes hide secondary content so rows breathe less. The
      // webmail uses extra-compact to drop preview lines entirely.
      showPreview: density !== 'extra-compact' && density !== 'compact',
      showAvatar: density !== 'extra-compact',
      verticalSpacing: Math.max(2, baseSpacing.sm - (4 - ROW_PADY[density] / 4)),
    }),
    [density],
  );
}

// Returns whether the user has opted into in-app animations. When false,
// callers should pass duration=0 to `Animated.timing` so transitions snap.
export function useShouldAnimate() {
  return useSettingsStore((s) => s.animationsEnabled);
}

// Convenience: returns `requested` when animations are on, otherwise 0.
// Use as `Animated.timing(v, { duration: useAnimDuration(240), ... })`.
export function useAnimDuration(requested: number): number {
  const enabled = useShouldAnimate();
  return enabled ? requested : 0;
}
