/**
 * How far above its normal bottom the event editor's scroll area has to end
 * so the keyboard covers none of it (#81). `obstruction` is how much of the
 * screen bottom the keyboard covers (use-keyboard-obstruction),
 * `bottomInset` the safe-area inset the editor already keeps clear, and
 * `resizedBy` how much the window itself shrank for the keyboard: an
 * edge-to-edge Android dialog does not resize at all, a window that does
 * must not be shortened twice.
 */
export function editorKeyboardInset(obstruction: number, bottomInset: number, resizedBy: number): number {
  return Math.max(0, Math.round(obstruction - bottomInset - Math.max(0, resizedBy)));
}
