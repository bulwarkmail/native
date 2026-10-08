// Dynamic theme hooks that read settings the user can change at runtime.
// The static tokens in `./tokens` cover the baseline; these hooks return
// scaled / preference-driven variants so screens can react to settings
// without a relaunch.

import { useEffect, useMemo, useState } from 'react';
import { AccessibilityInfo } from 'react-native';
import { useSettingsStore } from '../stores/settings-store';
import { applyFontScale, FONT_SCALE, typography, spacing as baseSpacing } from './tokens';

export type DensityKind = 'extra-compact' | 'compact' | 'regular' | 'comfortable';

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

// Keeps `typography` at the stored font size. It applies the current size
// at once, then rescales inside the store's set(), so hydration and the
// setting both land before React renders the change. Returns the
// unsubscribe.
export function syncFontScale(): () => void {
  const apply = (size: keyof typeof FONT_SCALE) => applyFontScale(FONT_SCALE[size] ?? 1);
  apply(useSettingsStore.getState().fontSize);
  return useSettingsStore.subscribe((state, prev) => {
    if (state.fontSize !== prev.fontSize) apply(state.fontSize);
  });
}

// The live `typography`, with a new identity when the font size changes so
// memos keyed on it recompute.
export function useTypography() {
  const fontSize = useSettingsStore((s) => s.fontSize);
  return useMemo(() => ({ ...typography }), [fontSize]);
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

// OS-level "reduce motion" (Android: Remove animations / iOS: Reduce Motion).
// Read once and kept fresh via the change event; defaults to false until the
// first answer arrives.
let reduceMotionCache: boolean | null = null;
function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState<boolean>(reduceMotionCache ?? false);
  useEffect(() => {
    let mounted = true;
    const info = AccessibilityInfo as typeof AccessibilityInfo | undefined;
    if (!info?.isReduceMotionEnabled) return undefined;
    void info.isReduceMotionEnabled().then((value) => {
      reduceMotionCache = value;
      if (mounted) setReduce(value);
    }).catch(() => undefined);
    const sub = info.addEventListener?.('reduceMotionChanged', (value: boolean) => {
      reduceMotionCache = value;
      if (mounted) setReduce(value);
    });
    return () => {
      mounted = false;
      sub?.remove?.();
    };
  }, []);
  return reduce;
}

// Returns whether the user has opted into in-app animations. When false,
// callers should pass duration=0 to `Animated.timing` so transitions snap.
// Honours the OS reduce-motion preference as well (webmail:
// prefers-reduced-motion).
export function useShouldAnimate() {
  const enabled = useSettingsStore((s) => s.animationsEnabled);
  const reduceMotion = useReduceMotion();
  return enabled && !reduceMotion;
}

// Convenience: returns `requested` when animations are on, otherwise 0.
// Use as `Animated.timing(v, { duration: useAnimDuration(240), ... })`.
export function useAnimDuration(requested: number): number {
  const enabled = useShouldAnimate();
  return enabled ? requested : 0;
}
