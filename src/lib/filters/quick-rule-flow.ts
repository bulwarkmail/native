import { jmapClient } from '../../api/jmap-client';
import {
  copyEmailsWithinAccount,
  moveEmails,
  patchKeywordsForEmails,
  queryEmailFields,
} from '../../api/email';
import type { FilterRule } from '../sieve/types';
import { useAccountStore } from '../../stores/account-store';
import { listRowsOfAccount, useEmailStore } from '../../stores/email-store';
import { toast } from '../../stores/toast-store';
import { t } from '../../stores/locale-store';
import { clientServesActiveAccount } from '../active-client-account';
import { generateUUID } from '../uuid';
import {
  FiltersChangedError,
  OpaqueFiltersError,
  restoreAccountFilters,
  updateAccountFilters,
  type FiltersChange,
} from './account-filters';
import {
  applyQuickRule,
  buildPresetRule,
  insertRuleAtTop,
  replaceOrInsertRule,
  type QuickRuleOutcome,
  type QuickRulePreset,
  type QuickRuleSubject,
  type Translate,
} from './quick-rules';
import {
  planRetroactive,
  retroactiveSupport,
  retroProperties,
  retroQueryFilter,
  toRetroMessage,
  type RetroPlan,
} from './retroactive';
import type { QuickRuleTarget } from './quick-rule-target';

/**
 * Save a rule made from a message, undo it, or run it over mail already in
 * the folder (ported from the webmail's lib/filters/quick-rule-flow.ts). Every
 * call names the message's own account through the target; nothing here reads
 * the filter store's selected account or the client's default account.
 */

const EMPTY_PLAN: RetroPlan = { ids: [], steps: [] };
const SAVED_TOAST_MS = 12_000;

/** The `settings.filters` translator buildPresetRule names rules with. */
const filtersText: Translate = (key, values) => t(`settings.filters.${key}`, undefined, values);

function reportWriteError(error: unknown): void {
  if (error instanceof OpaqueFiltersError) {
    toast.error(t('context_menu.rules.opaque_hint', 'Your filters were edited by hand. Open Filters settings'));
    return;
  }
  toast.error(
    t('notifications.filters_save_failed', 'Failed to save filters'),
    error instanceof Error ? error.message : undefined,
  );
}

/** The login the rule was made in is no longer the one the client serves. */
export class SwitchedAwayError extends Error {
  constructor() {
    super('The account changed');
    this.name = 'SwitchedAwayError';
  }
}

/** A plan failed after some of its batches had already been sent. */
export class PartialApplyError extends Error {
  readonly cause: unknown;
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Apply failed');
    this.name = 'PartialApplyError';
    this.cause = cause;
  }
}

/**
 * Whether the client is connected to the login the target belongs to. The
 * singleton client is reconnected by an account switch, and ids are only
 * unique per server, so nothing is sent for a target once it has gone.
 */
export function targetStillActive(target: QuickRuleTarget): boolean {
  return clientServesActiveAccount()
    && useAccountStore.getState().activeAccountId === target.appAccountId;
}

function accountLabel(target: QuickRuleTarget): string {
  const entry = target.appAccountId ? useAccountStore.getState().getAccountById(target.appAccountId) : undefined;
  return entry?.email || entry?.username || target.jmapAccountId;
}

function switchBackText(target: QuickRuleTarget): string {
  return t('notifications.rule_switch_back', 'Switch back to {account} to finish this', { account: accountLabel(target) });
}

function reportApplyError(error: unknown, target: QuickRuleTarget): void {
  const partial = error instanceof PartialApplyError;
  const cause = partial ? error.cause : error;
  const failed = partial
    ? t('notifications.rule_apply_partial', 'Could not finish applying the rule. Some messages may already have been changed.')
    : t('notifications.rule_apply_failed', 'Could not apply the rule to existing messages');
  if (cause instanceof SwitchedAwayError) {
    if (partial) toast.error(failed, switchBackText(target));
    else toast.error(switchBackText(target));
    return;
  }
  toast.error(failed, cause instanceof Error ? cause.message : undefined);
}

/** Whether a rule can be written for this target at all. */
function writable(target: QuickRuleTarget): boolean {
  return !target.shared && target.supportsSieve;
}

/** What the rule would do to the mail already in `target.sourceMailboxId`. */
export async function planOnServer(target: QuickRuleTarget, rule: FilterRule): Promise<RetroPlan> {
  const source = target.sourceMailboxId;
  if (!source || !retroactiveSupport(rule).ok) return EMPTY_PLAN;
  const records = await queryEmailFields(
    retroQueryFilter(rule, source),
    retroProperties(rule),
    { accountId: target.jmapAccountId },
  );
  return planRetroactive(rule, records.map(toRetroMessage));
}

async function planSafely(target: QuickRuleTarget, rule: FilterRule): Promise<RetroPlan> {
  try {
    return await planOnServer(target, rule);
  } catch {
    return EMPTY_PLAN;
  }
}

function slices<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Carry out a plan against the target's account, `maxObjectsInSet` messages
 * per request, then bring the loaded list up to date when it shows that
 * account. Not undoable, as in webmail.
 */
export async function executePlan(target: QuickRuleTarget, plan: RetroPlan): Promise<void> {
  const account = target.jmapAccountId;
  const size = Math.max(1, jmapClient.getMaxObjectsInSet());
  let sent = 0;
  try {
    for (const step of plan.steps) {
      // A plan only moves out of a known source folder.
      if (step.kind === 'move' && !target.sourceMailboxId) continue;
      for (const ids of slices(step.ids, size)) {
        if (!targetStillActive(target)) throw new SwitchedAwayError();
        sent++;
        switch (step.kind) {
          case 'mark_read':
            await patchKeywordsForEmails(ids, { $seen: true }, account);
            break;
          case 'keyword':
            await patchKeywordsForEmails(ids, { [step.keyword]: true }, account);
            break;
          case 'copy':
            await copyEmailsWithinAccount(ids, step.mailboxId, account);
            break;
          case 'move':
            await moveEmails(ids, target.sourceMailboxId!, step.mailboxId, account);
            break;
        }
      }
    }
  } catch (error) {
    throw sent > 0 ? new PartialApplyError(error) : error;
  } finally {
    // A partly applied plan changed rows too.
    refreshLoadedRows(target);
  }
}

/** Re-read the list when it holds rows of the target's account. */
function refreshLoadedRows(target: QuickRuleTarget): void {
  if (!clientServesActiveAccount()) return;
  if (useAccountStore.getState().activeAccountId !== target.appAccountId) return;
  const own = jmapClient.accountId;
  const rows = listRowsOfAccount(target.jmapAccountId === own ? undefined : target.jmapAccountId);
  if (rows.length === 0) return;
  const email = useEmailStore.getState();
  void email.refreshEmails().catch(() => {});
  void email.fetchMailboxes().catch(() => {});
}

/** Run `rule` over the mail already in the folder; returns how many messages changed. */
export async function applyToExisting(target: QuickRuleTarget, rule: FilterRule): Promise<number> {
  if (!targetStillActive(target)) throw new SwitchedAwayError();
  const plan = await planOnServer(target, rule);
  await executePlan(target, plan);
  return plan.ids.length;
}

async function applyAndReport(target: QuickRuleTarget, rule: FilterRule): Promise<void> {
  try {
    const count = await applyToExisting(target, rule);
    toast.success(t(
      'notifications.rule_applied',
      '{count, plural, =0 {No messages needed changes} one {Rule applied to # message} other {Rule applied to # messages}}',
      { count },
    ));
  } catch (error) {
    reportApplyError(error, target);
  }
}

async function undoChange(change: FiltersChange): Promise<void> {
  try {
    await restoreAccountFilters(change);
    toast.success(t('notifications.rule_undone', 'Rule change undone'));
  } catch (error) {
    toast.error(error instanceof FiltersChangedError
      ? t('notifications.rule_undo_conflict', 'Your filters have changed since. Undo the change in Filters settings.')
      : t('notifications.rule_undo_failed', 'Could not undo the rule change'));
  }
}

function undoAction(target: QuickRuleTarget, change: FiltersChange) {
  let used = false;
  return {
    label: t('notifications.rule_undo', 'Undo'),
    onPress: () => {
      if (used) return;
      if (!targetStillActive(target)) {
        toast.error(switchBackText(target));
        return;
      }
      used = true;
      void undoChange(change);
    },
  };
}

/**
 * Save a one-click rule right away, merged into an existing rule that does
 * the same thing where there is one, and offer to undo it or to apply it to
 * the mail already in the folder.
 */
export async function runPresetRule(params: {
  target: QuickRuleTarget;
  preset: QuickRulePreset;
  subject: QuickRuleSubject;
}): Promise<void> {
  const { target, preset, subject } = params;
  if (!writable(target)) {
    toast.error(t('notifications.filters_save_failed', 'Failed to save filters'));
    return;
  }
  const candidate = buildPresetRule(preset, subject, filtersText, generateUUID());
  const result: { outcome?: QuickRuleOutcome } = {};
  let change: FiltersChange | null;
  try {
    change = await updateAccountFilters(target.sieveAccountId, (rules) => {
      result.outcome = applyQuickRule(rules, candidate);
      return result.outcome.kind === 'covered' ? null : result.outcome.rules;
    });
  } catch (error) {
    reportWriteError(error);
    return;
  }
  const outcome = result.outcome!;

  if (outcome.kind === 'covered' || !change) {
    toast.info(t('notifications.rule_already_covered', 'Already covered by rule “{name}”', { name: outcome.rule.name }));
    return;
  }

  const added = outcome.added;
  const plan = await planSafely(target, added);
  toast.success(
    outcome.kind === 'merged'
      ? t('notifications.rule_merged', 'Added to rule “{name}”', { name: outcome.rule.name })
      : t('notifications.rule_created', 'Rule created'),
    {
      message: outcome.kind === 'created' ? outcome.rule.name : undefined,
      duration: SAVED_TOAST_MS,
      action: undoAction(target, change),
      secondaryAction: plan.ids.length > 0
        ? {
            label: t(
              'notifications.rule_apply_existing',
              '{count, plural, one {Apply to # existing message} other {Apply to # existing messages}}',
              { count: plan.ids.length },
            ),
            onPress: () => { void applyAndReport(target, added); },
          }
        : undefined,
    },
  );
}

/**
 * Save the rule editor. "Create rule…" puts the rule at the top of the
 * account's rules as the user built it (no merging); `mode: 'edit'` replaces
 * the rule in place. With `applyToExisting` a new rule also runs over the
 * mail already in the folder.
 */
export async function saveEditorRule(
  rule: FilterRule,
  options: { target: QuickRuleTarget; applyToExisting?: boolean; mode?: 'create' | 'edit' },
): Promise<void> {
  const { target } = options;
  const editing = options.mode === 'edit';
  if (!writable(target)) {
    toast.error(t('notifications.filters_save_failed', 'Failed to save filters'));
    return;
  }
  let change: FiltersChange | null;
  try {
    change = await updateAccountFilters(target.sieveAccountId, (rules) =>
      editing ? replaceOrInsertRule(rules, rule) : insertRuleAtTop(rules, rule));
  } catch (error) {
    reportWriteError(error);
    return;
  }
  if (!change) return;

  if (editing) {
    toast.success(t('notifications.filters_saved', 'Filters saved successfully'));
    return;
  }

  let applied: number | null = null;
  if (options.applyToExisting) {
    try {
      applied = await applyToExisting(target, rule);
    } catch (error) {
      reportApplyError(error, target);
    }
  }
  toast.success(t('notifications.rule_created', 'Rule created'), {
    message: applied !== null
      ? t(
        'notifications.rule_applied',
        '{count, plural, =0 {No messages needed changes} one {Rule applied to # message} other {Rule applied to # messages}}',
        { count: applied },
      )
      : rule.name,
    duration: SAVED_TOAST_MS,
    action: undoAction(target, change),
  });
}
