import { describe, it, expect } from 'vitest';
import {
  shouldClaimGesture,
  dragOffset,
  resolveRelease,
  restingOffset,
  exitsRow,
  releaseWouldAct,
  flyDuration,
  FLY_MIN_MS,
  FLY_MAX_MS,
  COMMIT_THRESHOLD,
  ACTIVATION_THRESHOLD,
  REVEAL_WIDTH,
  type SwipeConfig,
} from '../swipe-gesture';

const instant = (over: Partial<SwipeConfig> = {}): SwipeConfig => ({
  mode: 'instant',
  leftAction: 'delete',
  rightAction: 'archive',
  ...over,
});

const reveal = (over: Partial<SwipeConfig> = {}): SwipeConfig => instant({ mode: 'reveal', ...over });

// PanResponder hands over dx/dy/vx; the rest of the gesture state is unused.
const g = (dx: number, opts: { dy?: number; vx?: number } = {}) => ({
  dx,
  dy: opts.dy ?? 0,
  vx: opts.vx ?? 0,
});

describe('shouldClaimGesture', () => {
  it('ignores drags too short to be intentional', () => {
    expect(shouldClaimGesture(g(4), instant(), null)).toBe(false);
    expect(shouldClaimGesture(g(-4), instant(), null)).toBe(false);
  });

  it('leaves mostly-vertical drags to the list scroll', () => {
    expect(shouldClaimGesture(g(20, { dy: 40 }), instant(), null)).toBe(false);
    expect(shouldClaimGesture(g(40, { dy: 20 }), instant(), null)).toBe(true);
  });

  it("declines the direction whose action is 'none'", () => {
    const config = instant({ rightAction: 'none' });
    expect(shouldClaimGesture(g(50), config, null)).toBe(false);
    expect(shouldClaimGesture(g(-50), config, null)).toBe(true);
  });

  it("declines both directions in selection mode, where both actions are 'none'", () => {
    const config = instant({ leftAction: 'none', rightAction: 'none' });
    expect(shouldClaimGesture(g(50), config, null)).toBe(false);
    expect(shouldClaimGesture(g(-50), config, null)).toBe(false);
  });

  it('claims any direction while a reveal band is open, so it can be dragged shut', () => {
    const config = reveal({ leftAction: 'none', rightAction: 'archive' });
    expect(shouldClaimGesture(g(-50), config, 'right')).toBe(true);
    // ...but not once it is closed again.
    expect(shouldClaimGesture(g(-50), config, null)).toBe(false);
  });
});

describe('dragOffset', () => {
  it('tracks the finger in instant mode', () => {
    expect(dragOffset(g(70), instant(), null)).toBe(70);
    expect(dragOffset(g(-70), instant(), null)).toBe(-70);
  });

  it('clamps to the overshoot limit', () => {
    expect(dragOffset(g(9999), instant(), null)).toBe(240);
    expect(dragOffset(g(-9999), instant(), null)).toBe(-240);
    // Reveal mode allows much less overshoot than instant.
    expect(dragOffset(g(9999), reveal(), null)).toBeCloseTo(REVEAL_WIDTH * 1.4);
  });

  it('offsets from the open position in reveal mode', () => {
    // Already open to the right; dragging back left should approach 0.
    expect(dragOffset(g(-REVEAL_WIDTH), reveal(), 'right')).toBe(0);
    expect(dragOffset(g(-10), reveal(), 'right')).toBe(REVEAL_WIDTH - 10);
  });
});

describe('resolveRelease — instant mode', () => {
  it('fires the action for the direction dragged past the threshold', () => {
    expect(resolveRelease(g(COMMIT_THRESHOLD), instant(), null)).toEqual({
      kind: 'fire',
      action: 'archive',
      direction: 1,
    });
    expect(resolveRelease(g(-COMMIT_THRESHOLD), instant(), null)).toEqual({
      kind: 'fire',
      action: 'delete',
      direction: -1,
    });
  });

  it('accepts a short fast flick as a commit', () => {
    expect(resolveRelease(g(50, { vx: 0.8 }), instant(), null)).toMatchObject({ kind: 'fire' });
    // Same distance, too slow.
    expect(resolveRelease(g(50, { vx: 0.2 }), instant(), null)).toEqual({ kind: 'settle' });
  });

  it('springs back when the drag stops short', () => {
    expect(resolveRelease(g(COMMIT_THRESHOLD - 1), instant(), null)).toEqual({ kind: 'settle' });
  });

  it("never fires an action configured as 'none'", () => {
    const config = instant({ rightAction: 'none' });
    expect(resolveRelease(g(999, { vx: 5 }), config, null)).toEqual({ kind: 'settle' });
  });

  it('fires nothing in selection mode, however hard the row is flung', () => {
    const config = instant({ leftAction: 'none', rightAction: 'none' });
    expect(resolveRelease(g(999, { vx: 5 }), config, null)).toEqual({ kind: 'settle' });
    expect(resolveRelease(g(-999, { vx: -5 }), config, null)).toEqual({ kind: 'settle' });
  });
});

describe('resolveRelease — reveal mode', () => {
  it('opens the band rather than firing', () => {
    expect(resolveRelease(g(ACTIVATION_THRESHOLD + 1), reveal(), null)).toEqual({
      kind: 'open',
      side: 'right',
    });
    expect(resolveRelease(g(-ACTIVATION_THRESHOLD - 1), reveal(), null)).toEqual({
      kind: 'open',
      side: 'left',
    });
  });

  it('closes when the drag stops short', () => {
    expect(resolveRelease(g(ACTIVATION_THRESHOLD - 1), reveal(), null)).toEqual({ kind: 'close' });
  });

  it('measures from the open position, so a small drag keeps it open', () => {
    // Open to the right, nudged 5px further right: still well past the threshold.
    expect(resolveRelease(g(5), reveal(), 'right')).toEqual({ kind: 'open', side: 'right' });
    // Dragged back past the resting point: closes.
    expect(resolveRelease(g(-REVEAL_WIDTH), reveal(), 'right')).toEqual({ kind: 'close' });
  });

  it("closes instead of opening a side whose action is 'none'", () => {
    const config = reveal({ rightAction: 'none' });
    expect(resolveRelease(g(999), config, null)).toEqual({ kind: 'close' });
  });
});

describe('restingOffset', () => {
  it('maps the open side to the row translation it sits at', () => {
    expect(restingOffset('right')).toBe(REVEAL_WIDTH);
    expect(restingOffset('left')).toBe(-REVEAL_WIDTH);
    expect(restingOffset(null)).toBe(0);
  });
});

describe('exitsRow', () => {
  it('flags the actions that remove the row from the list', () => {
    expect((['archive', 'delete', 'spam', 'move'] as const).every(exitsRow)).toBe(true);
  });

  it('keeps toggle actions in place', () => {
    expect((['read', 'star', 'pin', 'none'] as const).some(exitsRow)).toBe(false);
  });
});

describe('releaseWouldAct', () => {
  it('arms an instant swipe once the row is past the commit distance on a side with an action', () => {
    expect(releaseWouldAct(COMMIT_THRESHOLD - 1, instant(), null)).toBe(false);
    expect(releaseWouldAct(COMMIT_THRESHOLD, instant(), null)).toBe(true);
    expect(releaseWouldAct(-COMMIT_THRESHOLD, instant(), null)).toBe(true);
    expect(releaseWouldAct(COMMIT_THRESHOLD, instant({ rightAction: 'none' }), null)).toBe(false);
  });

  it('arms a reveal swipe once the row is past the activation distance', () => {
    expect(releaseWouldAct(ACTIVATION_THRESHOLD + 1, reveal(), null)).toBe(true);
    expect(releaseWouldAct(ACTIVATION_THRESHOLD - 1, reveal(), null)).toBe(false);
  });
});

describe('flyDuration', () => {
  it('lets a fast flick leave the row at the speed it was thrown', () => {
    expect(flyDuration(300, 3)).toBeCloseTo(200);
    expect(flyDuration(300, -3)).toBeCloseTo(200);
  });

  it('keeps a slow release from crawling off and a hard flick from vanishing', () => {
    expect(flyDuration(300, 0)).toBe(FLY_MAX_MS);
    expect(flyDuration(300, 50)).toBe(FLY_MIN_MS);
  });
});
