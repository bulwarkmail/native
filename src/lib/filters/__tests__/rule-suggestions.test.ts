import { describe, it, expect } from 'vitest';
import type { FilterRule } from '../../sieve/types';
import type { RuleSuggestion } from '../quick-rules';
import { applySuggestion } from '../rule-suggestions';

const rule = (conditions: FilterRule['conditions']): FilterRule => ({
  id: 'r1', name: 'n', enabled: true, matchType: 'all', conditions,
  actions: [{ type: 'mark_read' }], stopProcessing: false,
});

const subject: RuleSuggestion = {
  id: 'subject', label: 's', condition: { field: 'subject', comparator: 'contains', value: 'Invoice' },
};
const to: RuleSuggestion = {
  id: 'to', label: 't', condition: { field: 'to', comparator: 'address_is', value: 'me@x.org' },
};
const cc: RuleSuggestion = {
  id: 'to', label: 'c', condition: { field: 'cc', comparator: 'address_is', value: 'me@x.org' },
};
const list: RuleSuggestion = {
  id: 'list', label: 'l', condition: { field: 'header', headerName: 'List-Id', comparator: 'contains', value: '<a.b>' },
};
const domain: RuleSuggestion = {
  id: 'domain', label: 'd',
  condition: { field: 'from', comparator: 'address_is', value: '*@x.org' },
  replaces: (c) => c.field === 'from' && c.comparator === 'address_is',
};
const sender = { field: 'from', comparator: 'address_is', value: 'a@x.org' } as const;

describe('applySuggestion', () => {
  it('adds subject, to, cc and list conditions after the existing ones', () => {
    for (const s of [subject, to, cc, list]) {
      expect(applySuggestion(rule([sender]), s).conditions).toEqual([sender, s.condition]);
    }
  });

  it('replaces the blank row a new rule starts with', () => {
    const blank = { field: 'from', comparator: 'contains', value: '' } as const;
    expect(applySuggestion(rule([blank]), subject).conditions).toEqual([subject.condition]);
  });

  it('keeps a value-less condition', () => {
    const all = { field: 'all', comparator: 'contains', value: '' } as const;
    expect(applySuggestion(rule([all]), subject).conditions).toEqual([all, subject.condition]);
  });

  it('puts the domain chip in place of the sender condition', () => {
    const other = { field: 'subject', comparator: 'contains', value: 'x' } as const;
    expect(applySuggestion(rule([other, sender]), domain).conditions).toEqual([other, domain.condition]);
  });

  it('adds the domain chip when there is no sender condition to replace', () => {
    expect(applySuggestion(rule([subject.condition]), domain).conditions).toEqual([subject.condition, domain.condition]);
  });

  it('is a no-op the second time', () => {
    for (const s of [subject, to, list, domain]) {
      const once = applySuggestion(rule([sender]), s);
      expect(applySuggestion(once, s)).toEqual(once);
      expect(applySuggestion(once, s).conditions).toHaveLength(once.conditions.length);
    }
  });

  it('does not mutate its input', () => {
    const r = rule([sender]);
    applySuggestion(r, domain);
    expect(r.conditions).toEqual([sender]);
  });
});
