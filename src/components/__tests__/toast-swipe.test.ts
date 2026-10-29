import { describe, it, expect } from 'vitest';
import { shouldClaimToastSwipe, toastSwipeRelease } from '../toast-swipe';

const g = (dx: number, dy = 0, vx = 0) => ({ dx, dy, vx });

describe('shouldClaimToastSwipe', () => {
  it('takes sideways drags in either direction', () => {
    expect(shouldClaimToastSwipe(g(10))).toBe(true);
    expect(shouldClaimToastSwipe(g(-10, 4))).toBe(true);
  });

  it('leaves taps, jitter and vertical moves alone', () => {
    expect(shouldClaimToastSwipe(g(3))).toBe(false);
    expect(shouldClaimToastSwipe(g(10, 10))).toBe(false);
    expect(shouldClaimToastSwipe(g(0, 30))).toBe(false);
  });
});

describe('toastSwipeRelease', () => {
  it('dismisses past 35% of the card, towards the drag', () => {
    expect(toastSwipeRelease(g(120), 300)).toBe(1);
    expect(toastSwipeRelease(g(-110), 300)).toBe(-1);
    expect(toastSwipeRelease(g(100), 300)).toBe(0);
  });

  it('caps the distance on wide cards', () => {
    expect(toastSwipeRelease(g(125), 800)).toBe(1);
    expect(toastSwipeRelease(g(115), 800)).toBe(0);
  });

  it('dismisses a short flick', () => {
    expect(toastSwipeRelease(g(40, 0, 0.8), 300)).toBe(1);
    expect(toastSwipeRelease(g(-40, 0, -0.8), 300)).toBe(-1);
    // A flick against the drag does not count.
    expect(toastSwipeRelease(g(40, 0, -0.8), 300)).toBe(0);
    expect(toastSwipeRelease(g(20, 0, 2), 300)).toBe(0);
  });

  it('does not dismiss a small drag before the card has a width', () => {
    expect(toastSwipeRelease(g(20), 0)).toBe(0);
    expect(toastSwipeRelease(g(130), 0)).toBe(1);
  });
});
