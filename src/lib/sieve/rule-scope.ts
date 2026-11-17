import type { FilterAction, FilterRule } from './types';
import type { Mailbox } from '../../api/types';
import { executeRetroPlan } from './retroactive-run';
import type { RetroPlan, RetroStep } from './retroactive';
import { findRuleMatches, previewPlan, type RulePreviewTarget } from './rule-preview';

type QuickRuleTarget = RulePreviewTarget;

export type ApplyScope = 'new' | 'folder' | 'all';

export const APPLY_LIMIT = Number.MAX_SAFE_INTEGER;

type Matched = Record<string, unknown>;

function filesWithoutFolder(action: FilterAction): boolean {
  return (action.type === 'move' || action.type === 'copy') && !action.mailboxId;
}

function changesOldMail(action: FilterAction): boolean {
  switch (action.type) {
    case 'mark_read':
    case 'star':
    case 'discard':
      return true;
    case 'add_label':
      return !!action.value;
    case 'move':
    case 'copy':
      return !!action.mailboxId;
    default:
      return false;
  }
}

export function appliesToExisting(rule: Pick<FilterRule, 'actions'> & { conditions?: FilterRule['conditions'] }): boolean {
  if (rule.conditions?.some((c) => c.field === 'body' || c.field === 'delivered_to')) return false;
  return rule.actions.some(changesOldMail) && !rule.actions.some(filesWithoutFolder);
}

export function canApplyToExisting(rule: FilterRule, mailboxes: Mailbox[]): boolean {
  return appliesToExisting(rule) && previewPlan(rule, mailboxes) !== null;
}

export function skipsJunk(rule: Pick<FilterRule, 'actions' | 'includeSpam'>): boolean {
  return !rule.includeSpam && rule.actions.some((a) => a.type === 'move' || a.type === 'copy');
}

export function planMatched(rule: FilterRule, records: Matched[], mailboxes: Mailbox[]): RetroPlan {
  const serverId = (id: string) => {
    const mailbox = mailboxes.find((m) => m.id === id);
    return mailbox ? mailbox.originalId || mailbox.id : id;
  };
  const messages = records.map((r) => ({
    id: String(r.id),
    mailboxIds: (r.mailboxIds as Record<string, boolean> | undefined) ?? {},
    keywords: (r.keywords as Record<string, boolean> | undefined) ?? {},
  }));
  const steps: RetroStep[] = [];
  const changed = new Set<string>();
  const add = (step: RetroStep) => {
    if (step.ids.length === 0) return;
    steps.push(step);
    for (const id of step.ids) changed.add(id);
  };
  const lacking = (keyword: string) => messages.filter((m) => !m.keywords[keyword]).map((m) => m.id);
  const notIn = (mailboxId: string) => messages.filter((m) => !m.mailboxIds[serverId(mailboxId)]).map((m) => m.id);

  for (const action of rule.actions) {
    if (action.type === 'mark_read') add({ kind: 'mark_read', ids: lacking('$seen') });
    if (action.type === 'star') add({ kind: 'keyword', ids: lacking('$flagged'), keyword: '$flagged' });
    if (action.type === 'add_label' && action.value) add({ kind: 'keyword', ids: lacking(`$label:${action.value}`), keyword: `$label:${action.value}` });
  }
  const filing = rule.actions.filter((a) => (a.type === 'move' || a.type === 'copy') && a.mailboxId);
  const firstMove = filing.find((a) => a.type === 'move');
  const moved = new Set(firstMove ? notIn(firstMove.mailboxId!) : []);
  if (firstMove) add({ kind: 'move', ids: [...moved], mailboxId: firstMove.mailboxId! });
  for (const action of filing) {
    if (action === firstMove) continue;
    const target = action.mailboxId!;
    const ids = messages
      .filter((m) => (moved.has(m.id) ? serverId(target) !== serverId(firstMove!.mailboxId!) : !m.mailboxIds[serverId(target)]))
      .map((m) => m.id);
    add({ kind: 'copy', ids, mailboxId: target });
  }
  const trash = mailboxes.find((m) => m.role === 'trash');
  if (trash && rule.actions.some((a) => a.type === 'discard')) add({ kind: 'move', ids: notIn(trash.id), mailboxId: trash.id });
  return { ids: [...changed], steps };
}

export async function planRuleForScope(
  target: QuickRuleTarget,
  rule: FilterRule,
  scope: ApplyScope,
  folderId: string | null,
): Promise<RetroPlan> {
  const nothing: RetroPlan = { ids: [], steps: [] };
  if (scope === 'new' || !appliesToExisting(rule)) return nothing;
  if (scope === 'folder' && !folderId) return nothing;
  const matches = await findRuleMatches(target, rule, {
    folderId: scope === 'folder' ? folderId! : undefined,
    skipJunk: skipsJunk(rule),
    limit: APPLY_LIMIT,
  });
  return matches ? planMatched(rule, matches.records, target.mailboxes) : nothing;
}

export function trashedBy(plan: RetroPlan, mailboxes: Mailbox[]): number {
  const trash = mailboxes.find((m) => m.role === 'trash');
  if (!trash) return 0;
  const ids = new Set<string>();
  for (const step of plan.steps) {
    if (step.kind === 'move' && step.mailboxId === trash.id) for (const id of step.ids) ids.add(id);
  }
  return ids.size;
}

export async function applyRuleToScope(
  target: QuickRuleTarget,
  rule: FilterRule,
  scope: ApplyScope,
  folderId: string | null,
): Promise<number> {
  const plan = await planRuleForScope(target, rule, scope, folderId);
  if (plan.steps.length > 0) await executeRetroPlan(plan, target.accountId);
  return plan.ids.length;
}
