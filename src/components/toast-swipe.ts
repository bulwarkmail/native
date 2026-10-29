// Pure decisions behind the toast's swipe-to-dismiss. On the phone a toast has
// no close button; swiping it sideways dismisses it (repos/branding/APP.md).
// Like swipe-gesture.ts for list rows, this sits outside the component
// because the PanResponder is built once: everything it decides on arrives as
// an argument, so nothing can go stale.

/** The subset of RN's PanResponder gesture state this logic needs. */
export interface ToastSwipeGesture {
  dx: number;
  dy: number;
  vx: number;
}

const MIN_DX_TO_CLAIM = 6;
const DIRECTION_BIAS = 1.5; // dx must dominate dy by this factor
// A release past this share of the card's width dismisses it, capped so a
// wide screen does not ask for a long drag.
const DISMISS_FRACTION = 0.35;
const MAX_DISMISS_DISTANCE = 120;
// A short, fast flick dismisses too.
const FLING_DX = 30;
const FLING_VX = 0.5;

/** Whether a move is a sideways drag the toast should take over. */
export function shouldClaimToastSwipe(g: ToastSwipeGesture): boolean {
  if (Math.abs(g.dx) < MIN_DX_TO_CLAIM) return false;
  return Math.abs(g.dx) >= Math.abs(g.dy) * DIRECTION_BIAS;
}

/**
 * What releasing the drag does: 1 or -1 dismisses the toast towards that
 * side, 0 springs it back. `width` is the card's width (0 before layout).
 */
export function toastSwipeRelease(g: ToastSwipeGesture, width: number): 1 | -1 | 0 {
  const distance = width > 0 ? Math.min(MAX_DISMISS_DISTANCE, width * DISMISS_FRACTION) : MAX_DISMISS_DISTANCE;
  if (g.dx >= distance || (g.dx > FLING_DX && g.vx >= FLING_VX)) return 1;
  if (g.dx <= -distance || (g.dx < -FLING_DX && g.vx <= -FLING_VX)) return -1;
  return 0;
}
