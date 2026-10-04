import {
  inputStringToValue,
  isConditionValueEmpty,
  isValueLessCondition,
} from './condition-value';
import type { FilterComparator, FilterCondition, FilterConditionField } from './types';

// "All messages" goes last, as in the webmail.
export const CONDITION_FIELDS: FilterConditionField[] = [
  'from', 'to', 'cc', 'subject', 'header', 'size', 'body', 'attachment', 'all',
];
const TEXT_COMPARATORS: FilterComparator[] = ['contains', 'not_contains', 'is', 'not_is', 'starts_with', 'ends_with', 'matches'];
const ADDRESS_COMPARATORS: FilterComparator[] = [...TEXT_COMPARATORS, 'address_is', 'domain_is'];
const SIZE_COMPARATORS: FilterComparator[] = ['greater_than', 'less_than'];
const ATTACHMENT_COMPARATORS: FilterComparator[] = ['has_any', 'has_type'];
const ALL_COMPARATORS: FilterComparator[] = ['any'];

export function comparatorsFor(field: FilterConditionField): FilterComparator[] {
  if (field === 'all') return ALL_COMPARATORS;
  if (field === 'size') return SIZE_COMPARATORS;
  if (field === 'attachment') return ATTACHMENT_COMPARATORS;
  if (field === 'from' || field === 'to' || field === 'cc') return ADDRESS_COMPARATORS;
  return TEXT_COMPARATORS;
}

// The generator writes any other size as 0, which matches every message, so
// the editor must refuse it rather than save an "act on everything" rule.
export function isValidSizeValue(value: string | string[]): boolean {
  return typeof value === 'string' && /^\d+[KMG]?$/i.test(value.trim());
}

// What a condition row becomes when its field changes.
export function conditionForField(prev: FilterCondition, field: FilterConditionField): FilterCondition {
  if (field === 'all') return { field: 'all', comparator: 'any', value: '' };
  const comparators = comparatorsFor(field);
  if (prev.field === 'all') return { field, comparator: comparators[0], value: '' };
  const updated: FilterCondition = { ...prev, field };
  // Reconcile the comparator when the field family changes so a size
  // rule never keeps "contains" and an attachment rule never keeps
  // "greater than".
  if (!comparators.includes(updated.comparator)) updated.comparator = comparators[0];
  if (field !== 'header') delete updated.headerName;
  // An address list must never become a size, nor a size an address.
  if ((field === 'size') !== (prev.field === 'size')) updated.value = '';
  if (isValueLessCondition(updated)) updated.value = '';
  return updated;
}

// Conditions worth saving. While editing, condition.value is the raw string
// typed into the input (commas not yet split); convert to array form here so
// "a, b, c" persists ["a","b","c"]. Splitting on every keystroke would eat
// the comma the moment it is typed.
export function conditionsToSave(conditions: FilterCondition[]): FilterCondition[] {
  return conditions
    .filter((cond) => isValueLessCondition(cond) || !isConditionValueEmpty(cond.value))
    .map((cond) => {
      if (isValueLessCondition(cond)) return { ...cond, value: '' };
      if (cond.field === 'size') return cond; // numeric, single-value only
      if (typeof cond.value !== 'string') return cond; // already structured
      return { ...cond, value: inputStringToValue(cond.value) };
    });
}
