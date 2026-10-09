import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAfterDismiss } from '../after-dismiss';

afterEach(() => {
  vi.useRealTimers();
});

describe('createAfterDismiss', () => {
  it('opens the share sheet on dismiss, or after the timeout when dismiss never comes, once', () => {
    vi.useFakeTimers(); const open = vi.fn(); const d = createAfterDismiss(open, 700);
    d.arm('f1'); vi.advanceTimersByTime(700); d.dismissed();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('f1');
  });

  it('opens on dismiss and the timer then does nothing', () => {
    vi.useFakeTimers(); const open = vi.fn(); const d = createAfterDismiss(open, 700);
    d.arm('f1'); vi.advanceTimersByTime(100); d.dismissed();
    expect(open).toHaveBeenCalledWith('f1');
    vi.advanceTimersByTime(1000);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('opens nothing when not armed, or once cancelled', () => {
    vi.useFakeTimers(); const open = vi.fn(); const d = createAfterDismiss(open, 700);
    d.dismissed();
    d.arm('f1'); d.cancel(); vi.advanceTimersByTime(1000); d.dismissed();
    expect(open).not.toHaveBeenCalled();
  });

  it('re-arming replaces the earlier target', () => {
    vi.useFakeTimers(); const open = vi.fn(); const d = createAfterDismiss(open, 700);
    d.arm('f1'); d.arm('f2'); vi.advanceTimersByTime(700);
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith('f2');
  });
});
