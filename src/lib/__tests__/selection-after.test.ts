import { describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/toast-store', () => ({ toast: { error: vi.fn() } }));

import { selectionAfterFailure, selectionWithout, settled } from '../selection-after';

describe('selectionWithout', () => {
  it('removes exactly the acted-on ids and keeps the rest', () => {
    expect([...selectionWithout(new Set(['a', 'b', 'c']), new Set(['a', 'b']))]).toEqual(['c']);
  });
});

describe('selectionAfterFailure', () => {
  const acted = new Set(['a', 'b']);
  it('puts the acted-on ids back', () => {
    expect([...selectionAfterFailure(new Set(), acted, new Set(['a', 'b']))].sort()).toEqual(['a', 'b']);
  });
  it('keeps what the user selected meanwhile', () => {
    expect([...selectionAfterFailure(new Set(['z']), acted, new Set(['a', 'b', 'z']))].sort()).toEqual(['a', 'b', 'z']);
  });
  it('does not re-add an id that has left the list', () => {
    expect([...selectionAfterFailure(new Set(), acted, new Set(['a']))]).toEqual(['a']);
  });
  it('does not re-select an id the user deselected that was not acted on', () => {
    expect([...selectionAfterFailure(new Set(), new Set(['a']), new Set(['a', 'c']))]).toEqual(['a']);
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
