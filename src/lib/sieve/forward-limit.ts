import type { FilterRule, VacationForward } from './types';

// Ported from the webmail's lib/filters/forward-limit.ts (#1155, #1208).

/*
 * A server lets one message trigger only so many redirects
 * (maxNumberRedirects, 1 for user scripts on Stalwart by default) and skips
 * the ones over that. The rules run in order, and a rule that stops ("Stop
 * processing", or the Stop action) ends the script for the messages it
 * matches: the forwards of the rules below it never add to its own. What
 * counts is the most forwards a single message can collect, not how many
 * forwards there are.
 */

type RuleForwards = Pick<FilterRule, 'enabled' | 'actions' | 'stopProcessing'>;

/** The forwards of a rule that run: those ahead of a Stop action. */
export function ruleForwards(rule: Pick<FilterRule, 'actions'>): number {
  let forwards = 0;
  for (const action of rule.actions) {
    if (action.type === 'stop') break;
    if (action.type === 'forward') forwards++;
  }
  return forwards;
}

/** The rule ends the script for the messages it matches. */
export function ruleStops(rule: Pick<FilterRule, 'actions' | 'stopProcessing'>): boolean {
  return rule.stopProcessing || rule.actions.some((action) => action.type === 'stop');
}

/** The most forwards one message can collect going through `rules`, in their order. */
export function worstCaseForwards(rules: RuleForwards[]): number {
  // From the rules so far that let the message go on.
  let open = 0;
  let worst = 0;
  for (const rule of rules) {
    if (!rule.enabled) continue;
    const forwards = ruleForwards(rule);
    if (ruleStops(rule)) worst = Math.max(worst, open + forwards);
    else open += forwards;
  }
  return Math.max(worst, open);
}

/**
 * For the rule at `index` of `rules` (in the order they run): the forwards a
 * message can have collected when it reaches the rule, and the most it can
 * still collect below it when the rule lets it go on. `replaces`: the rule
 * is at `index` already, rather than about to be put there.
 */
export function forwardsAround(
  rules: RuleForwards[],
  index: number,
  replaces: boolean,
): { before: number; after: number } {
  // A rule above that stops lets only the messages it does not match go on,
  // so its forwards never meet this rule's.
  const before = rules
    .slice(0, index)
    .filter((rule) => rule.enabled && !ruleStops(rule))
    .reduce((n, rule) => n + ruleForwards(rule), 0);
  const after = worstCaseForwards(rules.slice(replaces ? index + 1 : index));
  return { before, after };
}

/**
 * The rules in the order the script runs them: forwarding from the out of
 * office card goes ahead of every rule, and ends the script unless it keeps
 * a copy here.
 */
export function inRunOrder(rules: RuleForwards[], forward: VacationForward | null | undefined): RuleForwards[] {
  if (!forward?.enabled) return rules;
  return [{ enabled: true, actions: [{ type: 'forward', value: forward.to }], stopProcessing: !forward.keepCopy }, ...rules];
}

// ── App additions: what the rule editor and the rule list show ──

type ListedRule = RuleForwards & Pick<FilterRule, 'id' | 'origin'>;

/**
 * forwardsAround for the rule the editor has open in the filter list: the
 * edited rule where it is, a new one below Bulwark's own rules (where
 * addRule puts it), behind the out of office forwarding.
 */
export function forwardsOfEditedRule(
  rules: ListedRule[],
  forward: VacationForward | null | undefined,
  editedRuleId: string | undefined,
): { before: number; after: number } {
  const runOrder = inRunOrder(rules, forward);
  const editedIndex = editedRuleId ? rules.findIndex((r) => r.id === editedRuleId) : -1;
  const own = rules.filter((r) => r.origin !== 'external' && r.origin !== 'opaque').length;
  return forwardsAround(runOrder, runOrder.length - rules.length + (editedIndex >= 0 ? editedIndex : own), editedIndex >= 0);
}

export interface RuleForwardLimit {
  /** The server's cap on forwards per message, when it has one above 0. */
  limit: number | null;
  /** One message can collect more forwards than the cap with this rule. */
  overLimit: boolean;
  /** The server runs no forward at all (a cap of 0). */
  unavailable: boolean;
  /** Whether another action may become a forward. */
  canAddForward: boolean;
}

/** What the rule editor says about the server's redirect cap for the rule as edited. */
export function ruleForwardLimit(
  rule: Pick<FilterRule, 'actions' | 'stopProcessing'>,
  maxRedirects: number | null | undefined,
  around: { before: number; after: number },
): RuleForwardLimit {
  const count = ruleForwards(rule);
  const others = around.before + (ruleStops(rule) ? 0 : around.after);
  const limit = typeof maxRedirects === 'number' && maxRedirects > 0 ? maxRedirects : null;
  const unavailable = maxRedirects === 0;
  return {
    limit,
    overLimit: limit !== null && count + others > limit,
    unavailable,
    canAddForward: !unavailable && (limit === null || count + others < limit),
  };
}

/** What the rule list says: the rules' forwards over the cap, or ignored by a server without forwarding. */
export function rulesForwardLimit(
  rules: RuleForwards[],
  forward: VacationForward | null | undefined,
  maxRedirects: number | null | undefined,
): { tooMany: boolean; ignored: boolean } {
  return {
    tooMany: typeof maxRedirects === 'number' && maxRedirects > 0 && worstCaseForwards(inRunOrder(rules, forward)) > maxRedirects,
    ignored: maxRedirects === 0 && worstCaseForwards(rules) > 0,
  };
}
