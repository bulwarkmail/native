// One choice of a set of options (the undo-send delay, the Files sort order,
// the app language). Drawn as a styled Pressable, an option told a screen
// reader nothing about which one was picked: TalkBack read "5 seconds" for
// every chip alike. A radio role with the selected and checked state reads
// "selected" (Android) or "checked" (iOS) on the current one.

export interface RadioOptionA11y {
  accessibilityRole: 'radio';
  accessibilityState: { selected: boolean; checked: boolean };
}

export function radioOptionA11y(selected: boolean): RadioOptionA11y {
  return { accessibilityRole: 'radio', accessibilityState: { selected, checked: selected } };
}

/** For the View around the options. */
export const RADIO_GROUP_A11Y = { accessibilityRole: 'radiogroup' } as const;
