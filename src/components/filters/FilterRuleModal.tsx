import React, { useCallback, useMemo, useState } from 'react';
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
import { buildMailboxTree, type MailboxNode } from '../../lib/mailbox-tree';
import { generateUUID } from '../../lib/uuid';
import type { Mailbox } from '../../api/types';
import type {
  FilterRule,
  FilterCondition,
  FilterAction,
  FilterConditionField,
  FilterComparator,
  FilterActionType,
} from '../../lib/sieve/types';

const ALL_FIELDS: FilterConditionField[] = ['from', 'to', 'cc', 'subject', 'header', 'size', 'body'];
const TEXT_COMPARATORS: FilterComparator[] = ['contains', 'not_contains', 'is', 'not_is', 'starts_with', 'ends_with', 'matches'];
const SIZE_COMPARATORS: FilterComparator[] = ['greater_than', 'less_than'];
const ALL_ACTION_TYPES: FilterActionType[] = ['move', 'copy', 'forward', 'mark_read', 'star', 'add_label', 'discard', 'reject', 'keep', 'stop'];

const ACTIONS_WITH_VALUE = new Set<FilterActionType>(['move', 'copy', 'forward', 'reject', 'add_label']);
const ACTIONS_WITH_MAILBOX = new Set<FilterActionType>(['move', 'copy']);

function makeEmptyCondition(): FilterCondition {
  return { field: 'from', comparator: 'contains', value: '' };
}
function makeEmptyAction(): FilterAction {
  return { type: 'move', value: '' };
}

interface FilterRuleModalProps {
  visible: boolean;
  rule?: FilterRule;
  mailboxes: Mailbox[];
  onSave: (rule: FilterRule) => void;
  onClose: () => void;
}

// Flatten the mailbox tree into pickable options, building the Sieve-canonical
// folder path for each (inbox -> "INBOX", not the localized display name).
function buildMailboxOptions(mailboxes: Mailbox[]): { value: string; label: string }[] {
  const tree = buildMailboxTree(mailboxes);
  const options: { value: string; label: string }[] = [];
  const walk = (nodes: MailboxNode[], parentPath: string) => {
    for (const node of nodes) {
      const segment = node.role === 'inbox' ? 'INBOX' : node.name;
      const fullPath = parentPath ? `${parentPath}/${segment}` : segment;
      options.push({ value: fullPath, label: `${' '.repeat(node.depth * 3)}${node.name}` });
      if (node.children.length > 0) walk(node.children, fullPath);
    }
  };
  walk(tree, '');
  return options;
}

export function FilterRuleModal({ visible, rule, mailboxes, onSave, onClose }: FilterRuleModalProps) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const keywords = useKeywordsStore((s) => s.keywords);
  const isEdit = !!rule;

  const [name, setName] = useState(rule?.name || '');
  const [matchType, setMatchType] = useState<'all' | 'any'>(rule?.matchType || 'all');
  const [conditions, setConditions] = useState<FilterCondition[]>(
    rule?.conditions.length ? [...rule.conditions] : [makeEmptyCondition()],
  );
  const [actions, setActions] = useState<FilterAction[]>(
    rule?.actions.length ? [...rule.actions] : [makeEmptyAction()],
  );
  const [stopProcessing, setStopProcessing] = useState(rule?.stopProcessing ?? false);

  const mailboxOptions = useMemo(() => buildMailboxOptions(mailboxes), [mailboxes]);

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
      (field === 'size' ? SIZE_COMPARATORS : TEXT_COMPARATORS).map((cmp) => ({
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
        if (updates.field === 'size' && !SIZE_COMPARATORS.includes(cond.comparator)) {
          updated.comparator = 'greater_than';
        }
        if (updates.field && updates.field !== 'size' && SIZE_COMPARATORS.includes(cond.comparator)) {
          updated.comparator = 'contains';
        }
        if (updates.field && updates.field !== 'header') {
          delete updated.headerName;
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
      prev.map((act, i) => {
        if (i !== index) return act;
        const updated = { ...act, ...updates };
        if (updates.type && !ACTIONS_WITH_VALUE.has(updates.type)) {
          delete updated.value;
        }
        if (updates.type && ACTIONS_WITH_MAILBOX.has(updates.type) && !updated.value) {
          updated.value = mailboxOptions[0]?.value ?? '';
        }
        return updated;
      }),
    );
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
    const validConditions = conditions.filter((cond) => cond.value.trim());
    if (validConditions.length === 0) {
      Alert.alert(t('settings.filters.validation_empty_conditions', 'At least one condition with a value is required'));
      return;
    }
    const validActions = actions.filter((a) => !ACTIONS_WITH_VALUE.has(a.type) || a.value?.trim());
    if (validActions.length === 0) {
      Alert.alert(t('settings.filters.validation_empty_actions', 'At least one action is required'));
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
    });
  }, [name, conditions, actions, matchType, stopProcessing, rule, onSave, t]);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        <View style={styles.header}>
          <Pressable onPress={onClose} hitSlop={8} style={styles.headerClose}>
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

                    <Select
                      value={condition.comparator}
                      onChange={(v) => updateCondition(index, { comparator: v as FilterComparator })}
                      options={comparatorOptions(condition.field)}
                      style={{ alignSelf: 'flex-start' }}
                    />

                    <Input
                      value={condition.value}
                      onChangeText={(v) => updateCondition(index, { value: v })}
                      placeholder={
                        condition.field === 'size'
                          ? t('settings.filters.size_placeholder', 'e.g., 1000000')
                          : t('settings.filters.header_placeholder', 'Value')
                      }
                      keyboardType={condition.field === 'size' ? 'numeric' : 'default'}
                    />
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
                        options={actionTypeOptions}
                        style={{ flex: 1 }}
                      />
                      <Pressable
                        onPress={() => removeAction(index)}
                        disabled={actions.length <= 1}
                        hitSlop={8}
                        style={[styles.removeBtn, actions.length <= 1 && styles.removeBtnDisabled]}
                      >
                        <Trash2 size={16} color={c.mutedForeground} />
                      </Pressable>
                    </View>

                    {ACTIONS_WITH_MAILBOX.has(action.type) && (
                      mailboxOptions.length > 0 ? (
                        <Select
                          value={action.value || ''}
                          onChange={(v) => updateAction(index, { value: v })}
                          options={mailboxOptions}
                          style={{ alignSelf: 'stretch' }}
                        />
                      ) : (
                        <Input
                          value={action.value || ''}
                          onChangeText={(v) => updateAction(index, { value: v })}
                          placeholder={t('settings.filters.move_to_folder', 'Select folder')}
                        />
                      )
                    )}

                    {action.type === 'forward' && (
                      <Input
                        value={action.value || ''}
                        onChangeText={(v) => updateAction(index, { value: v })}
                        placeholder={t('settings.filters.forward_placeholder', 'email@example.com')}
                        keyboardType="email-address"
                        autoCapitalize="none"
                      />
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
              <ToggleSwitch checked={stopProcessing} onChange={setStopProcessing} />
            </View>
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
    stopLabel: { ...typography.body, color: c.text, flex: 1 },

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
