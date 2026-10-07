import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Modal, Alert,
  KeyboardAvoidingView, Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { X, Plus, Trash2 } from 'lucide-react-native';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { Select, ToggleSwitch } from '../settings/settings-section';
import Input from '../Input';
import Button from '../Button';
import { useLocaleStore } from '../../stores/locale-store';
import { useKeywordsStore } from '../../stores/keywords-store';
import { generateUUID } from '../../lib/uuid';
import { isValueLessCondition, valueToInputString } from '../../lib/sieve/condition-value';
import {
  CONDITION_FIELDS,
  comparatorsFor,
  conditionForField,
  conditionsToSave,
  isValidSizeValue,
} from '../../lib/sieve/condition-options';
import {
  ACTIONS_WITH_MAILBOX,
  ACTIONS_WITH_VALUE,
  buildMailboxTargets,
  mailboxIdFor,
  selectMailboxTarget,
  updateFilterAction,
  withMailboxTarget,
} from '../../lib/sieve/rule-actions';
import { applySuggestion } from '../../lib/filters/rule-suggestions';
import { retroactiveSupport } from '../../lib/filters/retroactive';
import { modalForwardState } from '../../lib/filters/forward-limit-view';
import type { RuleSuggestion } from '../../lib/filters/quick-rules';
import type { Mailbox } from '../../api/types';
import type {
  FilterRule,
  FilterCondition,
  FilterAction,
  FilterConditionField,
  FilterComparator,
  FilterActionType,
} from '../../lib/sieve/types';

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
  /** Edit this rule in place. */
  rule?: FilterRule;
  /** A starting point that saves as a new rule (ignored when `rule` is given). */
  initialRule?: FilterRule;
  /** One-tap conditions offered as chips. */
  suggestions?: RuleSuggestion[];
  /** Offer "also apply to existing messages". */
  offerApplyToExisting?: boolean;
  mailboxes: Mailbox[];
  /** The server's redirect limit for this rule's account (maxNumberRedirects). */
  maxRedirects?: number | null;
  /** Forwards a message can have collected when it reaches this rule. */
  forwardsBefore?: number;
  /** The most forwards it can still collect below this rule. */
  forwardsAfter?: number;
  onSave: (rule: FilterRule, options?: { applyToExisting: boolean }) => void;
  onClose: () => void;
}

export function FilterRuleModal({
  visible, rule, initialRule, suggestions, offerApplyToExisting, mailboxes, maxRedirects, forwardsBefore, forwardsAfter,
  onSave, onClose,
}: FilterRuleModalProps) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const keywords = useKeywordsStore((s) => s.keywords);
  const isEdit = !!rule;
  // An edit starts from `rule`; a prefill starts from `initialRule` and saves as a new rule.
  const start = rule ?? initialRule;

  const [name, setName] = useState(start?.name || '');
  const [matchType, setMatchType] = useState<'all' | 'any'>(start?.matchType || 'all');
  const [conditions, setConditions] = useState<FilterCondition[]>(() => seedConditions(start));
  const [actions, setActions] = useState<FilterAction[]>(() => seedActions(start));
  const [stopProcessing, setStopProcessing] = useState(start?.stopProcessing ?? false);
  const [includeSpam, setIncludeSpam] = useState(start?.includeSpam ?? false);
  const [usedSuggestions, setUsedSuggestions] = useState<ReadonlySet<string>>(new Set());
  const [applyToExisting, setApplyToExisting] = useState(false);

  // The Modal stays mounted between opens, so re-seed every field whenever it
  // is (re)opened for a different rule - otherwise "Add Rule" after editing
  // shows the previous rule and editing rule B saves rule A's fields under
  // B's id. Mirrors SieveEditorSheet, which re-seeds on `visible`.
  useEffect(() => {
    if (!visible) return;
    setName(start?.name || '');
    setMatchType(start?.matchType || 'all');
    setConditions(seedConditions(start));
    setActions(seedActions(start));
    setStopProcessing(start?.stopProcessing ?? false);
    setIncludeSpam(start?.includeSpam ?? false);
    setUsedSuggestions(new Set());
    setApplyToExisting(false);
  }, [visible, start]);

  const mailboxTargets = useMemo(() => buildMailboxTargets(mailboxes), [mailboxes]);

  const fieldOptions = useMemo(
    () => CONDITION_FIELDS.map((f) => ({ value: f, label: t(`settings.filters.condition_fields.${f}`, f) })),
    [t],
  );
  const actionTypeOptions = useMemo(
    () => ALL_ACTION_TYPES.map((a) => ({ value: a, label: t(`settings.filters.action_types.${a}`, a) })),
    [t],
  );
  // What counts is the most forwards one message can collect: those of the
  // rules above that let it go on, this rule's, and those below unless this
  // rule stops.
  const forwardState = modalForwardState(actions, stopProcessing, maxRedirects, forwardsBefore, forwardsAfter);
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
        if (updates.field) return conditionForField({ ...cond, ...updates }, updates.field);
        const updated = { ...cond, ...updates };
        // Picking has_any drops whatever value was typed.
        if (isValueLessCondition(updated)) updated.value = '';
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

  // Old mail can only be sorted by what the client can check the way Sieve
  // does. Until an action is complete, only the conditions decide.
  const canApplyToExisting = useMemo(() => {
    if (!offerApplyToExisting) return false;
    const done = actions
      .map((a) => withMailboxTarget(a, mailboxTargets))
      .filter((a) => !ACTIONS_WITH_VALUE.has(a.type) || a.value?.trim());
    const checkActions: FilterAction[] = done.length > 0 ? done : [{ type: 'mark_read' }];
    return retroactiveSupport({ conditions: conditionsToSave(conditions), actions: checkActions }).ok;
  }, [offerApplyToExisting, conditions, actions, mailboxTargets]);

  const visibleSuggestions = (suggestions ?? []).filter((s) => !usedSuggestions.has(s.id));

  const chooseSuggestion = (suggestion: RuleSuggestion) => {
    setConditions((prev) => applySuggestion({ conditions: prev }, suggestion).conditions);
    setUsedSuggestions((prev) => new Set(prev).add(suggestion.id));
  };

  const handleSave = useCallback(() => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      Alert.alert(t('settings.filters.validation_empty_name', 'Rule name is required'));
      return;
    }
    const validConditions = conditionsToSave(conditions);
    if (validConditions.length === 0) {
      Alert.alert(t('settings.filters.validation_empty_conditions', 'At least one condition with a value is required'));
      return;
    }
    if (validConditions.some((c) => c.field === 'size' && !isValidSizeValue(c.value))) {
      Alert.alert(t('settings.filters.invalid_size', 'Enter a size as a whole number, optionally followed by K, M or G (for example 500K or 10M).'));
      return;
    }
    const validActions = actions
      .map((a) => withMailboxTarget(a, mailboxTargets))
      .filter((a) => !ACTIONS_WITH_VALUE.has(a.type) || a.value?.trim());
    if (validActions.length === 0) {
      Alert.alert(t('settings.filters.validation_empty_actions', 'At least one action is required'));
      return;
    }
    onSave({
      id: rule?.id || initialRule?.id || generateUUID(),
      name: trimmedName,
      enabled: start?.enabled ?? true,
      matchType,
      conditions: validConditions,
      actions: validActions,
      stopProcessing,
      // Only folder moves are kept out of Junk, so the opt-in only means
      // something (and is only stored) while the rule has one.
      ...(includeSpam && validActions.some((a) => ACTIONS_WITH_MAILBOX.has(a.type)) ? { includeSpam: true } : {}),
    }, { applyToExisting: applyToExisting && canApplyToExisting });
  }, [name, conditions, actions, matchType, stopProcessing, includeSpam, rule, initialRule, start, onSave, t, mailboxTargets, applyToExisting, canApplyToExisting]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
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
          style={{ flex: 1 }}
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
              {visibleSuggestions.length > 0 && (
                <View
                  style={styles.chipRow}
                  accessibilityRole="toolbar"
                  accessibilityLabel={t('settings.filters.suggestions', 'Suggestions')}
                >
                  {visibleSuggestions.map((suggestion) => (
                    <Pressable
                      key={suggestion.id}
                      onPress={() => chooseSuggestion(suggestion)}
                      style={styles.chip}
                      accessibilityRole="button"
                      accessibilityLabel={suggestion.label}
                    >
                      <Plus size={12} color={c.primary} />
                      <Text style={styles.chipText} numberOfLines={1}>{suggestion.label}</Text>
                    </Pressable>
                  ))}
                </View>
              )}
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
                    {!isValueLessCondition(condition) && (
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
                        options={actionTypeOptions.map((o) => (
                          o.value === 'forward' && action.type !== 'forward' && forwardState.forwardDisabled
                            ? { ...o, disabled: true }
                            : o))}
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
              {forwardState.overLimit && (
                <Text style={styles.forwardLimit}>
                  {t('settings.filters.forward_limit', 'Forward limit per message on this server: {count}. Extra forwards are skipped.', { count: forwardState.limit ?? 0 })}
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

            {offerApplyToExisting && (
              <View>
                <View style={styles.stopRow}>
                  <Text style={canApplyToExisting ? styles.stopLabel : [styles.stopLabel, { color: c.mutedForeground }]}>
                    {t('settings.filters.apply_existing', 'Also apply to existing messages in this folder')}
                  </Text>
                  <ToggleSwitch
                    checked={applyToExisting && canApplyToExisting}
                    onChange={setApplyToExisting}
                    disabled={!canApplyToExisting}
                    accessibilityLabel={t('settings.filters.apply_existing', 'Also apply to existing messages in this folder')}
                  />
                </View>
                {!canApplyToExisting && (
                  <Text style={styles.hint}>
                    {t(
                      'settings.filters.apply_existing_unsupported',
                      'Only rules that check the sender, recipients, subject or headers, and that move, copy, mark as read, star or tag, can run on existing messages.',
                    )}
                  </Text>
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
    </Modal>
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
    forwardLimit: { ...typography.caption, color: c.warning, marginTop: spacing.sm },
    stopLabel: { ...typography.body, color: c.text, flex: 1 },

    chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
    chip: {
      flexDirection: 'row', alignItems: 'center', gap: 4, maxWidth: '100%',
      paddingHorizontal: spacing.md, paddingVertical: 6,
      borderRadius: radius.md, borderWidth: 1, borderColor: c.border, backgroundColor: c.muted,
    },
    chipText: { ...typography.caption, color: c.text, flexShrink: 1 },
    hint: { ...typography.caption, color: c.mutedForeground, marginTop: spacing.xs },

    optionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
    },
    optionLabel: { ...typography.body, color: c.text, flex: 1 },

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
