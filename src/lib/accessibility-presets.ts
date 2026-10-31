// Presets on Settings > Accessibility (webmail lib/accessibility-presets.ts,
// 8008393e5, 0731d24f6). A preset is a list of values applied once:
// afterwards they are ordinary settings the user can change, and presets can
// be combined. Nothing remembers which preset was used. Applying one can be
// undone, which puts back exactly the values it changed.
//
// The phone takes the presets whose settings it has: screen reader (no
// conversation grouping), low vision (150% text, labels under the toolbar
// icons), dyslexia (the reading font, also for plain-text mail) and motion
// (no animations). The webmail's others need settings the app doesn't have
// (spacing, focus outlines, hover, sounds).

import type { PersistedSettings } from '../stores/settings-store';

export type AccessibilityPresetId = 'screen-reader' | 'low-vision' | 'dyslexia' | 'motion';

export const ACCESSIBILITY_PRESET_IDS: readonly AccessibilityPresetId[] = ['screen-reader', 'low-vision', 'dyslexia', 'motion'];

type PresetValues = Partial<PersistedSettings>;

export const ACCESSIBILITY_PRESETS: Record<AccessibilityPresetId, PresetValues> = {
  // The webmail's: no conversation grouping (its reading-pane and announce
  // options have no phone counterpart).
  'screen-reader': {
    disableThreading: true,
  },
  'low-vision': {
    fontSize: 'xx-large',
    showToolbarLabels: true,
  },
  // The webmail's font part (its spacing, reading width and mail style
  // options have no phone counterpart yet).
  dyslexia: {
    appFont: 'atkinson',
    plainTextFont: 'sans',
  },
  motion: {
    animationsEnabled: false,
  },
};

export interface PresetChange {
  key: keyof PersistedSettings;
  from: unknown;
  to: unknown;
}

/**
 * The changes a preset would make to `state`: only values that differ, and
 * none the organisation has locked (`isLocked`) or bounded (`allows`, such
 * as a minimum toast duration).
 */
export function presetChanges(
  id: AccessibilityPresetId,
  state: Partial<PersistedSettings>,
  isLocked: (key: string) => boolean = () => false,
  allows: (key: string, value: unknown) => boolean = () => true,
): PresetChange[] {
  const changes: PresetChange[] = [];
  for (const [key, to] of Object.entries(ACCESSIBILITY_PRESETS[id]) as Array<[keyof PersistedSettings, unknown]>) {
    if (!(key in state) || state[key] === to || isLocked(key) || !allows(key, to)) continue;
    changes.push({ key, from: state[key], to });
  }
  return changes;
}

type Update = <K extends keyof PersistedSettings>(key: K, value: PersistedSettings[K]) => void;

/** Applies a preset's changes; returns them so they can be undone. */
export function applyPresetChanges(changes: PresetChange[], update: Update): void {
  for (const change of changes) update(change.key, change.to as never);
}

/**
 * Puts back what a preset changed. A setting the user changed again since
 * keeps the newer value.
 */
export function undoPresetChanges(changes: PresetChange[], state: Partial<PersistedSettings>, update: Update): void {
  for (const change of changes) {
    if (state[change.key] === change.to) update(change.key, change.from as never);
  }
}
