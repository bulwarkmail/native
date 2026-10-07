import type { FilterAction, FilterRule, VacationForward } from '../sieve/types';
import { forwardsAround, inRunOrder, ruleForwards, ruleStops, worstCaseForwards } from './forward-limit';

/** The server's redirect limit when it names a usable one. */
export function redirectLimitOf(maxRedirects: number | null | undefined): number | null {
  return typeof maxRedirects === 'number' && maxRedirects > 0 ? maxRedirects : null;
}

/** Whether the rules, behind the out of office forwarding, can collect more forwards than the server lets through. */
export function hasTooManyForwards(
  rules: FilterRule[],
  vacationForward: VacationForward | null | undefined,
  maxRedirects: number | null | undefined,
): boolean {
  const limit = redirectLimitOf(maxRedirects);
  return limit !== null && worstCaseForwards(inRunOrder(rules, vacationForward)) > limit;
}

/**
 * The forwards around a rule being edited or made. `editedId`: the rule where
 * it is now (one no longer there counts as new). `newIndex`: where a new rule
 * goes among `rules`.
 */
export function forwardsForRule(
  rules: FilterRule[],
  vacationForward: VacationForward | null | undefined,
  editedId: string | undefined,
  newIndex: number,
): { before: number; after: number } {
  const runOrder = inRunOrder(rules, vacationForward);
  const editedIndex = editedId ? rules.findIndex((r) => r.id === editedId) : -1;
  return forwardsAround(
    runOrder,
    runOrder.length - rules.length + (editedIndex >= 0 ? editedIndex : newIndex),
    editedIndex >= 0,
  );
}

export interface ModalForwardState {
  limit: number | null;
  /** This rule alone lets a message collect more forwards than the server allows. */
  overLimit: boolean;
  /** Whether the Forward choice is off for an action that is not one already. */
  forwardDisabled: boolean;
}

export function modalForwardState(
  actions: FilterAction[],
  stopProcessing: boolean,
  maxRedirects: number | null | undefined,
  forwardsBefore = 0,
  forwardsAfter = 0,
): ModalForwardState {
  const limit = redirectLimitOf(maxRedirects);
  const count = ruleForwards({ actions });
  const other = forwardsBefore + (ruleStops({ actions, stopProcessing }) ? 0 : forwardsAfter);
  return {
    limit,
    overLimit: limit !== null && count + other > limit,
    forwardDisabled: limit !== null && count + other >= limit,
  };
}
