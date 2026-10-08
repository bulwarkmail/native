import { describe, expect, it } from 'vitest';
import type { FilterAction, FilterRule } from '../../sieve/types';
import { forwardsForRule, hasTooManyForwards, modalForwardState, redirectLimitOf } from '../forward-limit-view';

const fwd: FilterAction = { type: 'forward', value: 'x@example.com' };
const rule = (id: string, actions: FilterAction[], stopProcessing = false): FilterRule => ({
  id, name: id, enabled: true, matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: 'a' }], actions, stopProcessing,
});

describe('forward limit view', () => {
  it('reads only a positive limit', () => {
    expect(redirectLimitOf(1)).toBe(1);
    expect(redirectLimitOf(0)).toBeNull();
    expect(redirectLimitOf(null)).toBeNull();
    expect(redirectLimitOf(undefined)).toBeNull();
  });

  it('flags too many forwards, counting the vacation forward', () => {
    const rules = [rule('a', [fwd])];
    expect(hasTooManyForwards(rules, null, 1)).toBe(false);
    expect(hasTooManyForwards(rules, null, undefined)).toBe(false);
    expect(hasTooManyForwards([...rules, rule('b', [fwd])], null, 1)).toBe(true);
    expect(hasTooManyForwards(rules, { enabled: true, to: 'o@example.com', keepCopy: true }, 1)).toBe(true);
    expect(hasTooManyForwards(rules, { enabled: true, to: 'o@example.com', keepCopy: false }, 1)).toBe(false);
  });

  it('places an edited rule in place and a new one at newIndex', () => {
    const rules = [rule('a', [fwd]), rule('b', [fwd])];
    expect(forwardsForRule(rules, null, 'a', 0)).toEqual({ before: 0, after: 1 });
    expect(forwardsForRule(rules, null, 'b', 0)).toEqual({ before: 1, after: 0 });
    expect(forwardsForRule(rules, null, undefined, 0)).toEqual({ before: 0, after: 2 });
    expect(forwardsForRule(rules, null, 'gone', 2)).toEqual({ before: 2, after: 0 });
  });

  it('keeps the vacation forward ahead of the rules', () => {
    const rules = [rule('a', [fwd])];
    const vf = { enabled: true, to: 'o@example.com', keepCopy: true };
    expect(forwardsForRule(rules, vf, undefined, 0)).toEqual({ before: 1, after: 1 });
  });

  it('disables the forward option at the limit and warns over it', () => {
    expect(modalForwardState([{ type: 'move', value: '' }], false, 1, 0, 0))
      .toEqual({ limit: 1, overLimit: false, forwardDisabled: false });
    expect(modalForwardState([{ type: 'move', value: '' }], false, 1, 1, 0).forwardDisabled).toBe(true);
    expect(modalForwardState([fwd], false, 1, 1, 0)).toMatchObject({ overLimit: true });
    // A stopping rule is not met by the forwards below it.
    expect(modalForwardState([fwd], true, 1, 0, 3)).toMatchObject({ overLimit: false, forwardDisabled: true });
    expect(modalForwardState([fwd], false, null, 5, 5)).toEqual({ limit: null, overLimit: false, forwardDisabled: false });
  });
});
