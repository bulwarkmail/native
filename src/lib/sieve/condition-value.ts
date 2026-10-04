import type { FilterCondition, FilterRule } from './types';

// Helpers for the string | string[] condition value (1.7.3 "extended rules").
// Mirrors the webmail's filter-rule-modal.tsx: conditions are stored as
// string | string[]; the UI presents them as one comma-separated text input.
// The user types "a, b, c" and the saved value becomes ["a","b","c"]. Single
// entries stay strings so existing rules keep their shape.

export function valueToInputString(v: string | string[]): string {
  if (Array.isArray(v)) return v.join(', ');
  return v ?? '';
}

export function inputStringToValue(s: string): string | string[] {
  const parts = s.split(',').map((p) => p.trim()).filter((p) => p.length > 0);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return parts;
}

export function isConditionValueEmpty(v: string | string[]): boolean {
  if (Array.isArray(v)) return v.length === 0 || v.every((x) => !x.trim());
  return !(v ?? '').trim();
}

export function isHasAnyCondition(cond: FilterCondition): boolean {
  return cond.field === 'attachment' && cond.comparator === 'has_any';
}

// Conditions with nothing to type: attachment has_any and every message.
export function isValueLessCondition(cond: FilterCondition): boolean {
  return isHasAnyCondition(cond) || cond.field === 'all';
}

type Translate = (key: string, fallback?: string) => string;

// Human-readable value part of a condition: `"a"`, or `"a" or "b"` for lists
// using the locale's OR glue, or nothing for the value-less has_any test.
export function formatConditionValue(cond: FilterCondition, t: Translate): string {
  if (isValueLessCondition(cond)) return '';
  if (Array.isArray(cond.value)) {
    return cond.value.map((v) => `"${v}"`).join(` ${t('settings.filters.or', 'or')} `);
  }
  return `"${cond.value}"`;
}

const COMPARATOR_FALLBACK: Partial<Record<FilterCondition['comparator'], string>> = {
  address_is: 'is the address',
  domain_is: 'has the domain',
};

export function describeCondition(cond: FilterCondition, t: Translate): string {
  const field = t(
    `settings.filters.condition_fields.${cond.field}`,
    cond.field === 'all' ? 'All messages' : cond.field,
  );
  // "All messages" says it all; there is no comparator to show.
  if (cond.field === 'all') return field;
  const comparator = t(
    `settings.filters.comparators.${cond.comparator}`,
    COMPARATOR_FALLBACK[cond.comparator] ?? cond.comparator,
  );
  const value = formatConditionValue(cond, t);
  return value ? `${field} ${comparator} ${value}` : `${field} ${comparator}`;
}

// One-line summary: first two conditions joined with and/or, "(+N)" for the
// rest, then the first two actions.
export function summarizeRule(rule: FilterRule, t: Translate): string {
  const joiner = rule.matchType === 'all' ? t('settings.filters.and', 'and') : t('settings.filters.or', 'or');
  const conditions = rule.conditions.slice(0, 2).map((cond) => describeCondition(cond, t));
  const extra = rule.conditions.length > 2 ? ` (+${rule.conditions.length - 2})` : '';
  const actions = rule.actions.slice(0, 2).map((a) => {
    const action = t(`settings.filters.action_types.${a.type}`, a.type);
    return a.value ? `${action} "${a.value}"` : action;
  });
  return `${conditions.join(` ${joiner} `)}${extra} → ${actions.join(', ')}`;
}
