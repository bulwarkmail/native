import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Alert,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { X, Plus, Trash2 } from '../icons';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { Select, ToggleSwitch } from '../settings/settings-section';
import Input from '../Input';
import Button from '../Button';
import { useLocaleStore } from '../../stores/locale-store';
import { useKeywordsStore } from '../../stores/keywords-store';
import { generateUUID } from '../../lib/uuid';
import {
  comparatorsFor,
  inputStringToValue,
  isConditionValueEmpty,
  takesNoValue,
  valueToInputString,
} from '../../lib/sieve/condition-value';
import {
  ACTIONS_WITH_MAILBOX,
  ACTIONS_WITH_VALUE,
  buildMailboxTargets,
  mailboxIdFor,
  selectMailboxTarget,
  updateFilterAction,
  withMailboxTarget,
} from '../../lib/sieve/rule-actions';
import { isValidSieveHeaderName } from '../../lib/sieve/generator';
import { hasPeriod } from '../../lib/sieve/period';
import { periodError, periodFromInput, periodToInput } from '../../lib/sieve/rule-period';
import type { Mailbox } from '../../api/types';
import type {
  FilterRule,
  FilterCondition,
  FilterAction,
  FilterConditionField,
  FilterComparator,
  FilterActionType,
} from '../../lib/sieve/types';
import { SafeAreaModal } from '../SafeAreaModal';
import { useFilterStore } from '../../stores/filter-store';
import { forwardsOfEditedRule, ruleForwardLimit } from '../../lib/sieve/forward-limit';
import { MODAL_ORIENTATIONS } from '../../lib/modal-orientations';
import { useModalKeyboardPadding } from '../../lib/sheet-bottom-inset';

const ALL_FIELDS: FilterConditionField[] = ['from', 'to', 'cc', 'subject', 'header', 'size', 'body', 'attachment', 'all'];

const isHasAny = takesNoValue;

function seedConditions(rule?: FilterRule): FilterCondition[] {
  return rule?.conditions.length ? rule.conditions.map((cond) => ({ ...cond })) : [makeEmptyCondition()];
}
function seedActions(rule?: FilterRule): FilterAction[] {
  return rule?.actions.length ? rule.actions.map((a) => ({ ...a })) : [makeEmptyAction()];
}
const ALL_ACTION_TYPES: FilterActionType[] = ['move', 'copy', 'forward', 'mark_read', 'star', 'add_label', 'discard', 'reject', 'keep', 'stop'];

function makeEmptyCondition(): FilterCondition {
  return { field: 'from', comparator: 'contains', value: '' };
}
function makeEmptyAction(): FilterAction {
  return { type: 'move', value: '' };
}

interface FilterRuleModalProps {
  visible: boolean;
  /** The rule being edited. */
  rule?: FilterRule;
  /** A new rule that starts from these values ("Create rule..." on a message). */
  initialRule?: FilterRule;
  mailboxes: Mailbox[];
  /** The server can confine a rule to a period (Sieve "date" and "relational"). */
  periodsSupported?: boolean;
  /**
   * The server's cap on forwards per message, and the forwards a message can
   * have collected when it reaches this rule / still collect below it (see
   * lib/sieve/forward-limit.ts). Left out: read from the filter list the
   * Filters settings show.
   */
  forwardContext?: { maxRedirects: number | null | undefined; before: number; after: number };
  onSave: (rule: FilterRule) => void;
  onClose: () => void;
}

export function FilterRuleModal({
  visible, rule: editedRule, initialRule, mailboxes, periodsSupported = false, forwardContext, onSave, onClose,
}: FilterRuleModalProps) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  // The Android dialog doesn't shrink for the keyboard; the body ends above it.
  const keyboardPadding = useModalKeyboardPadding(visible);
  const keywords = useKeywordsStore((s) => s.keywords);
  const isEdit = !!editedRule;
  const rule = editedRule ?? initialRule;

  const [name, setName] = useState(rule?.name || '');
  const [matchType, setMatchType] = useState<'all' | 'any'>(rule?.matchType || 'all');
  const [conditions, setConditions] = useState<FilterCondition[]>(() => seedConditions(rule));
  const [actions, setActions] = useState<FilterAction[]>(() => seedActions(rule));
  const [stopProcessing, setStopProcessing] = useState(rule?.stopProcessing ?? false);
  const [includeSpam, setIncludeSpam] = useState(rule?.includeSpam ?? false);
  const hadPeriod = !!rule && hasPeriod(rule);
  const [periodOn, setPeriodOn] = useState(hadPeriod);
  const [periodStart, setPeriodStart] = useState(periodToInput(rule?.activeFrom));
  const [periodEnd, setPeriodEnd] = useState(periodToInput(rule?.activeUntil));

  // The Modal stays mounted between opens, so re-seed every field whenever it
  // is (re)opened for a different rule - otherwise "Add Rule" after editing
  // shows the previous rule and editing rule B saves rule A's fields under
  // B's id. Mirrors SieveEditorSheet, which re-seeds on `visible`.
  useEffect(() => {
    if (!visible) return;
    setName(rule?.name || '');
    setMatchType(rule?.matchType || 'all');
    setConditions(seedConditions(rule));
    setActions(seedActions(rule));
    setStopProcessing(rule?.stopProcessing ?? false);
    setIncludeSpam(rule?.includeSpam ?? false);
    setPeriodOn(!!rule && hasPeriod(rule));
    setPeriodStart(periodToInput(rule?.activeFrom));
    setPeriodEnd(periodToInput(rule?.activeUntil));
  }, [visible, rule]);

  const activeFrom = periodOn ? periodFromInput(periodStart, rule?.activeFrom) : undefined;
  const activeUntil = periodOn ? periodFromInput(periodEnd, rule?.activeUntil) : undefined;
  const periodProblem = periodOn ? periodError(activeFrom, activeUntil) : null;

  const mailboxTargets = useMemo(() => buildMailboxTargets(mailboxes), [mailboxes]);

  // A message can collect only so many forwards on the server (#1155, #1208).
  const listedRules = useFilterStore((s) => s.rules);
  const listedForward = useFilterStore((s) => s.vacationForward);
  const listedMaxRedirects = useFilterStore((s) => s.sieveCapabilities?.maxNumberRedirects);
  const listedAround = useMemo(
    () => forwardsOfEditedRule(listedRules, listedForward, editedRule?.id),
    [listedRules, listedForward, editedRule?.id],
  );
  const forwardLimit = ruleForwardLimit(
    { actions, stopProcessing },
    forwardContext ? forwardContext.maxRedirects : listedMaxRedirects,
    forwardContext ?? listedAround,
  );
  const ruleForwardCount = actions.filter((a) => a.type === 'forward').length;
  const actionOptionsFor = (action: FilterAction) =>
    action.type === 'forward' || forwardLimit.canAddForward
      ? actionTypeOptions
      : actionTypeOptions.filter((o) => o.value !== 'forward');

  const fieldOptions = useMemo(
    () => ALL_FIELDS.map((f) => ({ value: f, label: t(`settings.filters.condition_fields.${f}`, f) })),
    [t],
  );
  const actionTypeOptions = useMemo(
    () => ALL_ACTION_TYPES.map((a) => ({ value: a, label: t(`settings.filters.action_types.${a}`, a) })),
    [t],
  );
  const keywordOptions = useMemo(
    () => keywords.map((kw) => ({ value: kw.id, label: kw.label })),
    [keywords],
  );

  const comparatorOptions = useCallback(
    (field: FilterConditionField) =>
      comparatorsFor(field).map((cmp) => ({
        value: cmp,
        label: t(`settings.filters.comparators.${cmp}`, cmp),
      })),
    [t],
  );

  const updateCondition = (index: number, updates: Partial<FilterCondition>) => {
    setConditions((prev) =>
      prev.map((cond, i) => {
        if (i !== index) return cond;
        const updated = { ...cond, ...updates };
        // Reconcile the comparator when the field family changes so a size
        // rule never keeps "contains" and an attachment rule never keeps
        // "greater than".
        if (updates.field && !comparatorsFor(updates.field).includes(updated.comparator)) {
          updated.comparator = comparatorsFor(updates.field)[0];
        }
        if (updates.field && updates.field !== 'header') {
          delete updated.headerName;
        }
        if (isHasAny(updated)) {
          updated.value = '';
        }
        return updated;
      }),
    );
  };

  const removeCondition = (index: number) => {
    if (conditions.length <= 1) return;
    setConditions((prev) => prev.filter((_, i) => i !== index));
  };

  const updateAction = (index: number, updates: Partial<FilterAction>) => {
    setActions((prev) =>
      prev.map((act, i) => (i === index ? updateFilterAction(act, updates, mailboxTargets) : act)),
    );
  };

  const selectFolder = (index: number, id: string) => {
    setActions((prev) =>
      prev.map((act, i) => (i === index ? selectMailboxTarget(act, id, mailboxTargets) : act)),
    );
  };

  // Folder picker rows for an action. A folder the rule points at that isn't
  // listed (deleted, or its account's folders not loaded) stays selectable
  // under its path, so saving doesn't silently retarget the rule.
  const folderOptions = (action: FilterAction) => {
    const options = mailboxTargets.map((target) => ({ value: target.id, label: target.label }));
    const selected = mailboxIdFor(action, mailboxTargets);
    if (!options.some((o) => o.value === selected) && (selected || action.value)) {
      options.unshift({ value: selected, label: action.value || selected });
    }
    return options;
  };

  const removeAction = (index: number) => {
    if (actions.length <= 1) return;
    setActions((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSave = useCallback(() => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      Alert.alert(t('settings.filters.validation_empty_name', 'Rule name is required'));
      return;
    }
    // While editing, condition.value is the raw string typed into the input
    // (commas not yet split). Convert to array form here on save so a user
    // typing "a, b, c" persists ["a","b","c"]; splitting on every keystroke
    // would eat the comma the moment it is typed.
    const validConditions = conditions
      .filter((cond) => isHasAny(cond) || !isConditionValueEmpty(cond.value))
      .map((cond) => {
        if (isHasAny(cond)) return { ...cond, value: '' };
        if (cond.field === 'size') return cond; // numeric, single-value only
        // A keyboard's trailing space is never part of a header name.
        const named = cond.field === 'header' ? { ...cond, headerName: cond.headerName?.trim() } : cond;
        if (typeof named.value !== 'string') return named; // already structured
        return { ...named, value: inputStringToValue(named.value) };
      });
    if (validConditions.length === 0) {
      Alert.alert(t('settings.filters.validation_empty_conditions', 'At least one condition with a value is required'));
      return;
    }
    // The server refuses the whole filter script over one header name it
    // can't read (a space, a dot or a colon in it), so say so here.
    if (validConditions.some((cond) => cond.field === 'header' && !isValidSieveHeaderName(cond.headerName ?? ''))) {
      Alert.alert(t(
        'settings.filters.validation_header_name',
        'Enter a header name that uses only the letters A-Z, digits, hyphens and underscores, such as X-Spam-Flag.',
      ));
      return;
    }
    const validActions = actions
      .map((a) => withMailboxTarget(a, mailboxTargets))
      .filter((a) => !ACTIONS_WITH_VALUE.has(a.type) || a.value?.trim());
    if (validActions.length === 0) {
      Alert.alert(t('settings.filters.validation_empty_actions', 'At least one action is required'));
      return;
    }
    if (periodProblem) {
      Alert.alert(periodProblem === 'invalid'
        ? t('settings.filters.validation_period_invalid', 'Enter a valid date with a time for the period, or leave the field empty')
        : periodProblem === 'empty'
          ? t('settings.filters.validation_period_empty', 'Enter a start or end date for the period')
          : t('settings.filters.validation_period_order', 'End date must be after start date'));
      return;
    }
    onSave({
      id: rule?.id || generateUUID(),
      name: trimmedName,
      enabled: rule?.enabled ?? true,
      matchType,
      conditions: validConditions,
      actions: validActions,
      stopProcessing,
      // Only folder moves are kept out of Junk, so the opt-in only means
      // something (and is only stored) while the rule has one.
      ...(includeSpam && validActions.some((a) => ACTIONS_WITH_MAILBOX.has(a.type)) ? { includeSpam: true } : {}),
      // Set to undefined when off: the settings page merges the result into
      // the stored rule, and a field left out would keep its old value there.
      activeFrom: activeFrom ?? undefined,
      activeUntil: activeUntil ?? undefined,
    });
  }, [
    name, conditions, actions, matchType, stopProcessing, includeSpam, rule, onSave, t, mailboxTargets,
    periodProblem, activeFrom, activeUntil,
  ]);

  return (
    <SafeAreaModal supportedOrientations={MODAL_ORIENTATIONS} visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <Pressable
            onPress={onClose}
            hitSlop={8}
            style={styles.headerClose}
            accessibilityRole="button"
            accessibilityLabel={t('common.close', 'Close')}
          >
            <X size={20} color={c.text} />
          </Pressable>
          <Text style={styles.headerTitle}>
            {isEdit ? t('settings.filters.edit_rule', 'Edit Rule') : t('settings.filters.new_rule', 'New Rule')}
          </Text>
          <View style={styles.headerRightSpacer} />
        </View>

        <KeyboardAvoidingView
          style={{ flex: 1, paddingBottom: keyboardPadding }}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            {/* Name */}
            <View>
              <Text style={styles.label}>{t('settings.filters.rule_name', 'Rule Name')}</Text>
              <Input
                value={name}
                onChangeText={setName}
                placeholder={t('settings.filters.rule_name_placeholder', 'e.g., Sort newsletters')}
                // Named by its label, not the example in the placeholder
                // (webmail filter-rule-modal.tsx).
                accessibilityLabel={t('settings.filters.rule_name', 'Rule Name')}
                maxLength={200}
              />
            </View>

            {/* Match type */}
            <View>
              <Text style={styles.label}>{t('settings.filters.match_type', 'Match type')}</Text>
              <View style={styles.matchRow}>
                {(['all', 'any'] as const).map((mt) => {
                  const selected = matchType === mt;
                  return (
                    <Pressable
                      key={mt}
                      onPress={() => setMatchType(mt)}
                      style={[styles.matchBtn, selected ? styles.matchBtnOn : styles.matchBtnOff]}
                    >
                      <Text style={selected ? styles.matchTextOn : styles.matchTextOff}>
                        {mt === 'all'
                          ? t('settings.filters.match_all', 'Match ALL conditions')
                          : t('settings.filters.match_any', 'Match ANY condition')}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>
            </View>

            {/* Conditions */}
            <View>
              <Text style={styles.label}>{t('settings.filters.conditions', 'Conditions')}</Text>
              <View style={{ gap: spacing.sm }}>
                {conditions.map((condition, index) => (
                  <View key={index} style={styles.card}>
                    <View style={styles.cardTopRow}>
                      <Select
                        value={condition.field}
                        onChange={(v) => updateCondition(index, { field: v as FilterConditionField })}
                        options={fieldOptions}
                        style={{ flex: 1 }}
                      />
                      <Pressable
                        onPress={() => removeCondition(index)}
                        disabled={conditions.length <= 1}
                        hitSlop={8}
                        style={[styles.removeBtn, conditions.length <= 1 && styles.removeBtnDisabled]}
                        accessibilityRole="button"
                        accessibilityLabel={t('settings.filters.remove_condition', 'Remove condition')}
                      >
                        <Trash2 size={16} color={c.mutedForeground} />
                      </Pressable>
                    </View>

                    {condition.field === 'header' && (
                      <Input
                        value={condition.headerName || ''}
                        onChangeText={(v) => updateCondition(index, { headerName: v })}
                        placeholder={t('settings.filters.header_name', 'Header name')}
                        autoCapitalize="none"
                        autoCorrect={false}
                      />
                    )}

                    {condition.field !== 'all' && (
                      <Select
                        value={condition.comparator}
                        onChange={(v) => updateCondition(index, { comparator: v as FilterComparator })}
                        options={comparatorOptions(condition.field)}
                        style={{ alignSelf: 'flex-start' }}
                      />
                    )}

                    {/* has_any and "all messages" take no value. */}
                    {!isHasAny(condition) && (
                      <Input
                        value={valueToInputString(condition.value)}
                        onChangeText={(v) => updateCondition(index, { value: v })}
                        placeholder={
                          condition.field === 'size'
                            ? t('settings.filters.size_placeholder', 'e.g., 1000000')
                            : condition.field === 'attachment'
                              ? t('settings.filters.attachment_type_placeholder', 'e.g. pdf, doc, jpg')
                              : t('settings.filters.value_placeholder_multi', 'Value (multiple separated by commas)')
                        }
                        keyboardType={condition.field === 'size' ? 'numeric' : 'default'}
                        autoCapitalize="none"
                        accessibilityLabel={t('settings.filters.condition_value', 'Condition value')}
                      />
                    )}
                  </View>
                ))}
              </View>
              <Pressable
                onPress={() => setConditions((prev) => [...prev, makeEmptyCondition()])}
                style={styles.addRow}
              >
                <Plus size={14} color={c.primary} />
                <Text style={styles.addText}>{t('settings.filters.add_condition', 'Add Condition')}</Text>
              </Pressable>
            </View>

            {/* Actions */}
            <View>
              <Text style={styles.label}>{t('settings.filters.actions', 'Actions')}</Text>
              <View style={{ gap: spacing.sm }}>
                {actions.map((action, index) => (
                  <View key={index} style={styles.card}>
                    <View style={styles.cardTopRow}>
                      <Select
                        value={action.type}
                        onChange={(v) => updateAction(index, { type: v as FilterActionType })}
                        options={actionOptionsFor(action)}
                        style={{ flex: 1 }}
                      />
                      <Pressable
                        onPress={() => removeAction(index)}
                        disabled={actions.length <= 1}
                        hitSlop={8}
                        style={[styles.removeBtn, actions.length <= 1 && styles.removeBtnDisabled]}
                        accessibilityRole="button"
                        accessibilityLabel={t('settings.filters.remove_action', 'Remove action')}
                      >
                        <Trash2 size={16} color={c.mutedForeground} />
                      </Pressable>
                    </View>

                    {ACTIONS_WITH_MAILBOX.has(action.type) && (
                      mailboxTargets.length > 0 ? (
                        <Select
                          value={mailboxIdFor(action, mailboxTargets)}
                          onChange={(id) => selectFolder(index, id)}
                          options={folderOptions(action)}
                          style={{ alignSelf: 'stretch' }}
                        />
                      ) : (
                        // Typing a path by hand drops the folder id it replaces.
                        <Input
                          value={action.value || ''}
                          onChangeText={(v) => updateAction(index, { value: v, mailboxId: undefined })}
                          placeholder={t('settings.filters.move_to_folder', 'Select folder')}
                        />
                      )
                    )}

                    {action.type === 'forward' && (
                      <>
                        <Input
                          value={action.value || ''}
                          onChangeText={(v) => updateAction(index, { value: v })}
                          placeholder={t('settings.filters.forward_placeholder', 'email@example.com')}
                          keyboardType="email-address"
                          autoCapitalize="none"
                        />
                        <View style={styles.optionRow}>
                          <Text style={styles.optionLabel}>
                            {t('settings.filters.forward_keep_copy', 'Keep a copy')}
                          </Text>
                          <ToggleSwitch
                            checked={!!action.keepCopy}
                            onChange={(v) => updateAction(index, { keepCopy: v || undefined })}
                            accessibilityLabel={t('settings.filters.forward_keep_copy', 'Keep a copy')}
                          />
                        </View>
                      </>
                    )}

                    {action.type === 'reject' && (
                      <Input
                        value={action.value || ''}
                        onChangeText={(v) => updateAction(index, { value: v })}
                        placeholder={t('settings.filters.reject_placeholder', 'Your email has been rejected')}
                      />
                    )}

                    {action.type === 'add_label' && (
                      keywordOptions.length > 0 ? (
                        <Select
                          value={action.value || ''}
                          onChange={(v) => updateAction(index, { value: v })}
                          options={keywordOptions}
                          style={{ alignSelf: 'stretch' }}
                        />
                      ) : (
                        <Input
                          value={action.value || ''}
                          onChangeText={(v) => updateAction(index, { value: v })}
                          placeholder={t('settings.filters.label_placeholder', 'Select tag')}
                        />
                      )
                    )}
                  </View>
                ))}
              </View>
              {forwardLimit.unavailable && ruleForwardCount > 0 && (
                <Text style={styles.forwardWarning}>
                  {t('settings.filters.forward_unavailable', 'This server does not allow forwarding. Forward actions in filter rules have no effect.')}
                </Text>
              )}
              {forwardLimit.overLimit && (
                <Text style={styles.forwardWarning}>
                  {t('settings.filters.forward_limit', 'Forward limit per message on this server: {count}. Extra forwards are skipped.', { count: forwardLimit.limit ?? 0 })}
                </Text>
              )}
              <Pressable
                onPress={() => setActions((prev) => [...prev, makeEmptyAction()])}
                style={styles.addRow}
              >
                <Plus size={14} color={c.primary} />
                <Text style={styles.addText}>{t('settings.filters.add_action', 'Add Action')}</Text>
              </Pressable>
            </View>

            {/* Stop processing */}
            <View style={styles.stopRow}>
              <Text style={styles.stopLabel}>
                {t('settings.filters.stop_processing', 'Stop processing subsequent rules')}
              </Text>
              <ToggleSwitch
                checked={stopProcessing}
                onChange={setStopProcessing}
                accessibilityLabel={t('settings.filters.stop_processing', 'Stop processing subsequent rules')}
              />
            </View>

            {/* Folder rules skip spam unless the rule opts in (webmail 6241ed61). */}
            {actions.some((a) => ACTIONS_WITH_MAILBOX.has(a.type)) && (
              <View style={styles.stopRow}>
                <Text style={styles.stopLabel}>
                  {t('settings.filters.include_spam', 'Also move messages marked as spam')}
                </Text>
                <ToggleSwitch
                  checked={includeSpam}
                  onChange={setIncludeSpam}
                  accessibilityLabel={t('settings.filters.include_spam', 'Also move messages marked as spam')}
                />
              </View>
            )}

            {/* Offered where the server supports it; a rule that already has a
                period always shows it, so it can be removed. */}
            {(periodsSupported || hadPeriod) && (
              <View style={{ gap: spacing.sm }}>
                <View style={styles.stopRow}>
                  <Text style={styles.stopLabel}>
                    {t('settings.filters.period_toggle', 'Only active during a period')}
                  </Text>
                  <ToggleSwitch
                    checked={periodOn}
                    onChange={setPeriodOn}
                    accessibilityLabel={t('settings.filters.period_toggle', 'Only active during a period')}
                  />
                </View>
                {periodOn && (
                  <>
                    <Text style={styles.optionLabel}>{t('settings.filters.period_start', 'Start date')}</Text>
                    <Input
                      value={periodStart}
                      onChangeText={setPeriodStart}
                      placeholder="YYYY-MM-DD HH:MM"
                      accessibilityLabel={t('settings.filters.period_start', 'Start date')}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <Text style={styles.optionLabel}>{t('settings.filters.period_end', 'End date')}</Text>
                    <Input
                      value={periodEnd}
                      onChangeText={setPeriodEnd}
                      placeholder="YYYY-MM-DD HH:MM"
                      accessibilityLabel={t('settings.filters.period_end', 'End date')}
                      autoCapitalize="none"
                      autoCorrect={false}
                    />
                    <Text style={styles.hint}>
                      {t('settings.filters.period_hint', 'Applies to messages that arrive during this period. Leave a field empty to keep that end open.')}
                    </Text>
                  </>
                )}
              </View>
            )}
          </ScrollView>
        </KeyboardAvoidingView>

        <View style={styles.footer}>
          <Button variant="outline" onPress={onClose}>
            {t('settings.filters.cancel', 'Cancel')}
          </Button>
          <Button onPress={handleSave} disabled={!name.trim()}>
            {t('settings.filters.save', 'Save')}
          </Button>
        </View>
      </SafeAreaView>
    </SafeAreaModal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      height: componentSizes.headerHeight,
      paddingHorizontal: spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      gap: spacing.sm,
    },
    headerClose: {
      width: 40, height: 40,
      alignItems: 'center', justifyContent: 'center',
      borderRadius: radius.md,
    },
    headerTitle: { ...typography.h3, color: c.text, flex: 1, textAlign: 'center' },
    headerRightSpacer: { width: 40 },

    body: { padding: spacing.lg, gap: spacing.xl, paddingBottom: spacing.xxxl },
    label: { ...typography.bodyMedium, color: c.text, marginBottom: spacing.sm },

    matchRow: { flexDirection: 'row', gap: spacing.sm },
    matchBtn: { paddingHorizontal: spacing.md, paddingVertical: 8, borderRadius: radius.sm },
    matchBtnOn: { backgroundColor: c.primary },
    matchBtnOff: { backgroundColor: c.muted },
    matchTextOn: { ...typography.caption, color: c.primaryForeground, fontWeight: '500' },
    matchTextOff: { ...typography.caption, color: c.text },

    card: {
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
    },
    cardTopRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    removeBtn: {
      width: 36, height: 36,
      alignItems: 'center', justifyContent: 'center',
      borderRadius: radius.sm,
    },
    removeBtnDisabled: { opacity: 0.3 },

    addRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: spacing.sm },
    addText: { ...typography.body, color: c.primary, fontWeight: '500' },

    stopRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
    },
    stopLabel: { ...typography.body, color: c.text, flex: 1 },

    optionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
    },
    optionLabel: { ...typography.body, color: c.text, flex: 1 },
    hint: { ...typography.caption, color: c.mutedForeground },
    forwardWarning: { ...typography.caption, color: c.warning, marginTop: spacing.sm },

    footer: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
  });
}
