import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runWhileAccountShown, type ShownAccountSource } from '../account-bound-timer';

// R16: the viewer's delayed mark-read of A's message must not fire after a
// notification tap switched the app to B, whose message with the same id is
// another one.

function source(initial: string | null) {
  let state = { activeAccountId: initial };
  const listeners = new Set<(s: { activeAccountId: string | null }) => void>();
  const src: ShownAccountSource = {
    getState: () => state,
    subscribe: (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
  };
  return {
    src,
    listeners,
    show(id: string | null) { state = { activeAccountId: id }; for (const l of [...listeners]) l(state); },
  };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('runWhileAccountShown', () => {
  it('runs after the delay while the account stays shown', () => {
    const s = source('A');
    const run = vi.fn();
    runWhileAccountShown(s.src, 'A', 3000, run);
    vi.advanceTimersByTime(2999);
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(s.listeners.size).toBe(0);
  });

  it('is cancelled when the app shows another account, and does not come back with it', () => {
    const s = source('A');
    const run = vi.fn();
    runWhileAccountShown(s.src, 'A', 3000, run);
    s.show('B');
    s.show('A');
    vi.advanceTimersByTime(10_000);
    expect(run).not.toHaveBeenCalled();
    expect(s.listeners.size).toBe(0);
  });

  it('does not run when another account is shown when it fires', () => {
    // A store change that reached no listener (the check at fire time).
    const s = source('A');
    const run = vi.fn();
    runWhileAccountShown(s.src, 'A', 3000, run);
    (s.src.getState() as { activeAccountId: string | null }).activeAccountId = 'B';
    vi.advanceTimersByTime(3000);
    expect(run).not.toHaveBeenCalled();
  });

  it('runs at once with no delay, only while the account is shown', () => {
    const run = vi.fn();
    runWhileAccountShown(source('A').src, 'A', 0, run);
    expect(run).toHaveBeenCalledTimes(1);
    runWhileAccountShown(source('B').src, 'A', 0, run);
    runWhileAccountShown(source('A').src, undefined, 0, run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('cancels on request', () => {
    const s = source('A');
    const run = vi.fn();
    const cancel = runWhileAccountShown(s.src, 'A', 3000, run);
    cancel();
    vi.advanceTimersByTime(3000);
    expect(run).not.toHaveBeenCalled();
    expect(s.listeners.size).toBe(0);
  });
});
