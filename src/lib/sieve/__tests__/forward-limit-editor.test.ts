import { describe, expect, it } from 'vitest';
import type { FilterAction, FilterRule, VacationForward } from '../types';
import { forwardsOfEditedRule, ruleForwardLimit, rulesForwardLimit } from '../forward-limit';

const forward: FilterAction = { type: 'forward', value: 'x@example.com' };
const rule = (id: string, actions: FilterAction[], extra: Partial<FilterRule> = {}): FilterRule => ({
  id,
  name: id,
  enabled: true,
  matchType: 'all',
  conditions: [{ field: 'from', comparator: 'contains', value: 'a' }],
  actions,
  stopProcessing: false,
  ...extra,
});
const deputy: VacationForward = { enabled: true, to: 'deputy@example.com', keepCopy: true } as VacationForward;

describe('ruleForwardLimit', () => {
  it('warns when one message would collect more forwards than the server runs (Stalwart: 1)', () => {
    const state = ruleForwardLimit({ actions: [forward], stopProcessing: false }, 1, { before: 1, after: 0 });
    expect(state).toEqual({ limit: 1, overLimit: true, unavailable: false, canAddForward: false });
  });

  it('lets a rule that stops ignore the forwards below it', () => {
    expect(ruleForwardLimit({ actions: [forward], stopProcessing: true }, 1, { before: 0, after: 3 }).overLimit).toBe(false);
    expect(ruleForwardLimit({ actions: [forward], stopProcessing: false }, 1, { before: 0, after: 3 }).overLimit).toBe(true);
  });

  it('offers a forward while there is room and none on a server without forwarding', () => {
    expect(ruleForwardLimit({ actions: [{ type: 'move', value: 'A' }], stopProcessing: false }, 1, { before: 0, after: 0 }).canAddForward).toBe(true);
    const off = ruleForwardLimit({ actions: [forward], stopProcessing: false }, 0, { before: 0, after: 0 });
    expect(off).toMatchObject({ limit: null, overLimit: false, unavailable: true, canAddForward: false });
  });

  it('says nothing without a cap from the server', () => {
    expect(ruleForwardLimit({ actions: [forward, forward], stopProcessing: false }, undefined, { before: 5, after: 5 }))
      .toEqual({ limit: null, overLimit: false, unavailable: false, canAddForward: true });
  });
});

describe('forwardsOfEditedRule', () => {
  const rules = [rule('a', [forward]), rule('b', [{ type: 'move', value: 'A' }]), rule('ext', [forward], { origin: 'external' })];

  it('counts the forwards above and below the edited rule, the out of office forwarding first', () => {
    expect(forwardsOfEditedRule(rules, deputy, 'b')).toEqual({ before: 2, after: 1 });
    expect(forwardsOfEditedRule(rules, null, 'a')).toEqual({ before: 0, after: 1 });
  });

  it('puts a new rule below Bulwark\'s own rules, above the external ones', () => {
    expect(forwardsOfEditedRule(rules, null, undefined)).toEqual({ before: 1, after: 1 });
  });
});

describe('rulesForwardLimit', () => {
  it('flags rules whose forwards add up past the cap, and forwards a server ignores', () => {
    const rules = [rule('a', [forward]), rule('b', [forward])];
    expect(rulesForwardLimit(rules, null, 1)).toEqual({ tooMany: true, ignored: false });
    expect(rulesForwardLimit(rules, null, 2)).toEqual({ tooMany: false, ignored: false });
    expect(rulesForwardLimit([rules[0]], deputy, 1)).toEqual({ tooMany: true, ignored: false });
    expect(rulesForwardLimit(rules, null, 0)).toEqual({ tooMany: false, ignored: true });
  });
});
