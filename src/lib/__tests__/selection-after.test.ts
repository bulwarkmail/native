import { describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/toast-store', () => ({ toast: { error: vi.fn() } }));

import {
  selectionAfterFailure, selectionAfterFailureIn, selectionIn, selectionWithout, settled, updateSelection,
  type AccountSelection,
} from '../selection-after';

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

// M2 (R15): row keys repeat across accounts, so a selection never carries
// into another account, and a failed bulk action does not re-select its keys
// in the account switched to.
describe('a selection belongs to the account it was made in', () => {
  const inA: AccountSelection = { accountId: 'A', ids: new Set(['m1', 'm2']) };

  it('is cleared (selects nothing) once another account is shown', () => {
    expect([...selectionIn(inA, 'A')].sort()).toEqual(['m1', 'm2']);
    expect([...selectionIn(inA, 'B')]).toEqual([]);
  });

  it('an update made while B is shown starts from nothing, not from A\'s ids', () => {
    const next = updateSelection(inA, 'B', (prev) => new Set([...prev, 'm3']));
    expect(next.accountId).toBe('B');
    expect([...next.ids]).toEqual(['m3']);
  });

  it('a failed bulk action puts its ids back only while its account is shown', () => {
    const acted = new Set(['m1', 'm2']);
    const present = new Set(['m1', 'm2', 'm3']);
    const afterSwitch: AccountSelection = { accountId: 'B', ids: new Set() };
    expect(selectionAfterFailureIn(afterSwitch, 'A', 'B', acted, present)).toBe(afterSwitch);
    const same = selectionAfterFailureIn({ accountId: 'A', ids: new Set() }, 'A', 'A', acted, present);
    expect([...same.ids].sort()).toEqual(['m1', 'm2']);
  });
});
