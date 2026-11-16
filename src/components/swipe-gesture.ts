// Pure decision logic behind SwipeableRow's pan gesture.
//
// This lives outside the component for a reason beyond tidiness: the row's
// PanResponder is created once and its handlers therefore close over whatever
// props existed at mount. Taking the config as an argument makes staleness
// structurally impossible here — there is nothing to capture — and leaves the
// component with one job, keeping the current config somewhere the handlers
// can reach.

import type { SwipeAction, SwipeMode } from '../stores/settings-store';

// Instant mode: distance the user must drag past on release to fire the action.
export const COMMIT_THRESHOLD = 96;
// Reveal mode: drag past this on release to snap to the open (revealed) state.
export const ACTIVATION_THRESHOLD = 32;
// Reveal mode: width of the action band shown when revealed.
export const REVEAL_WIDTH = 88;

const DIRECTION_BIAS = 1.5; // dx must dominate dy by this factor
const MIN_DX_TO_CLAIM = 6;
const MAX_DRAG_OVERSHOOT_INSTANT = 240;
const MAX_DRAG_OVERSHOOT_REVEAL = REVEAL_WIDTH * 1.4;
// A short, fast drag commits too, so the gesture doesn't demand the full
// COMMIT_THRESHOLD when the user clearly flicks.
const FLING_DX = 40;
const FLING_VX = 0.5;

/**
 * The row's current swipe configuration.
 *
 * Note the naming: `rightAction` fires on a rightward (positive dx) drag and
 * its band sits at the *left* edge; `leftAction` is the mirror image.
 */
export interface SwipeConfig {
  leftAction: SwipeAction;
  rightAction: SwipeAction;
  mode: SwipeMode;
}

/** The subset of RN's PanResponder gesture state this logic needs. */
export interface SwipeGestureState {
  dx: number;
  dy: number;
  vx: number;
}

/** Which side's action band is currently held open (reveal mode only). */
export type OpenSide = 'left' | 'right' | null;

export type ReleaseOutcome =
  /** Reveal mode: snap open so the band can be tapped. */
  | { kind: 'open'; side: 'left' | 'right' }
  /** Reveal mode: snap shut. */
  | { kind: 'close' }
  /** Instant mode: run the action; `direction` is the sign to fly the row off by. */
  | { kind: 'fire'; action: SwipeAction; direction: 1 | -1 }
  /** Not far enough — spring back to rest without firing. */
  | { kind: 'settle' };

/**
 * Whether the pan should be claimed from whatever else might want it (the
 * list's vertical scroll, mainly). Declining leaves the gesture to the parent.
 */
export function shouldClaimGesture(
  g: SwipeGestureState,
  config: SwipeConfig,
  openSide: OpenSide,
): boolean {
  if (Math.abs(g.dx) < MIN_DX_TO_CLAIM) return false;
  if (Math.abs(g.dx) < Math.abs(g.dy) * DIRECTION_BIAS) return false;
  // An already-open row claims any horizontal drag so the user can drag it
  // shut, even in the direction whose action is 'none'.
  if (config.mode === 'reveal' && openSide !== null) return true;
  if (g.dx > 0 && config.rightAction === 'none') return false;
  if (g.dx < 0 && config.leftAction === 'none') return false;
  return true;
}

/** Row translation for an in-progress drag, clamped to the mode's overshoot. */
export function dragOffset(
  g: SwipeGestureState,
  config: SwipeConfig,
  openSide: OpenSide,
): number {
  'worklet';
  const reveal = config.mode === 'reveal';
  const overshoot = reveal ? MAX_DRAG_OVERSHOOT_REVEAL : MAX_DRAG_OVERSHOOT_INSTANT;
  const base = reveal ? restingOffset(openSide) : 0;
  return Math.max(-overshoot, Math.min(overshoot, base + g.dx));
}

/** Where the row sits at rest, given which side is open. */
export function restingOffset(openSide: OpenSide): number {
  'worklet';
  if (openSide === 'right') return REVEAL_WIDTH;
  if (openSide === 'left') return -REVEAL_WIDTH;
  return 0;
}

export function releaseWouldAct(offset: number, config: SwipeConfig, openSide: OpenSide): boolean {
  'worklet';
  const reach = config.mode === 'reveal' ? ACTIVATION_THRESHOLD : COMMIT_THRESHOLD;
  const strict = config.mode === 'reveal';
  if (offset > 0) return config.rightAction !== 'none' && (strict ? offset > reach : offset >= reach);
  if (offset < 0) return config.leftAction !== 'none' && (strict ? offset < -reach : offset <= -reach);
  return false;
}

export const FLY_MIN_MS = 120;
export const FLY_MAX_MS = 260;

export function flyDuration(distance: number, velocity: number): number {
  const speed = Math.abs(velocity);
  if (speed === 0) return FLY_MAX_MS;
  return Math.max(FLY_MIN_MS, Math.min(FLY_MAX_MS, (2 * Math.abs(distance)) / speed));
}

/** What releasing the drag here should do. */
export function resolveRelease(
  g: SwipeGestureState,
  config: SwipeConfig,
  openSide: OpenSide,
): ReleaseOutcome {
  if (config.mode === 'reveal') {
    const finalDx = restingOffset(openSide) + g.dx;
    if (finalDx > ACTIVATION_THRESHOLD && config.rightAction !== 'none') {
      return { kind: 'open', side: 'right' };
    }
    if (finalDx < -ACTIVATION_THRESHOLD && config.leftAction !== 'none') {
      return { kind: 'open', side: 'left' };
    }
    return { kind: 'close' };
  }
  // Instant mode: fire on release-past-threshold, no second tap.
  const committedRight = g.dx >= COMMIT_THRESHOLD || (g.dx > FLING_DX && g.vx >= FLING_VX);
  if (committedRight && config.rightAction !== 'none') {
    return { kind: 'fire', action: config.rightAction, direction: 1 };
  }
  const committedLeft = g.dx <= -COMMIT_THRESHOLD || (g.dx < -FLING_DX && g.vx <= -FLING_VX);
  if (committedLeft && config.leftAction !== 'none') {
    return { kind: 'fire', action: config.leftAction, direction: -1 };
  }
  return { kind: 'settle' };
}

/**
 * Actions that visibly remove the row from the list, so the row should fly off
 * instead of snapping back. Toggle-style actions stay in place.
 */
export function exitsRow(action: SwipeAction): boolean {
  return action === 'archive' || action === 'delete' || action === 'spam' || action === 'move';
}
