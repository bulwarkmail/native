import { describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/toast-store', () => ({ toast: { error: vi.fn() } }));

import { selectionAfter, settled } from '../selection-after';

describe('selectionAfter', () => {
  const ids = new Set(['a', 'b']);
  it('clears the selection when the action succeeded', () => {
    expect(selectionAfter(true, ids).size).toBe(0);
  });
  it('keeps the same ids when the action failed', () => {
    expect(selectionAfter(false, ids)).toBe(ids);
  });
});

describe('settled', () => {
  it('is true for a resolved action, including a queued one and an undefined result', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await settled(Promise.resolve({ queued: true }), 'Failed')).toBe(true);
    expect(await settled(Promise.resolve(undefined), 'Failed')).toBe(true);
  });
  it('is false for a rejected action, which is reported once', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { toast } = await import('../../stores/toast-store');
    expect(await settled(Promise.reject(new Error('x')), 'Failed')).toBe(false);
    expect(toast.error).toHaveBeenCalledWith('Failed', 'x');
  });
});
