import { createContext } from 'react';
import type { View } from 'react-native';

/**
 * Keeps a settings form in view while the keyboard is up. Android draws the
 * app edge to edge, so the window does not shrink for the keyboard: a form at
 * the bottom of a settings page (Settings > Tags > Add tag) stayed under the
 * keyboard, and taps meant for its fields landed on the keys. The page pads
 * its bottom by the keyboard and scrolls the form the user is typing in above
 * it.
 */

/**
 * Hand a form's outer View to the settings page when one of its fields gets
 * focus; the page scrolls the whole form above the keyboard. Without a form,
 * the page scrolls the focused field into view.
 */
export const SettingsKeyboardContext = createContext<((form: View | null) => void) | null>(null);

/** Space kept between the form and the keyboard or the page top. */
export const REVEAL_MARGIN = 12;

/**
 * The height of the scroll area still visible above the keyboard.
 * `viewportTop` and `keyboardTop` are window coordinates.
 */
export function visibleHeightAboveKeyboard(viewportTop: number, viewportHeight: number, keyboardTop: number): number {
  return Math.max(0, Math.min(viewportHeight, keyboardTop - viewportTop));
}

/**
 * Where to scroll so the form (content coordinates `formTop`..`formBottom`)
 * fits in the `visibleHeight` above the keyboard, or null when it already
 * does. A form taller than that keeps its top in view.
 */
export function revealScrollY(
  scrollY: number,
  formTop: number,
  formBottom: number,
  visibleHeight: number,
  margin: number = REVEAL_MARGIN,
): number | null {
  if (visibleHeight <= 0) return null;
  const keepTop = formTop - margin;
  let target = scrollY;
  if (formBottom + margin > scrollY + visibleHeight) target = Math.min(formBottom + margin - visibleHeight, keepTop);
  else if (keepTop < scrollY) target = keepTop;
  target = Math.max(0, Math.round(target));
  return target === Math.round(scrollY) ? null : target;
}

/** Bottom padding of a settings page: room to scroll its end above the keyboard. */
export function settingsPagePaddingBottom(base: number, keyboard: number): number {
  return base + Math.max(0, Math.round(keyboard));
}
