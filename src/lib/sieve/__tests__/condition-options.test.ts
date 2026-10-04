import { describe, expect, it } from 'vitest';
import {
  CONDITION_FIELDS,
  comparatorsFor,
  conditionForField,
  conditionsToSave,
} from '../condition-options';
import type { FilterCondition } from '../types';

const ALL: FilterCondition = { field: 'all', comparator: 'any', value: '' };

describe('condition options', () => {
  it('offers All messages last', () => {
    expect(CONDITION_FIELDS[CONDITION_FIELDS.length - 1]).toBe('all');
  });

  it('ends the From/To/Cc comparators with address_is and domain_is', () => {
    for (const f of ['from', 'to', 'cc'] as const) {
      expect(comparatorsFor(f).slice(-2)).toEqual(['address_is', 'domain_is']);
    }
    expect(comparatorsFor('subject')).not.toContain('address_is');
    expect(comparatorsFor('subject')).not.toContain('domain_is');
  });

  it('maps an existing all condition to the any comparator', () => {
    expect(comparatorsFor('all')).toEqual(['any']);
  });

  it('turns a row into the exact all-messages condition', () => {
    const prev: FilterCondition = { field: 'header', headerName: 'X-A', comparator: 'is', value: 'x' };
    expect(conditionForField(prev, 'all')).toEqual(ALL);
  });

  it('resets comparator and value when leaving all', () => {
    expect(conditionForField(ALL, 'from')).toEqual({ field: 'from', comparator: 'contains', value: '' });
  });

  it('keeps a comparator that is valid for the new field', () => {
    const prev: FilterCondition = { field: 'from', comparator: 'address_is', value: 'a@b.c' };
    expect(conditionForField(prev, 'to')).toEqual({ field: 'to', comparator: 'address_is', value: 'a@b.c' });
  });

  it('replaces a comparator the new field lacks and drops headerName', () => {
    const prev: FilterCondition = { field: 'header', headerName: 'X-A', comparator: 'contains', value: 'x' };
    expect(conditionForField(prev, 'size')).toEqual({ field: 'size', comparator: 'greater_than', value: 'x' });
  });

  it('saves a rule that only has an all-messages condition', () => {
    expect(conditionsToSave([ALL])).toEqual([ALL]);
  });

  it('drops empty-valued conditions and splits comma lists', () => {
    const out = conditionsToSave([
      { field: 'from', comparator: 'contains', value: '' },
      { field: 'to', comparator: 'is', value: 'a, b' },
    ]);
    expect(out).toEqual([{ field: 'to', comparator: 'is', value: ['a', 'b'] }]);
  });
});
