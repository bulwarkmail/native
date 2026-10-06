import { isConditionValueEmpty, isValueLessCondition } from '../sieve/condition-value';
import type { FilterCondition } from '../sieve/types';
import type { RuleSuggestion } from './quick-rules';

function sameCondition(a: FilterCondition, b: FilterCondition): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Put a suggestion chip's condition into a draft rule. The blank row a new
 * rule starts with makes way for it; a chip with `replaces` (the domain chip)
 * takes the place of the first condition that matches, otherwise the condition
 * is appended. Applying a condition the rule already has changes nothing.
 */
export function applySuggestion<R extends { conditions: FilterCondition[] }>(
  rule: R,
  suggestion: RuleSuggestion,
): R {
  if (rule.conditions.some((c) => sameCondition(c, suggestion.condition))) return rule;
  const kept = rule.conditions.filter((c) => isValueLessCondition(c) || !isConditionValueEmpty(c.value));
  const replaceAt = suggestion.replaces ? kept.findIndex(suggestion.replaces) : -1;
  const conditions = replaceAt === -1
    ? [...kept, suggestion.condition]
    : kept.map((c, i) => (i === replaceAt ? suggestion.condition : c));
  return { ...rule, conditions };
}
