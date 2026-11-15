import { describe, it, expect, vi } from 'vitest';

vi.mock('react-native', () => ({ NativeEventEmitter: class {}, NativeModules: {}, Platform: { OS: 'ios' }, useWindowDimensions: () => ({ width: 0, height: 0 }) }));

import { HINGE_CLOSED, TENT_MIN_ANGLE, isTent } from '../device-hinge';

describe('isTent', () => {
  // The outer display turned sideways is 678 x 466 pt.
  const tent = { status: HINGE_CLOSED, angle: 70 };

  it('is a closed hinge at an angle with the outer display sideways', () => {
    expect(isTent(tent, 678, 466)).toBe(true);
    expect(isTent({ ...tent, angle: TENT_MIN_ANGLE }, 678, 466)).toBe(true);
  });

  it('is not a Duo shut or held in the hand', () => {
    expect(isTent({ ...tent, angle: 0 }, 678, 466)).toBe(false);
    expect(isTent({ ...tent, angle: TENT_MIN_ANGLE - 1 }, 678, 466)).toBe(false);
    // Upright on the outer display.
    expect(isTent(tent, 466, 678)).toBe(false);
  });

  it('is not the inner display, half open or flat, nor a phone without a hinge', () => {
    expect(isTent({ status: 2, angle: 100 }, 951, 669)).toBe(false);
    expect(isTent({ status: 3, angle: 180 }, 951, 669)).toBe(false);
    expect(isTent(null, 678, 466)).toBe(false);
  });
});
