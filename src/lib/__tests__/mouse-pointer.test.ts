import { describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ rehover: vi.fn() }));
vi.mock('react-native', () => ({ NativeModules: { BulwarkPointer: native } }));

import { mouseSeen, noteMouse, rehover, subscribeMouseSeen } from '../mouse-pointer';

describe('mouse pointer', () => {
  it('has seen no mouse until one is noted, and says so once', () => {
    const listener = vi.fn();
    const off = subscribeMouseSeen(listener);
    expect(mouseSeen()).toBe(false);
    noteMouse();
    noteMouse();
    expect(mouseSeen()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    off();
  });

  it('passes rehover on to the native side', () => {
    rehover();
    expect(native.rehover).toHaveBeenCalledTimes(1);
  });
});
