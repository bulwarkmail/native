import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Mailbox } from '../../api/types';
import type { TranslateFn } from '../../stores/locale-store';
import { generateUUID } from '../../lib/uuid';
import { buildMailboxTree, type MailboxNode } from '../../lib/mailbox-tree';
import { localizeMailboxName } from '../../lib/mailbox-label';
import type { FilterComparator, FilterCondition, FilterConditionField, FilterRule } from '../../lib/sieve/types';
import { isValidSieveHeaderName } from '../../lib/sieve/generator';
import { REGEX_FIELDS, isValidSieveRegex, usesRegex } from '../../lib/sieve/regex';
import { hasPeriod } from '../../lib/sieve/period';
import { periodError, periodFromInput, periodToInput } from '../../lib/sieve/rule-period';
import { ruleForwards, ruleStops } from '../../lib/sieve/forward-limit';
import { buildMailboxTargets } from '../../lib/sieve/rule-actions';
import { appliesToExisting, skipsJunk, type ApplyScope } from '../../lib/sieve/rule-scope';
import type { RulePreview } from '../../lib/sieve/rule-preview';
import {
  inputStringToValue,
  isConditionValueEmpty,
  takesNoValue,
  valueToInputString,
} from '../../lib/sieve/condition-value';
import {
  blockedActions,
  checklistFromActions,
  checklistProblem,
  checklistToActions,
  foldStopAction,
  formatSize,
  keepActionOrder,
  parseSize,
  type Checklist,
  type ChecklistKey,
  type ChecklistProblem,
  type FolderChoice,
  type SizeUnit,
} from '../../lib/sieve/rule-editor-model';

export type ConditionKind = Exclude<FilterConditionField, 'attachment'> | 'attachment_any' | 'attachment_type';

export const CONDITION_KINDS: ConditionKind[] = [
  'from', 'to', 'cc', 'delivered_to', 'subject', 'body', 'header', 'size', 'attachment_any', 'attachment_type', 'all',
];

export const SIZE_UNITS: SizeUnit[] = ['', 'K', 'M'];
export const SIZE_UNIT_KEYS: Record<SizeUnit, 'bytes' | 'kb' | 'mb'> = { '': 'bytes', K: 'kb', M: 'mb' };

const TEXT_COMPARATORS: FilterComparator[] = ['contains', 'not_contains', 'is', 'not_is', 'starts_with', 'ends_with', 'matches'];
const ADDRESS_COMPARATORS: FilterComparator[] = [...TEXT_COMPARATORS, 'address_is', 'domain_is'];
const SIZE_COMPARATORS: FilterComparator[] = ['greater_than', 'less_than'];
const BODY_COMPARATORS: FilterComparator[] = ['contains', 'not_contains'];
const DELIVERED_COMPARATORS: FilterComparator[] = ['address_is', 'domain_is', 'contains'];
const PLAIN_COMPARATORS = new Set<FilterComparator>(['contains', 'is', 'address_is', 'domain_is']);
const PREVIEW_DELAY_MS = 500;

export function kindOf(c: FilterCondition): ConditionKind {
  if (c.field === 'attachment') return c.comparator === 'has_type' ? 'attachment_type' : 'attachment_any';
  return c.field;
}

export function kindComparators(kind: ConditionKind, regex: boolean): FilterComparator[] {
  if (kind === 'size') return SIZE_COMPARATORS;
  if (kind === 'attachment_any' || kind === 'attachment_type' || kind === 'all') return [];
  if (kind === 'delivered_to') return DELIVERED_COMPARATORS;
  const base = kind === 'from' || kind === 'to' || kind === 'cc' ? ADDRESS_COMPARATORS : kind === 'body' ? BODY_COMPARATORS : TEXT_COMPARATORS;
  return regex && REGEX_FIELDS.has(kind) ? [...base, 'regex'] : base;
}

export function withKind(c: FilterCondition, kind: ConditionKind, regex: boolean): FilterCondition {
  if (kind === 'attachment_any') return { field: 'attachment', comparator: 'has_any', value: '' };
  if (kind === 'attachment_type') {
    return { field: 'attachment', comparator: 'has_type', value: c.field === 'attachment' ? c.value : '' };
  }
  if (kind === 'all') return { field: 'all', comparator: 'any', value: '' };
  const allowed = kindComparators(kind, regex);
  const comparator = allowed.includes(c.comparator) ? c.comparator : allowed[0];
  const keepValue = c.field !== 'all' && c.field !== 'attachment' && (kind === 'size') === (c.field === 'size');
  const next: FilterCondition = { field: kind, comparator, value: keepValue ? c.value : '' };
  if (kind === 'header') next.headerName = c.headerName ?? '';
  return next;
}

export function attachmentTypeInvalid(c: FilterCondition): boolean {
  if (c.field !== 'attachment' || c.comparator !== 'has_type' || isConditionValueEmpty(c.value)) return false;
  return (Array.isArray(c.value) ? c.value : [c.value]).some((v) => !v.replace(/^[.*]+/, '').trim());
}

function regexInvalid(c: FilterCondition): boolean {
  if (!usesRegex(c) || isConditionValueEmpty(c.value)) return false;
  return (Array.isArray(c.value) ? c.value : [c.value]).some((v) => !isValidSieveRegex(v));
}

export function editedConditions(conditions: FilterCondition[]): FilterCondition[] {
  return conditions
    .map((c) => {
      if (takesNoValue(c) || c.field === 'size' || typeof c.value !== 'string' || usesRegex(c)) return c;
      return { ...c, value: inputStringToValue(c.value) };
    })
    .filter((c) => takesNoValue(c) || !isConditionValueEmpty(c.value))
    .map((c) => (c.field === 'header' ? { ...c, headerName: (c.headerName ?? '').trim() } : c));
}

export interface RuleKeyword {
  id: string;
  label: string;
}

export interface RuleEditorOptions {
  rule?: FilterRule;
  initialRule?: FilterRule;
  mailboxes: Mailbox[];
  keywords: RuleKeyword[];
  t: TranslateFn;
  maxRedirects?: number | null;
  forwardsBefore?: number;
  forwardsAfter?: number;
  periodsSupported?: boolean;
  regexSupported?: boolean;
  offerApplyToExisting?: boolean;
  applyExistingFolder?: string;
  previewMatches?: (rule: FilterRule, options: { skipJunk: boolean }) => Promise<RulePreview | null>;
  confirmTrash?: (question: { title: string; message: string; confirm: string; cancel: string }) => Promise<boolean>;
  onSave: (rule: FilterRule, options: { applyTo: ApplyScope }) => void;
}

export interface ApplyOption {
  value: ApplyScope;
  label: string;
  disabled: boolean;
}

export type PreviewState = { status: 'off' } | { status: 'checking' } | { status: 'none' } | { status: 'done'; result: RulePreview };

export type ErrorSection = 'conditions' | 'actions' | 'period';

function emptyCondition(): FilterCondition {
  return { field: 'from', comparator: 'contains', value: '' };
}

export function useRuleEditor(options: RuleEditorOptions) {
  const {
    rule, initialRule, mailboxes, keywords, t, maxRedirects, forwardsBefore = 0, forwardsAfter = 0,
    periodsSupported = false, regexSupported = false, offerApplyToExisting = false, applyExistingFolder,
    previewMatches, confirmTrash, onSave,
  } = options;
  const isEdit = !!rule;
  const start = rule ?? initialRule;

  const [name, setName] = useState(start?.name || '');
  const [matchType, setMatchType] = useState<'all' | 'any'>(start?.matchType || 'all');
  const [conditions, setConditions] = useState<FilterCondition[]>(() =>
    start?.conditions.length ? start.conditions.map((c) => ({ ...c })) : [emptyCondition()]);
  const [folded] = useState(() => foldStopAction(start?.actions ?? [], start?.stopProcessing ?? false));
  const [checklist, setChecklist] = useState<Checklist>(() => checklistFromActions(folded.actions));
  const [stopProcessing, setStopProcessing] = useState(folded.stopProcessing);
  const [enabled, setEnabled] = useState(start?.enabled ?? true);
  const [includeSpam, setIncludeSpam] = useState(start?.includeSpam ?? false);
  const [applyTo, setApplyTo] = useState<ApplyScope>('new');
  const hadPeriod = !!start && hasPeriod(start);
  const [periodOn, setPeriodOn] = useState(hadPeriod);
  const [periodStart, setPeriodStart] = useState(() => periodToInput(start?.activeFrom));
  const [periodEnd, setPeriodEnd] = useState(() => periodToInput(start?.activeUntil));
  const [showErrors, setShowErrors] = useState(false);
  const [saveAttempt, setSaveAttempt] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);

  const draft = JSON.stringify([
    name, matchType, conditions, checklist, stopProcessing, enabled, includeSpam, applyTo, periodOn, periodStart, periodEnd,
  ]);
  const [initialDraft] = useState(draft);
  const dirty = draft !== initialDraft;

  const targets = useMemo(() => buildMailboxTargets(mailboxes.filter((m) => !m.isShared)), [mailboxes]);
  const pathById = useMemo(() => new Map(targets.map((target) => [target.id, target.path])), [targets]);
  const mailboxByTargetId = useMemo(() => new Map(mailboxes.map((m) => [m.originalId ?? m.id, m])), [mailboxes]);
  const displayPathById = useMemo(() => {
    const paths = new Map<string, string>();
    const walk = (nodes: MailboxNode[], parent: string) => {
      for (const node of nodes) {
        const segment = localizeMailboxName(node.role, node.name, t);
        const path = parent ? `${parent} / ${segment}` : segment;
        paths.set(node.originalId ?? node.id, path);
        walk(node.children, path);
      }
    };
    walk(buildMailboxTree(mailboxes.filter((m) => !m.isShared)), '');
    return paths;
  }, [mailboxes, t]);

  const folderIdFor = useCallback((choice: Pick<FolderChoice, 'mailboxId' | 'value'>): string => {
    if (choice.mailboxId) return choice.mailboxId;
    return targets.find((target) => target.path === choice.value)?.id ?? '';
  }, [targets]);

  const resolvedChecklist = useMemo<Checklist>(() => {
    const resolve = (choice: FolderChoice): FolderChoice => {
      const mailboxId = folderIdFor(choice);
      return mailboxId ? { ...choice, mailboxId, value: pathById.get(mailboxId) ?? choice.value } : choice;
    };
    return { ...checklist, move: resolve(checklist.move), copy: resolve(checklist.copy) };
  }, [checklist, folderIdFor, pathById]);
  const actions = useMemo(
    () => keepActionOrder(checklistToActions(resolvedChecklist), folded.actions),
    [resolvedChecklist, folded.actions],
  );
  const blocked = blockedActions(checklist);
  const filing = checklist.move.on || checklist.copy.on;

  const forwardCount = ruleForwards({ actions });
  const otherForwards = forwardsBefore + (ruleStops({ actions, stopProcessing }) ? 0 : forwardsAfter);
  const forwardLimit = typeof maxRedirects === 'number' && maxRedirects > 0 ? maxRedirects : null;
  const forwardOverLimit = forwardLimit !== null && forwardCount + otherForwards > forwardLimit;
  const forwardUnavailable = maxRedirects === 0;
  const forwardLocked = !checklist.forward.on && forwardLimit !== null && forwardCount + otherForwards >= forwardLimit;

  const validConditions = useMemo(() => editedConditions(conditions), [conditions]);

  const tagName = useCallback((id: string) => keywords.find((k) => k.id === id)?.label ?? id, [keywords]);

  const folderName = useCallback((choice: FolderChoice) => {
    const id = folderIdFor(choice);
    const mailbox = id ? mailboxByTargetId.get(id) : undefined;
    return mailbox?.name ?? choice.value.split('/').pop() ?? '';
  }, [folderIdFor, mailboxByTargetId]);

  const folderLabel = useCallback((choice: FolderChoice): string => {
    const id = folderIdFor(choice);
    return (id && displayPathById.get(id)) || choice.value.split('/').join(' / ');
  }, [folderIdFor, displayPathById]);

  const kindLabel = useCallback((kind: ConditionKind) => (
    kind === 'attachment_any'
      ? t('settings.filters.editor.has_attachment')
      : kind === 'attachment_type'
        ? t('settings.filters.editor.attachment_type')
        : t(`settings.filters.condition_fields.${kind}`)
  ), [t]);

  const autoName = useMemo(() => {
    const describe = (c: FilterCondition): string => {
      const value = valueToInputString(c.value);
      if (c.field === 'all') return t('settings.filters.condition_fields.all');
      if (c.field === 'attachment') {
        return c.comparator === 'has_any'
          ? t('settings.filters.editor.has_attachment')
          : `${t('settings.filters.editor.attachment_type')} ${value}`;
      }
      const field = c.field === 'header' ? (c.headerName || t('settings.filters.condition_fields.header')) : t(`settings.filters.condition_fields.${c.field}`);
      return PLAIN_COMPARATORS.has(c.comparator) ? `${field} ${value}` : `${field} ${t(`settings.filters.comparators.${c.comparator}`)} ${value}`;
    };
    const conds = validConditions.length > 0
      ? describe(validConditions[0]) + (validConditions.length > 1 ? ` +${validConditions.length - 1}` : '')
      : '';
    const doing: string[] = [];
    if (checklist.markRead) doing.push(t('settings.filters.action_types.mark_read'));
    if (checklist.star) doing.push(t('settings.filters.action_types.star'));
    if (checklist.tag.on) doing.push(...checklist.tag.ids.map(tagName));
    if (checklist.move.on) doing.push(folderName(checklist.move) || t('settings.filters.action_types.move'));
    if (checklist.copy.on) doing.push(`+ ${folderName(checklist.copy) || t('settings.filters.action_types.copy')}`);
    if (checklist.forward.on) doing.push(`${t('settings.filters.action_types.forward')} ${checklist.forward.to}`.trim());
    if (checklist.keep) doing.push(t('settings.filters.action_types.keep'));
    if (checklist.reject.on) doing.push(t('settings.filters.action_types.reject'));
    if (checklist.discard) doing.push(t('settings.filters.action_types.discard'));
    const joined = [conds, doing.join(', ')].filter(Boolean).join(' → ');
    return (joined || t('settings.filters.new_rule')).slice(0, 200);
  }, [validConditions, checklist, folderName, tagName, t]);

  const activeFrom = periodOn ? periodFromInput(periodStart, start?.activeFrom) : undefined;
  const activeUntil = periodOn ? periodFromInput(periodEnd, start?.activeUntil) : undefined;
  const problem: ChecklistProblem | null = checklistProblem(resolvedChecklist);

  const guardJunk = skipsJunk({ actions, includeSpam: includeSpam && filing });
  const newMailOnly = validConditions.some((c) => c.field === 'delivered_to');
  const previewKey = previewMatches && validConditions.length > 0 && !newMailOnly
    && !validConditions.some(regexInvalid) && activeFrom !== null && activeUntil !== null
    ? JSON.stringify([matchType, validConditions, guardJunk, activeFrom ?? null, activeUntil ?? null])
    : null;
  const [preview, setPreview] = useState<{ key: string; result: RulePreview | null } | null>(null);
  const previewRef = useRef(previewMatches);
  previewRef.current = previewMatches;
  useEffect(() => {
    if (!previewKey || !previewRef.current) return;
    const [type, conds, junk, from, until] = JSON.parse(previewKey) as [FilterRule['matchType'], FilterCondition[], boolean, string | null, string | null];
    let stale = false;
    const timer = setTimeout(() => {
      previewRef.current!(
        {
          id: 'preview', name: '', enabled: true, matchType: type, conditions: conds, actions: [], stopProcessing: false,
          activeFrom: from ?? undefined, activeUntil: until ?? undefined,
        },
        { skipJunk: junk },
      )
        .then((result) => { if (!stale) setPreview({ key: previewKey, result }); })
        .catch(() => { if (!stale) setPreview({ key: previewKey, result: null }); });
    }, PREVIEW_DELAY_MS);
    return () => { stale = true; clearTimeout(timer); };
  }, [previewKey]);
  const previewCurrent = preview && preview.key === previewKey ? preview.result : undefined;
  const previewState: PreviewState = !previewKey
    ? { status: 'off' }
    : previewCurrent === undefined
      ? { status: 'checking' }
      : previewCurrent === null
        ? { status: 'none' }
        : { status: 'done', result: previewCurrent };
  const previewText = previewState.status === 'checking'
    ? t('settings.filters.editor.checking')
    : previewState.status === 'done'
      ? t(
        previewState.result.complete ? 'settings.filters.editor.matching' : 'settings.filters.editor.matching_partial',
        undefined,
        { count: previewState.result.total },
      )
      : null;

  const partial = previewCurrent?.complete === false;
  const counted = (n: number) => (n === 0 && partial ? null : `${n}${partial ? '+' : ''}`);
  const applyLabel = (key: 'apply_folder' | 'apply_all', count: string | null, folder = '') =>
    count === null
      ? t(`settings.filters.editor.${key}`, undefined, { folder })
      : t(`settings.filters.editor.${key}_count`, undefined, { folder, count });
  const applyOffered = offerApplyToExisting && !!previewCurrent && (previewCurrent.total > 0 || partial)
    && appliesToExisting({ actions, conditions: validConditions });
  const folderOffered = applyOffered && applyExistingFolder !== undefined && previewCurrent?.inFolder !== undefined;
  const folderUsable = folderOffered && ((previewCurrent?.inFolder ?? 0) > 0 || partial);
  const effectiveApply: ApplyScope = !applyOffered ? 'new' : applyTo === 'folder' && !folderUsable ? 'new' : applyTo;
  const applyOptions: ApplyOption[] = !applyOffered ? [] : [
    { value: 'new', label: t('settings.filters.editor.apply_new'), disabled: false },
    ...(folderOffered
      ? [{ value: 'folder' as const, label: applyLabel('apply_folder', counted(previewCurrent!.inFolder!), applyExistingFolder), disabled: !folderUsable }]
      : []),
    { value: 'all', label: applyLabel('apply_all', counted(previewCurrent!.total)), disabled: false },
  ];

  const periodProblem = periodOn ? periodError(activeFrom, activeUntil) : null;
  const errors: Record<ErrorSection, string | null> = {
    conditions: validConditions.length === 0
      ? t('settings.filters.validation_empty_conditions')
      : validConditions.some((c) => c.field === 'header' && !isValidSieveHeaderName(c.headerName ?? ''))
        ? t('settings.filters.validation_header_name')
        : validConditions.some(regexInvalid)
          ? t('settings.filters.validation_regex')
          : validConditions.some(attachmentTypeInvalid)
            ? t('settings.filters.editor.attachment_type_invalid')
            : null,
    actions: problem === null
      ? null
      : problem === 'conflict'
        ? t('settings.filters.editor.action_conflict')
        : t(`settings.filters.${{
          none: 'validation_empty_actions',
          tag: 'validation_action_tag',
          copy: 'validation_action_folder',
          move: 'validation_action_folder',
          forward: 'validation_action_forward',
          reject: 'validation_action_reject',
        }[problem]}`),
    period: periodProblem === null
      ? null
      : t({
        invalid: 'settings.filters.validation_period_invalid',
        empty: 'settings.filters.validation_period_empty',
        order: 'settings.filters.validation_period_order',
      }[periodProblem]),
  };
  const shownErrors: Record<ErrorSection, string | null> = showErrors ? errors : { conditions: null, actions: null, period: null };
  const firstError: ErrorSection | null = !showErrors
    ? null
    : (['conditions', 'actions', 'period'] as ErrorSection[]).find((section) => errors[section]) ?? null;

  const conditionInvalid = (c: FilterCondition) => !!shownErrors.conditions && (
    (validConditions.length === 0 && !takesNoValue(c)
      && isConditionValueEmpty(typeof c.value === 'string' && !usesRegex(c) ? inputStringToValue(c.value) : c.value))
    || regexInvalid(c)
    || attachmentTypeInvalid(c)
  );
  const headerInvalid = (c: FilterCondition) => !!shownErrors.conditions && c.field === 'header'
    && !isConditionValueEmpty(c.value) && !isValidSieveHeaderName((c.headerName ?? '').trim());
  const actionInvalid = (key: ChecklistKey) => !!shownErrors.actions && problem === key;

  const conditionRows = conditions.map((condition, index) => {
    const kind = kindOf(condition);
    const offered = kindComparators(kind, regexSupported || condition.comparator === 'regex');
    const comparators = offered.length > 0 && !offered.includes(condition.comparator) ? [...offered, condition.comparator] : offered;
    return {
      index,
      condition,
      kind,
      kindLabel: kindLabel(kind),
      comparators,
      size: condition.field === 'size' ? parseSize(valueToInputString(condition.value)) : null,
      takesValue: !takesNoValue(condition),
      text: valueToInputString(condition.value),
      placeholder: kind === 'attachment_type'
        ? t('settings.filters.attachment_type_placeholder')
        : usesRegex(condition)
          ? t('settings.filters.regex_placeholder')
          : t('ux_p3_words.filter_value_placeholder'),
      hint: usesRegex(condition) || kind === 'attachment_type' ? undefined : t('ux_p3_words.filter_values_hint'),
      invalid: conditionInvalid(condition),
      headerInvalid: headerInvalid(condition),
      removable: conditions.length > 1,
    };
  });

  const updateCondition = (index: number, next: FilterCondition) =>
    setConditions((prev) => prev.map((c, i) => (i === index ? next : c)));

  const conditionActions = {
    setKind: (index: number, kind: ConditionKind) => updateCondition(index, withKind(conditions[index], kind, regexSupported)),
    setComparator: (index: number, comparator: FilterComparator) => updateCondition(index, { ...conditions[index], comparator }),
    setHeaderName: (index: number, headerName: string) => updateCondition(index, { ...conditions[index], headerName }),
    setText: (index: number, text: string) => updateCondition(index, { ...conditions[index], value: text }),
    commitText: (index: number) => {
      const condition = conditions[index];
      if (!condition || usesRegex(condition) || condition.field === 'size' || takesNoValue(condition)) return;
      const parsed = inputStringToValue(valueToInputString(condition.value));
      if (JSON.stringify(parsed) !== JSON.stringify(condition.value)) updateCondition(index, { ...condition, value: parsed });
    },
    setSizeAmount: (index: number, amount: string) => {
      const size = parseSize(valueToInputString(conditions[index].value));
      updateCondition(index, { ...conditions[index], value: formatSize(amount, size.unit) || amount });
    },
    setSizeUnit: (index: number, unit: SizeUnit) => {
      const size = parseSize(valueToInputString(conditions[index].value));
      updateCondition(index, { ...conditions[index], value: formatSize(size.amount, unit) });
    },
    add: () => setConditions((prev) => [...prev, emptyCondition()]),
    remove: (index: number) => setConditions((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index))),
  };

  const update = (patch: Partial<Checklist>) => setChecklist((prev) => ({ ...prev, ...patch }));
  const toggle = (key: ChecklistKey, on: boolean) => {
    if (on && (blocked.has(key) || (key === 'forward' && forwardLocked))) return;
    setChecklist((prev) => {
      const value = prev[key];
      return { ...prev, [key]: typeof value === 'boolean' ? on : { ...value, on } };
    });
  };
  const tagIds = useMemo(() => {
    const ids = keywords.map((k) => k.id);
    for (const id of checklist.tag.ids) if (!ids.includes(id)) ids.push(id);
    return ids;
  }, [keywords, checklist.tag.ids]);

  const actionControls = {
    toggle,
    toggleTag: (id: string) => {
      const ids = checklist.tag.ids.includes(id) ? checklist.tag.ids.filter((x) => x !== id) : [...checklist.tag.ids, id];
      update({ tag: { on: ids.length > 0, ids } });
    },
    pickFolder: (which: 'move' | 'copy', targetId: string) => {
      update({ [which]: { on: !blocked.has(which), mailboxId: targetId, value: pathById.get(targetId) ?? '' } });
    },
    setForwardTo: (to: string) => update({
      forward: { ...checklist.forward, to, on: !forwardLocked && to.trim() ? true : checklist.forward.on },
    }),
    setForwardKeepCopy: (keepCopy: boolean) => update({ forward: { ...checklist.forward, keepCopy } }),
    setRejectMessage: (message: string) => update({
      reject: { message, on: !blocked.has('reject') && (message.trim() ? true : checklist.reject.on) },
    }),
  };

  const save = async (): Promise<boolean> => {
    setSaveAttempt((n) => n + 1);
    if (Object.values(errors).some(Boolean)) {
      setShowErrors(true);
      return false;
    }
    if (effectiveApply !== 'new' && actions.some((a) => a.type === 'discard') && confirmTrash) {
      const count = (effectiveApply === 'folder' ? previewCurrent?.inFolder : previewCurrent?.total) ?? 0;
      const confirmed = await confirmTrash({
        title: t('settings.filters.editor.trash_title'),
        message: t(partial ? 'settings.filters.editor.trash_confirm_partial' : 'settings.filters.editor.trash_confirm', undefined, { count }),
        confirm: t('settings.filters.editor.trash_button'),
        cancel: t('settings.filters.cancel'),
      });
      if (!confirmed) return false;
    }
    onSave({
      id: start?.id || generateUUID(),
      name: name.trim() || autoName,
      enabled,
      matchType,
      conditions: validConditions,
      actions,
      stopProcessing,
      includeSpam: includeSpam && filing ? true : undefined,
      activeFrom: activeFrom ?? undefined,
      activeUntil: activeUntil ?? undefined,
    }, { applyTo: effectiveApply });
    return true;
  };

  return {
    isEdit,
    dirty,
    name, setName, autoName,
    matchType, setMatchType,
    conditionRows, conditionActions,
    checklist, blocked, filing, tagIds, tagName, folderIdFor, folderLabel, actionControls, actionInvalid,
    showsTagRow: tagIds.length > 0 || checklist.tag.on,
    showsForwardRow: !forwardUnavailable || checklist.forward.on,
    showsKeepRow: folded.actions.some((a) => a.type === 'keep') || checklist.keep,
    forwardLocked, forwardOverLimit, forwardUnavailable, forwardCount, forwardLimit,
    stopProcessing, setContinue: (on: boolean) => setStopProcessing(!on),
    enabled, setSkip: (on: boolean) => setEnabled(!on),
    includeSpam, setIncludeSpam,
    periodShown: periodsSupported || hadPeriod,
    periodOn, setPeriodOn, periodStart, setPeriodStart, periodEnd, setPeriodEnd,
    newMailOnly, previewState, previewText, previewOpen, setPreviewOpen,
    applyOptions, effectiveApply, setApplyTo,
    errors: shownErrors, firstError, saveAttempt,
    save,
  };
}

export type RuleEditorState = ReturnType<typeof useRuleEditor>;
