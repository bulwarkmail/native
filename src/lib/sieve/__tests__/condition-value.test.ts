import { describe, it, expect } from 'vitest';
import {
  valueToInputString,
  inputStringToValue,
  isConditionValueEmpty,
  describeCondition,
  isValueLessCondition,
  summarizeRule,
} from '../condition-value';
import type { FilterRule } from '../types';

const t = (key: string, fallback?: string) => fallback ?? key;

describe('condition value helpers', () => {
  it('joins arrays for the input and keeps strings as-is', () => {
    expect(valueToInputString(['a', 'b'])).toBe('a, b');
    expect(valueToInputString('a')).toBe('a');
  });

  it('splits comma input into an array, single item stays a string', () => {
    expect(inputStringToValue('a, b ,c')).toEqual(['a', 'b', 'c']);
    expect(inputStringToValue(' only ')).toBe('only');
    expect(inputStringToValue(' , ')).toBe('');
  });

  it('detects empty values in both shapes', () => {
    expect(isConditionValueEmpty('')).toBe(true);
    expect(isConditionValueEmpty('  ')).toBe(true);
    expect(isConditionValueEmpty([])).toBe(true);
    expect(isConditionValueEmpty([' '])).toBe(true);
    expect(isConditionValueEmpty(['x'])).toBe(false);
    expect(isConditionValueEmpty('x')).toBe(false);
  });
});

describe('summaries', () => {
  const rule: FilterRule = {
    id: 'r',
    name: 'R',
    enabled: true,
    matchType: 'any',
    conditions: [
      { field: 'from', comparator: 'contains', value: ['@a.com', '@b.com'] },
      { field: 'attachment', comparator: 'has_any', value: '' },
      { field: 'attachment', comparator: 'has_type', value: 'pdf' },
    ],
    actions: [{ type: 'move', value: 'Archive' }, { type: 'stop' }],
    stopProcessing: false,
  };

  it('describes list values with the OR glue and omits the has_any value', () => {
    expect(describeCondition(rule.conditions[0], t)).toBe('from contains "@a.com" or "@b.com"');
    expect(describeCondition(rule.conditions[1], t)).toBe('attachment has_any');
    expect(describeCondition(rule.conditions[2], t)).toBe('attachment has_type "pdf"');
  });

  it('summarises the first two conditions and actions', () => {
    expect(summarizeRule(rule, t)).toBe(
      'from contains "@a.com" or "@b.com" or attachment has_any (+1) → move "Archive", stop',
    );
  });

  it('describes an all-messages condition by its field label alone', () => {
    expect(describeCondition({ field: 'all', comparator: 'any', value: '' }, t)).toBe('All messages');
  });

  it('treats has_any and all as value-less', () => {
    expect(isValueLessCondition({ field: 'all', comparator: 'any', value: '' })).toBe(true);
    expect(isValueLessCondition({ field: 'attachment', comparator: 'has_any', value: '' })).toBe(true);
    expect(isValueLessCondition({ field: 'from', comparator: 'contains', value: 'x' })).toBe(false);
  });
});
