import { describe, it, expect, vi, beforeEach } from 'vitest';

const handlers: Array<() => boolean> = [];
const remove = vi.fn();

vi.mock('react-native', () => ({
  BackHandler: {
    addEventListener: vi.fn((_event: string, handler: () => boolean) => {
      handlers.push(handler);
      return { remove };
    }),
  },
}));

// Run the focus effect as if the screen had just gained focus and keep its
// cleanup, which react-navigation calls on blur.
let blur: void | (() => void);
vi.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void | (() => void)) => {
    blur = effect();
  },
}));

vi.mock('react', () => ({ useCallback: <T,>(fn: T) => fn }));

import { BackHandler } from 'react-native';
import { useBackWhileFocused } from '../use-back-while-focused';

beforeEach(() => {
  vi.clearAllMocks();
  handlers.length = 0;
  blur = undefined;
});

describe('useBackWhileFocused', () => {
  it('runs onBack and consumes the back press while active', () => {
    const onBack = vi.fn();
    useBackWhileFocused(true, onBack);

    expect(BackHandler.addEventListener).toHaveBeenCalledWith('hardwareBackPress', expect.any(Function));
    expect(handlers[0]()).toBe(true);
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('leaves the back press to navigation while inactive', () => {
    useBackWhileFocused(false, vi.fn());

    expect(BackHandler.addEventListener).not.toHaveBeenCalled();
  });

  it('stops listening when the screen loses focus', () => {
    useBackWhileFocused(true, vi.fn());

    expect(typeof blur).toBe('function');
    (blur as () => void)();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});
