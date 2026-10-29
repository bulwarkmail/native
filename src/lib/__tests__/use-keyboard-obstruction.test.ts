import { describe, it, expect, vi, beforeEach } from 'vitest';

type Listener = (e: unknown) => void;
const keyboardListeners = new Map<string, Listener>();
let dimsListener: ((e: { window: { width: number; height: number } }) => void) | null = null;
let keyboardVisible = false;
let screen = { width: 400, height: 900 };

vi.mock('react-native', () => ({
  Dimensions: {
    get: () => screen,
    addEventListener: (_: string, fn: typeof dimsListener) => {
      dimsListener = fn;
      return { remove() {} };
    },
  },
  Keyboard: {
    addListener: (name: string, fn: Listener) => {
      keyboardListeners.set(name, fn);
      return { remove() {} };
    },
    isVisible: () => keyboardVisible,
    dismiss: vi.fn(() => { keyboardVisible = false; }),
  },
  Platform: { OS: 'android' },
}));

// Just enough React to run the hook once: state goes to `obstruction`.
let obstruction = 0;
vi.mock('react', () => ({
  default: {
    useState: (initial: number) => [initial, (v: number) => { obstruction = v; }],
    useRef: <T,>(v: T) => ({ current: v }),
    useEffect: (fn: () => void) => { fn(); },
  },
}));

import { Keyboard } from 'react-native';
import { keyboardObstruction, useKeyboardObstruction } from '../use-keyboard-obstruction';

beforeEach(() => {
  keyboardListeners.clear();
  dimsListener = null;
  keyboardVisible = false;
  screen = { width: 400, height: 900 };
  obstruction = 0;
  vi.clearAllMocks();
});

describe('keyboardObstruction', () => {
  it('measures from the keyboard top to the screen bottom (gesture bar included)', () => {
    // Keyboard 300 tall, reported without the 24 dp gesture bar.
    expect(keyboardObstruction(900, 576, 300, 24)).toBe(324);
  });

  it('never covers more than the keyboard and the bottom inset', () => {
    expect(keyboardObstruction(900, 100, 260, 24)).toBe(284);
  });

  it('is zero when the keyboard top is below the screen', () => {
    expect(keyboardObstruction(411, 600, 260, 0)).toBe(0);
  });

  it('falls back to whichever value is known', () => {
    expect(keyboardObstruction(900, undefined, 280, 24)).toBe(280);
    expect(keyboardObstruction(900, 600, undefined, 24)).toBe(300);
    expect(keyboardObstruction(900, undefined, undefined, 24)).toBe(0);
  });
});

describe('useKeyboardObstruction', () => {
  it('follows the keyboard events', () => {
    useKeyboardObstruction(24);
    keyboardVisible = true;
    keyboardListeners.get('keyboardDidShow')!({ endCoordinates: { screenY: 576, height: 300 } });
    expect(obstruction).toBe(324);
    keyboardListeners.get('keyboardDidHide')!({});
    expect(obstruction).toBe(0);
  });

  it('closes the keyboard and drops the stale overlap when the window rotates', () => {
    const onWindowChange = vi.fn();
    useKeyboardObstruction(24, onWindowChange);
    keyboardVisible = true;
    keyboardListeners.get('keyboardDidShow')!({ endCoordinates: { screenY: 576, height: 300 } });
    expect(obstruction).toBe(324);

    // Rotated: Android sends no keyboard event, only the new window size.
    screen = { width: 900, height: 400 };
    dimsListener!({ window: { width: 900, height: 400 } });

    expect(obstruction).toBe(0);
    expect(Keyboard.dismiss).toHaveBeenCalledTimes(1);
    expect(onWindowChange).toHaveBeenCalledTimes(1);
  });

  it('leaves a closed keyboard alone on a window change', () => {
    const onWindowChange = vi.fn();
    useKeyboardObstruction(24, onWindowChange);
    dimsListener!({ window: { width: 900, height: 400 } });
    expect(Keyboard.dismiss).not.toHaveBeenCalled();
    expect(onWindowChange).not.toHaveBeenCalled();
  });
});
