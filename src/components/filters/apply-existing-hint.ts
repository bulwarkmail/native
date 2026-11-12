import type { FilterCondition } from '../../lib/sieve/types';

/**
 * Which hint explains that "Also apply to existing messages" is off for a
 * rule the app cannot run on the mail already there (lib/sieve/retroactive).
 * A regular expression is named on its own: the general hint lists the
 * subject among what can run, and a subject rule that matches a regex still
 * can't.
 */
export function applyExistingUnsupportedReason(
  periodOn: boolean,
  conditions: Pick<FilterCondition, 'comparator'>[],
): 'period' | 'regex' | 'other' {
  if (periodOn) return 'period';
  if (conditions.some((c) => c.comparator === 'regex')) return 'regex';
  return 'other';
}
