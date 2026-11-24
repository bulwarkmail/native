import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  fingerTravel,
  panTravel,
  decidePanActivation,
  nextArmedState,
  dragOffset,
  resolveRelease,
  armChange,
  releaseHaptic,
  SETTLE_SPRING,
  flyPlan,
  flyProgress,
  FLY_MIN_MS,
  FLY_MAX_MS,
  CLAIM_DX,
  COMMIT_THRESHOLD,
  DISARM_THRESHOLD,
  REVEAL_WIDTH,
  type SwipeConfig,
} from '../swipe-gesture';

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

const instant = (over: Partial<SwipeConfig> = {}): SwipeConfig => ({
  mode: 'instant',
  leftAction: 'delete',
  rightAction: 'archive',
  ...over,
});
const reveal = (over: Partial<SwipeConfig> = {}): SwipeConfig => instant({ mode: 'reveal', ...over });
const g = (dx: number, vx = 0) => ({ dx, dy: 0, vx });

describe('the row starts where the finger claimed it', () => {
  it('does not jump by the distance it took to recognise the swipe', () => {
    expect(fingerTravel(CLAIM_DX)).toBe(0);
    expect(fingerTravel(-CLAIM_DX)).toBe(0);
  });

  it('then moves exactly as far as the finger does', () => {
    expect(fingerTravel(CLAIM_DX + 20)).toBe(20);
    expect(fingerTravel(-CLAIM_DX - 20)).toBe(-20);
    expect(fingerTravel(CLAIM_DX + 21) - fingerTravel(CLAIM_DX + 20)).toBe(1);
  });

  it('tracks a shaky reversal smoothly across zero without a sticky dead zone', () => {
    const claimX = 100 + CLAIM_DX;
    expect(panTravel(claimX, claimX, true, CLAIM_DX)).toBe(0);
    expect(panTravel(claimX + 30, claimX, true, CLAIM_DX + 30)).toBe(30);
    expect(panTravel(claimX - 4, claimX, true, CLAIM_DX - 4)).toBe(-4);
    expect(panTravel(claimX - 12, claimX, true, CLAIM_DX - 12)).toBe(-12);
  });
});

describe('scroll vs swipe balance handles diagonal and shaky thumbs cleanly', () => {
  it('claims horizontal and natural diagonal thumb swipes instead of scrolling', () => {
    expect(decidePanActivation(CLAIM_DX, 0, instant(), null)).toBe('activate');
    expect(decidePanActivation(-CLAIM_DX, 0, instant(), null)).toBe('activate');
    expect(decidePanActivation(12, 8, instant(), null)).toBe('activate');
    expect(decidePanActivation(22, 14, instant(), null)).toBe('activate');
    expect(decidePanActivation(-20, -12, instant(), null)).toBe('activate');
  });

  it('fails promptly to vertical scroll when vertical movement dominates', () => {
    expect(decidePanActivation(0, 10, instant(), null)).toBe('fail');
    expect(decidePanActivation(5, 11, instant(), null)).toBe('fail');
    expect(decidePanActivation(10, 14, instant(), null)).toBe('fail');
    expect(decidePanActivation(14, 24, instant(), null)).toBe('fail');
  });

  it('waits on tiny resting jitter so taps do not misfire', () => {
    expect(decidePanActivation(4, 3, instant(), null)).toBe('wait');
    expect(decidePanActivation(-6, 7, instant(), null)).toBe('wait');
  });

  it('declines horizontal drags toward a disabled side unless closing an open reveal band', () => {
    expect(decidePanActivation(12, 0, instant({ rightAction: 'none' }), null)).toBe('fail');
    expect(decidePanActivation(-12, 0, reveal({ leftAction: 'none' }), 'right')).toBe('activate');
  });
});

describe('shaky cursor stability around the commit line', () => {
  it('keeps an armed swipe steady when shaking slightly back across the commit threshold', () => {
    expect(nextArmedState(COMMIT_THRESHOLD, false, instant(), null)).toBe(true);
    expect(nextArmedState(COMMIT_THRESHOLD - 6, true, instant(), null)).toBe(true);
    expect(nextArmedState(DISARM_THRESHOLD, true, instant(), null)).toBe(true);
    expect(nextArmedState(DISARM_THRESHOLD - 1, true, instant(), null)).toBe(false);
    expect(nextArmedState(COMMIT_THRESHOLD - 6, false, instant(), null)).toBe(false);
    expect(nextArmedState(-COMMIT_THRESHOLD, false, instant(), null)).toBe(true);
    expect(nextArmedState(-DISARM_THRESHOLD, true, instant(), null)).toBe(true);
    expect(nextArmedState(-(DISARM_THRESHOLD - 1), true, instant(), null)).toBe(false);
  });

  it('commits a shaky lift-off once armed instead of aborting on minor hand tremor', () => {
    expect(resolveRelease(g(COMMIT_THRESHOLD + 6, -0.2), instant(), null, true)).toMatchObject({ kind: 'fire', direction: 1 });
    expect(resolveRelease(g(DISARM_THRESHOLD + 4, 0), instant(), null, true)).toMatchObject({ kind: 'fire', direction: 1 });
    expect(resolveRelease(g(COMMIT_THRESHOLD + 20, -1), instant(), null, true)).toEqual({ kind: 'settle' });
    expect(resolveRelease(g(DISARM_THRESHOLD + 4, 0), instant(), null, false)).toEqual({ kind: 'settle' });
  });
});

describe('the row never hits a wall', () => {
  it('follows the finger one to one across the whole screen in instant mode', () => {
    for (const dx of [100, 240, 241, 300, 390]) {
      expect(dragOffset(g(dx), instant(), null)).toBe(dx);
      expect(dragOffset(g(-dx), instant(), null)).toBe(-dx);
    }
  });

  it('continues from where a still-moving row was caught', () => {
    expect(dragOffset(g(10), instant(), null, 50)).toBe(60);
  });

  it('stretches with growing resistance past the open band in reveal mode', () => {
    const at = (dx: number) => dragOffset(g(dx), reveal(), null);
    expect(at(REVEAL_WIDTH)).toBe(REVEAL_WIDTH);
    const a = at(REVEAL_WIDTH + 40);
    const b = at(REVEAL_WIDTH + 80);
    const c = at(REVEAL_WIDTH + 400);
    expect(a).toBeGreaterThan(REVEAL_WIDTH);
    expect(a).toBeLessThan(REVEAL_WIDTH + 40);
    expect(b).toBeGreaterThan(a);
    expect(b - a).toBeLessThan(a - REVEAL_WIDTH);
    expect(c).toBeLessThan(REVEAL_WIDTH * 2);
    expect(at(-(REVEAL_WIDTH + 40))).toBeCloseTo(-a);
  });

  it('only nudges toward a side without an action when an open row is dragged past rest', () => {
    const config = reveal({ leftAction: 'none' });
    const past = dragOffset(g(-REVEAL_WIDTH - 60), config, 'right');
    expect(past).toBeLessThan(0);
    expect(past).toBeGreaterThan(-30);
  });
});

describe('letting go does what the hand meant', () => {
  it('cancels when a row dragged past the line is flicked back', () => {
    expect(resolveRelease(g(COMMIT_THRESHOLD + 20, -1), instant(), null)).toEqual({ kind: 'settle' });
    expect(resolveRelease(g(-COMMIT_THRESHOLD - 20, 1), instant(), null)).toEqual({ kind: 'settle' });
  });

  it('still commits a row held past the line and released slowly', () => {
    expect(resolveRelease(g(COMMIT_THRESHOLD + 20, -0.05), instant(), null)).toMatchObject({ kind: 'fire', direction: 1 });
  });

  it('commits a short fast flick', () => {
    expect(resolveRelease(g(30, 1), instant(), null)).toMatchObject({ kind: 'fire', action: 'archive' });
    expect(resolveRelease(g(-30, -1), instant(), null)).toMatchObject({ kind: 'fire', action: 'delete' });
  });

  it('ignores a tiny twitch however fast it is', () => {
    expect(resolveRelease(g(12, 3), instant(), null)).toEqual({ kind: 'settle' });
  });

  it('opens a reveal band with a flick and closes an open one with a flick back', () => {
    expect(resolveRelease(g(16, 0.6), reveal(), null)).toEqual({ kind: 'open', side: 'right' });
    expect(resolveRelease(g(-24, -0.8), reveal(), 'right')).toEqual({ kind: 'close' });
  });

  it('never flings an open band over to the other side', () => {
    expect(resolveRelease(g(-30, -3), reveal(), 'right')).toEqual({ kind: 'close' });
  });
});

describe('the hand feels the line, once each way', () => {
  it('ticks when the row crosses into arming and again when it backs out', () => {
    expect(armChange(false, true)).toBe('arm');
    expect(armChange(true, false)).toBe('disarm');
    expect(armChange(true, true)).toBeNull();
    expect(armChange(false, false)).toBeNull();
  });

  it('does not buzz a second time when an armed row is released', () => {
    expect(releaseHaptic({ kind: 'fire', action: 'archive', direction: 1 }, true)).toBeNull();
  });

  it('ticks on release when a flick commits a row that was never armed', () => {
    expect(releaseHaptic({ kind: 'fire', action: 'archive', direction: 1 }, false)).toBe('selection');
  });

  it('stays quiet when the row springs back', () => {
    expect(releaseHaptic({ kind: 'settle' }, false)).toBeNull();
  });
});

describe('the row leaves at the speed the finger let go', () => {
  const startSpeed = (distance: number, velocity: number) => {
    const plan = flyPlan(distance, velocity);
    const h = 1e-4;
    return (Math.abs(distance) * flyProgress(plan.startSlope, h)) / (h * plan.duration);
  };

  it('starts the fly-off at exactly the release speed, slow or fast', () => {
    for (const v of [0.1, 0.4, 0.8, 1.5, 2.5]) {
      expect(startSpeed(300, v)).toBeCloseTo(v, 2);
      expect(startSpeed(-300, -v)).toBeCloseTo(v, 2);
    }
  });

  it('eases a row released at rest off the screen from a standstill', () => {
    expect(flyPlan(300, 0).startSlope).toBe(0);
    expect(flyPlan(300, -0.2).startSlope).toBe(0);
  });

  it('gets a hard flick off sooner, within bounds', () => {
    expect(flyPlan(300, 0.2).duration).toBe(FLY_MAX_MS);
    expect(flyPlan(300, 4).duration).toBeLessThan(FLY_MAX_MS);
    expect(flyPlan(300, 50).duration).toBe(FLY_MIN_MS);
  });

  it('only ever moves forward and ends exactly off screen', () => {
    for (const v of [0, 0.5, 1, 2, 50]) {
      const { startSlope } = flyPlan(300, v);
      let prev = 0;
      for (let u = 0.01; u <= 1.0001; u += 0.01) {
        const x = flyProgress(startSlope, Math.min(u, 1));
        expect(x).toBeGreaterThanOrEqual(prev - 1e-9);
        prev = x;
      }
      expect(flyProgress(startSlope, 1)).toBeCloseTo(1, 9);
    }
  });
});

describe('the row comes to rest without wobbling', () => {
  it('springs back critically damped, carrying the release speed instead of snapping to rest', () => {
    const critical = 2 * Math.sqrt(SETTLE_SPRING.stiffness * SETTLE_SPRING.mass);
    expect(SETTLE_SPRING.damping).toBeCloseTo(critical, 5);
    expect('overshootClamping' in SETTLE_SPRING).toBe(false);
  });

  it('is back within a pixel of rest in a fifth of a second, even after an outward flick', () => {
    const omega = Math.sqrt(SETTLE_SPRING.stiffness / SETTLE_SPRING.mass);
    const at = (x0: number, v0: number, t: number) => (x0 + (v0 + omega * x0) * t) * Math.exp(-omega * t);
    expect(Math.abs(at(50, 0, 0.2))).toBeLessThan(1);
    expect(Math.abs(at(50, 800, 0.22))).toBeLessThan(1);
  });

  it('hides the band in the last pixel of the way back instead of leaving a sliver at the edge', () => {
    expect(read('components/SwipeableRow.tsx')).toMatch(/opacity: Math\.abs\(tx\.value\) < FILL_MIN_DP \? 0 : 1/);
  });
});

describe('row wiring', () => {
  const row = read('components/SwipeableRow.tsx');

  it('has the band colour behind the row from the first pixel of a swipe, without waiting for a render', () => {
    expect(row).toMatch(/^\s*\{hasFill \? <Animated\.View pointerEvents="none" style=\{\[StyleSheet\.absoluteFill, fillStyle\]\} \/> : null\}/m);
    expect(row).toMatch(/const hasFill = mode !== 'reveal' && \(leftAction !== 'none' \|\| rightAction !== 'none'\)/);
  });

  it('lays the action bands out on touch-down, before the swipe is recognised', () => {
    expect(row).toMatch(/\.onBegin\(\(\) => \{[\s\S]*?runOnJS\(prepare\)\(\)/);
  });

  it('catches a moving row where it is instead of snapping it back first', () => {
    expect(row).toMatch(/cancelAnimation\(tx\)/);
  });

  it('cannot be grabbed again while it is flying off', () => {
    expect(row).toMatch(/\.enabled\(!leaving\)/);
  });

  it('shows the threshold: muted band and resting icon until armed, full colour and a popping icon after', () => {
    expect(row).toMatch(/interpolateColor\(/);
    expect(row).toMatch(/armedProgress/);
  });

  it('delays the tap highlight so a swipe or scroll start does not flash the row', () => {
    expect(read('screens/EmailListScreen.tsx')).toMatch(/unstable_pressDelay=\{ROW_PRESS_DELAY_MS\}/);
  });
});

describe('Android haptics', () => {
  it('use the platform haptic constants, not the vibrator', () => {
    const src = read('lib/haptics.ts');
    expect(src).toMatch(/performAndroidHapticsAsync/);
    expect(src).toMatch(/AndroidHaptics\.Clock_Tick/);
  });
});
