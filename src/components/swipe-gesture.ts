// Pure decision logic behind SwipeableRow's pan gesture.
//
// This lives outside the component for a reason beyond tidiness: the row's
// PanResponder is created once and its handlers therefore close over whatever
// props existed at mount. Taking the config as an argument makes staleness
// structurally impossible here — there is nothing to capture — and leaves the
// component with one job, keeping the current config somewhere the handlers
// can reach.

import type { SwipeAction, SwipeMode } from '../stores/settings-store';

export const COMMIT_THRESHOLD = 96;
export const DISARM_THRESHOLD = 82;
export const ACTIVATION_THRESHOLD = 32;
export const REVEAL_WIDTH = 88;

const SWIPE_SLOPE_MAX = 0.85;
const SCROLL_FAIL_DY = 10;
const MAX_AMBIGUOUS_DY = 14;
const REVERSE_FLICK_VX = 0.35;
export const CLAIM_DX = 8;
export const ROW_PRESS_DELAY_MS = 90;
const MIN_FLICK_TRAVEL = 24;
const PROJECTION_MS = 120;
const STRETCH = 0.55;
const SETTLE_STIFFNESS = 1000;
export const SETTLE_SPRING = { stiffness: SETTLE_STIFFNESS, damping: 2 * Math.sqrt(SETTLE_STIFFNESS), mass: 1 };

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

export function fingerTravel(translationX: number): number {
  'worklet';
  if (translationX > CLAIM_DX) return translationX - CLAIM_DX;
  if (translationX < -CLAIM_DX) return translationX + CLAIM_DX;
  return 0;
}

export function panTravel(
  absoluteX: number | undefined,
  claimX: number,
  hasClaimX: boolean,
  translationX: number,
): number {
  'worklet';
  if (hasClaimX && typeof absoluteX === 'number' && !Number.isNaN(absoluteX)) {
    return absoluteX - claimX;
  }
  return fingerTravel(translationX);
}

export function decidePanActivation(
  dx: number,
  dy: number,
  config: SwipeConfig,
  openSide: OpenSide,
): 'activate' | 'fail' | 'wait' {
  'worklet';
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < CLAIM_DX && ay < SCROLL_FAIL_DY) return 'wait';
  if (ax >= CLAIM_DX && ay <= ax * SWIPE_SLOPE_MAX) {
    if (config.mode === 'reveal' && openSide !== null) return 'activate';
    if (dx > 0 && config.rightAction === 'none') return 'fail';
    if (dx < 0 && config.leftAction === 'none') return 'fail';
    return 'activate';
  }
  if (ay >= SCROLL_FAIL_DY && ay >= ax) return 'fail';
  if (ay >= MAX_AMBIGUOUS_DY) return 'fail';
  return 'wait';
}

function stretch(overshoot: number, dimension: number): number {
  'worklet';
  return (1 - 1 / ((overshoot * STRETCH) / dimension + 1)) * dimension;
}

export function dragOffset(
  g: SwipeGestureState,
  config: SwipeConfig,
  openSide: OpenSide,
  base: number = restingOffset(openSide),
): number {
  'worklet';
  const raw = base + g.dx;
  if (config.mode !== 'reveal') return raw;
  const limit = raw > 0
    ? (config.rightAction === 'none' ? 0 : REVEAL_WIDTH)
    : (config.leftAction === 'none' ? 0 : REVEAL_WIDTH);
  const reach = Math.abs(raw);
  if (reach <= limit) return raw;
  return Math.sign(raw) * (limit + stretch(reach - limit, REVEAL_WIDTH));
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

export function nextArmedState(
  offset: number,
  wasArmed: boolean,
  config: SwipeConfig,
  openSide: OpenSide,
): boolean {
  'worklet';
  if (config.mode === 'reveal') return releaseWouldAct(offset, config, openSide);
  const threshold = wasArmed ? DISARM_THRESHOLD : COMMIT_THRESHOLD;
  if (offset > 0) return config.rightAction !== 'none' && offset >= threshold;
  if (offset < 0) return config.leftAction !== 'none' && offset <= -threshold;
  return false;
}

export const FLY_MIN_MS = 110;
export const FLY_MAX_MS = 240;
const FLY_MAX_START_SLOPE = 2.4;
const FLY_END_SLOPE = 1.2;

export function flyPlan(distance: number, velocity: number): { duration: number; startSlope: number } {
  'worklet';
  const reach = Math.abs(distance);
  const along = Math.max(0, Math.sign(distance) * velocity);
  if (reach === 0 || along === 0) return { duration: FLY_MAX_MS, startSlope: 0 };
  let duration = FLY_MAX_MS;
  if ((along * duration) / reach > FLY_MAX_START_SLOPE) {
    duration = Math.max(FLY_MIN_MS, (FLY_MAX_START_SLOPE * reach) / along);
  }
  return { duration, startSlope: Math.min(FLY_MAX_START_SLOPE, (along * duration) / reach) };
}

export function flyProgress(startSlope: number, u: number): number {
  'worklet';
  const s = startSlope;
  const e = FLY_END_SLOPE;
  return s * u + (3 - 2 * s - e) * u * u + (s + e - 2) * u * u * u;
}

export function resolveRelease(
  g: SwipeGestureState,
  config: SwipeConfig,
  openSide: OpenSide,
  wasArmed = false,
): ReleaseOutcome {
  'worklet';
  if (config.mode === 'reveal') {
    const finalDx = restingOffset(openSide) + g.dx;
    const projected = finalDx + g.vx * PROJECTION_MS;
    if (finalDx > 0 && projected > ACTIVATION_THRESHOLD && config.rightAction !== 'none') {
      return { kind: 'open', side: 'right' };
    }
    if (finalDx < 0 && projected < -ACTIVATION_THRESHOLD && config.leftAction !== 'none') {
      return { kind: 'open', side: 'left' };
    }
    return { kind: 'close' };
  }
  const threshold = wasArmed ? DISARM_THRESHOLD : COMMIT_THRESHOLD;
  const minorBackRight = g.dx >= threshold && g.vx < 0 && -g.vx < REVERSE_FLICK_VX;
  const minorBackLeft = g.dx <= -threshold && g.vx > 0 && g.vx < REVERSE_FLICK_VX;
  const projectedRight = g.dx + (minorBackRight ? 0 : g.vx * PROJECTION_MS);
  const projectedLeft = g.dx + (minorBackLeft ? 0 : g.vx * PROJECTION_MS);
  if (g.dx >= MIN_FLICK_TRAVEL && projectedRight >= threshold && config.rightAction !== 'none') {
    return { kind: 'fire', action: config.rightAction, direction: 1 };
  }
  if (g.dx <= -MIN_FLICK_TRAVEL && projectedLeft <= -threshold && config.leftAction !== 'none') {
    return { kind: 'fire', action: config.leftAction, direction: -1 };
  }
  return { kind: 'settle' };
}

export function armChange(wasArmed: boolean, nowArmed: boolean): 'arm' | 'disarm' | null {
  'worklet';
  if (wasArmed === nowArmed) return null;
  return nowArmed ? 'arm' : 'disarm';
}

export function releaseHaptic(outcome: ReleaseOutcome, wasArmed: boolean): 'selection' | null {
  'worklet';
  if (outcome.kind !== 'fire' || wasArmed) return null;
  return 'selection';
}

/**
 * Actions that visibly remove the row from the list, so the row should fly off
 * instead of snapping back. Toggle-style actions stay in place.
 */
export function exitsRow(action: SwipeAction): boolean {
  'worklet';
  return action === 'archive' || action === 'delete' || action === 'spam' || action === 'move';
}
