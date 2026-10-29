import type { ThemePalette } from '../theme/tokens';

/**
 * Colours of the undo bar. The bar is drawn in the text colour, so what is
 * on it takes the background colour. The primary colour can't be used for
 * UNDO: the default dark theme's primary is white, like the bar.
 */
export function undoSnackbarColors(c: ThemePalette): { bar: string; label: string; action: string } {
  return { bar: c.text, label: c.background, action: c.background };
}
