import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AccessibilityInfo, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text,
  useWindowDimensions, View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import DateTimePicker, { DateTimePickerAndroid, type DateTimePickerEvent } from '@react-native-community/datetimepicker';
import { Check, CheckSquare, ChevronDown, Plus, Square, X } from '../icons';
import { radius, spacing, typography, componentSizes, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import Input from '../Input';
import Button from '../Button';
import { SafeAreaModal } from '../SafeAreaModal';
import { ActionSheet } from '../email/ActionSheet';
import { MoveSheet } from '../MoveSheet';
import { useLocaleStore } from '../../stores/locale-store';
import { FALLBACK_KEYWORD_COLOR, useKeywordsStore } from '../../stores/keywords-store';
import { MODAL_ORIENTATIONS } from '../../lib/modal-orientations';
import { useModalKeyboardPadding } from '../../lib/sheet-bottom-inset';
import { ruleTargetMailboxes } from '../../lib/sieve/quick-rules';
import { parseLocalInput, utcIsoToLocalInput } from '../../lib/vacation-dates';
import type { FilterComparator, FilterRule } from '../../lib/sieve/types';
import type { ApplyScope } from '../../lib/sieve/rule-scope';
import type { ChecklistKey, SizeUnit } from '../../lib/sieve/rule-editor-model';
import {
  CONDITION_KINDS, SIZE_UNITS, SIZE_UNIT_KEYS, useRuleEditor,
  type ConditionKind, type ErrorSection, type RuleEditorOptions, type RuleEditorState,
} from './use-rule-editor';

export interface RuleEditorSheetProps extends Omit<RuleEditorOptions, 't' | 'keywords' | 'confirmTrash' | 'onSave'> {
  visible: boolean;
  onSave: (rule: FilterRule, options: { applyTo: ApplyScope }) => void;
  onDelete?: () => void;
  onClose: () => void;
}

interface Choice<T extends string> {
  value: T;
  label: string;
  disabled?: boolean;
}

interface Picker {
  title: string;
  options: Choice<string>[];
  selected: string;
  onPick: (value: string) => void;
}

const EDITOR_HIDDEN_ROLES = new Set(['sent', 'scheduled']);

function askTrash(question: { title: string; message: string; confirm: string; cancel: string }): Promise<boolean> {
  return new Promise((resolve) => {
    Alert.alert(question.title, question.message, [
      { text: question.cancel, style: 'cancel', onPress: () => resolve(false) },
      { text: question.confirm, style: 'destructive', onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) });
  });
}

export function RuleEditorSheet({ visible, onClose, ...props }: RuleEditorSheetProps) {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const key = `${props.rule?.id ?? 'new'}:${props.initialRule?.id ?? ''}`;
  return (
    <SafeAreaModal
      supportedOrientations={MODAL_ORIENTATIONS}
      visible={visible}
      animationType="slide"
      presentationStyle={Platform.OS === 'ios' ? 'fullScreen' : undefined}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
        {visible && <RuleEditorBody key={key} {...props} onClose={onClose} />}
      </SafeAreaView>
    </SafeAreaModal>
  );
}

function RuleEditorBody(props: Omit<RuleEditorSheetProps, 'visible'>) {
  const { onClose, onDelete, mailboxes } = props;
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const keywords = useKeywordsStore((s) => s.keywords);
  const keyboardPadding = useModalKeyboardPadding(true);
  const editor = useRuleEditor({ ...props, t, keywords, confirmTrash: askTrash });
  const tagSwatch = (id: string) => c.tags[keywords.find((k) => k.id === id)?.color ?? FALLBACK_KEYWORD_COLOR] ?? c.tags[FALLBACK_KEYWORD_COLOR];
  const [picker, setPicker] = useState<Picker | null>(null);
  const [folderFor, setFolderFor] = useState<'move' | 'copy' | null>(null);
  const scrollRef = useRef<ScrollView>(null);
  const sectionY = useRef<Record<ErrorSection, number>>({ conditions: 0, actions: 0, period: 0 });

  useEffect(() => {
    if (editor.firstError) scrollRef.current?.scrollTo({ y: Math.max(0, sectionY.current[editor.firstError] - spacing.lg), animated: true });
  }, [editor.saveAttempt, editor.firstError]);

  useEffect(() => {
    if (editor.previewText && Platform.OS === 'ios') AccessibilityInfo.announceForAccessibility(editor.previewText);
  }, [editor.previewText]);

  const folderTargets = useMemo(
    () => ruleTargetMailboxes(mailboxes).filter((m) => !EDITOR_HIDDEN_ROLES.has(m.role ?? '')),
    [mailboxes],
  );

  const requestClose = () => {
    if (!editor.dirty) {
      onClose();
      return;
    }
    Alert.alert(
      t('settings.discard_changes', 'Discard changes?'),
      undefined,
      [
        { text: t('settings.keep_editing', 'Keep editing'), style: 'cancel' },
        { text: t('settings.discard', 'Discard'), style: 'destructive', onPress: onClose },
      ],
      { cancelable: true },
    );
  };

  const choose = <T extends string>(title: string, options: Choice<T>[], selected: T, onPick: (value: T) => void) =>
    setPicker({ title, options, selected, onPick: onPick as (value: string) => void });

  const applyChoice = editor.applyOptions.find((o) => o.value === editor.effectiveApply);

  return (
    <>
      <View style={styles.header}>
        <Pressable
          onPress={requestClose}
          hitSlop={8}
          style={styles.headerButton}
          accessibilityRole="button"
          accessibilityLabel={t('common.close', 'Close')}
        >
          <X size={20} color={c.text} />
        </Pressable>
        <Text style={styles.headerTitle} accessibilityRole="header">
          {editor.isEdit ? t('settings.filters.edit_rule') : t('settings.filters.new_rule')}
        </Text>
        <View style={styles.headerButton} />
      </View>

      <KeyboardAvoidingView style={{ flex: 1, paddingBottom: keyboardPadding }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView ref={scrollRef} contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
          <View onLayout={(e) => { sectionY.current.conditions = e.nativeEvent.layout.y; }}>
            <View style={styles.sentence}>
              <Text style={styles.sentenceText}>{t('settings.filters.editor.if')}</Text>
              <Pressable
                onPress={() => choose(t('settings.filters.editor.match_type'), [
                  { value: 'all', label: t('settings.filters.editor.match_all') },
                  { value: 'any', label: t('settings.filters.editor.match_any') },
                ], editor.matchType, editor.setMatchType)}
                style={({ pressed }) => [styles.matchChip, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel={`${t('settings.filters.editor.match_type')}: ${editor.matchType === 'all' ? t('settings.filters.editor.match_all') : t('settings.filters.editor.match_any')}`}
                testID="rule-match-type"
              >
                <Text style={styles.matchChipText}>
                  {editor.matchType === 'all' ? t('settings.filters.editor.match_all') : t('settings.filters.editor.match_any')}
                </Text>
                <ChevronDown size={14} color={c.primary} />
              </Pressable>
              <Text style={styles.sentenceText}>{t('settings.filters.editor.of_conditions')}</Text>
            </View>

            <View style={styles.conditions}>
              {editor.conditionRows.map((row) => (
                <ConditionCard key={row.index} row={row} editor={editor} styles={styles} c={c} t={t} choose={choose} />
              ))}
            </View>

            <View style={styles.conditionFooter}>
              <Pressable
                onPress={editor.conditionActions.add}
                style={styles.addRow}
                hitSlop={8}
                accessibilityRole="button"
              >
                <Plus size={16} color={c.primary} />
                <Text style={styles.addText}>{t('settings.filters.add_condition')}</Text>
              </Pressable>
              <View accessibilityLiveRegion="polite" style={styles.previewCount}>
                {editor.previewText && (
                  <Pressable
                    onPress={() => editor.setPreviewOpen(!editor.previewOpen)}
                    disabled={editor.previewState.status !== 'done' || editor.previewState.result.items.length === 0}
                    hitSlop={8}
                    style={styles.previewToggle}
                    accessibilityRole="button"
                    accessibilityState={{ expanded: editor.previewOpen }}
                    testID="rule-preview-count"
                  >
                    <Text style={styles.previewText}>{editor.previewText}</Text>
                    {editor.previewState.status === 'done' && editor.previewState.result.items.length > 0 && (
                      <ChevronDown size={14} color={c.mutedForeground} style={editor.previewOpen ? { transform: [{ rotate: '180deg' }] } : undefined} />
                    )}
                  </Pressable>
                )}
              </View>
            </View>
            {editor.newMailOnly && <Text style={styles.hint}>{t('settings.filters.editor.delivered_to_new_only')}</Text>}
            {editor.previewOpen && editor.previewState.status === 'done' && editor.previewState.result.items.length > 0 && (
              <ScrollView style={styles.previewList} nestedScrollEnabled testID="rule-preview">
                {editor.previewState.result.items.map((item) => (
                  <View key={item.id} style={styles.previewItem}>
                    <View style={styles.previewTop}>
                      <Text style={styles.previewFrom} numberOfLines={1}>{item.from}</Text>
                      <Text style={styles.previewDate}>
                        {item.receivedAt ? new Date(item.receivedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' }) : ''}
                      </Text>
                    </View>
                    <Text style={styles.previewSubject} numberOfLines={1}>{item.subject}</Text>
                  </View>
                ))}
              </ScrollView>
            )}
            <FieldError text={editor.errors.conditions} styles={styles} />
          </View>

          <View onLayout={(e) => { sectionY.current.actions = e.nativeEvent.layout.y; }}>
            <Text style={styles.sectionTitle} accessibilityRole="header">{t('settings.filters.then')}</Text>
            <View style={styles.checklist}>
              <CheckRow editor={editor} k="markRead" styles={styles} c={c} t={t} />
              <CheckRow editor={editor} k="star" styles={styles} c={c} t={t} />
              {editor.showsTagRow && (
                <CheckRow editor={editor} k="tag" styles={styles} c={c} t={t}>
                  <View
                    style={[styles.tagWrap, editor.actionInvalid('tag') && styles.invalidRing]}
                    accessibilityLabel={t('settings.filters.editor.tags')}
                  >
                    {editor.tagIds.map((id) => {
                      const chosen = editor.checklist.tag.ids.includes(id);
                      const swatch = tagSwatch(id);
                      return (
                        <Pressable
                          key={id}
                          testID={`rule-tag-${id}`}
                          onPress={() => editor.actionControls.toggleTag(id)}
                          style={[styles.tagChip, chosen && { backgroundColor: swatch.bg, borderColor: swatch.dot }]}
                          accessibilityRole="checkbox"
                          accessibilityState={{ checked: chosen }}
                        >
                          <View testID={`rule-tag-${id}-dot`} style={[styles.tagDot, { backgroundColor: swatch.dot }]} />
                          <Text style={[styles.tagChipText, chosen && { color: swatch.text }]}>{editor.tagName(id)}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </CheckRow>
              )}
              {(['move', 'copy'] as const).map((which) => (
                <CheckRow key={which} editor={editor} k={which} styles={styles} c={c} t={t}>
                  <Pressable
                    onPress={() => setFolderFor(which)}
                    disabled={editor.blocked.has(which)}
                    style={({ pressed }) => [styles.pickerButton, editor.actionInvalid(which) && styles.invalidBorder, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel={`${t(`settings.filters.action_types.${which}`)}: ${editor.folderLabel(editor.checklist[which]) || t('settings.filters.move_to_folder')}`}
                    testID={`rule-folder-${which}`}
                  >
                    <Text style={[styles.pickerText, !editor.folderIdFor(editor.checklist[which]) && !editor.checklist[which].value && styles.placeholderText]} numberOfLines={1}>
                      {editor.folderLabel(editor.checklist[which]) || t('settings.filters.move_to_folder')}
                    </Text>
                    <ChevronDown size={14} color={c.mutedForeground} />
                  </Pressable>
                </CheckRow>
              ))}
              {editor.filing && (
                <CheckBox
                  checked={editor.includeSpam}
                  onChange={editor.setIncludeSpam}
                  label={t('settings.filters.include_spam')}
                  styles={styles}
                  c={c}
                  muted
                />
              )}
              {editor.showsForwardRow && (
                <CheckRow editor={editor} k="forward" styles={styles} c={c} t={t}>
                  <Input
                    value={editor.checklist.forward.to}
                    onChangeText={editor.actionControls.setForwardTo}
                    placeholder={t('settings.filters.forward_placeholder')}
                    accessibilityLabel={t('settings.filters.forward_to')}
                    accessibilityHint={t('ux_p3_words.filter_values_hint')}
                    keyboardType="email-address"
                    autoCapitalize="none"
                    autoCorrect={false}
                    editable={!editor.forwardLocked}
                    invalid={editor.actionInvalid('forward')}
                  />
                  <CheckBox
                    checked={editor.checklist.forward.keepCopy}
                    onChange={editor.actionControls.setForwardKeepCopy}
                    label={t('settings.filters.forward_keep_copy')}
                    styles={styles}
                    c={c}
                  />
                  {(editor.forwardOverLimit || (editor.forwardUnavailable && editor.forwardCount > 0)) && (
                    <Text style={styles.warning}>
                      {editor.forwardUnavailable
                        ? t('settings.filters.forward_unavailable')
                        : t('settings.filters.forward_limit', undefined, { count: editor.forwardLimit ?? 0 })}
                    </Text>
                  )}
                </CheckRow>
              )}
              {editor.showsKeepRow && <CheckRow editor={editor} k="keep" styles={styles} c={c} t={t} />}
              <CheckRow editor={editor} k="reject" styles={styles} c={c} t={t}>
                <Input
                  value={editor.checklist.reject.message}
                  onChangeText={editor.actionControls.setRejectMessage}
                  placeholder={t('settings.filters.reject_placeholder')}
                  accessibilityLabel={t('settings.filters.reject_message')}
                  editable={!editor.blocked.has('reject')}
                  invalid={editor.actionInvalid('reject')}
                />
              </CheckRow>
              <CheckRow editor={editor} k="discard" styles={styles} c={c} t={t} />
              <View style={styles.separator} />
              <CheckBox
                checked={!editor.stopProcessing}
                onChange={editor.setContinue}
                label={t('settings.filters.editor.continue_rules')}
                styles={styles}
                c={c}
              />
            </View>
            <FieldError text={editor.errors.actions} styles={styles} />
          </View>

          <View style={styles.meta} onLayout={(e) => { sectionY.current.period = e.nativeEvent.layout.y; }}>
            <Input
              label={t('settings.filters.rule_name')}
              value={editor.name}
              onChangeText={editor.setName}
              placeholder={editor.autoName}
              accessibilityLabel={t('settings.filters.rule_name')}
              maxLength={200}
            />
            {editor.periodShown && (
              <View style={{ gap: spacing.sm }}>
                <CheckBox
                  checked={editor.periodOn}
                  onChange={editor.setPeriodOn}
                  label={t('settings.filters.period_toggle')}
                  styles={styles}
                  c={c}
                />
                {editor.periodOn && (
                  <View style={styles.periodBox}>
                    <PeriodField
                      label={t('settings.filters.period_start')}
                      value={editor.periodStart}
                      onChange={editor.setPeriodStart}
                      styles={styles}
                      c={c}
                      t={t}
                    />
                    <PeriodField
                      label={t('settings.filters.period_end')}
                      value={editor.periodEnd}
                      onChange={editor.setPeriodEnd}
                      styles={styles}
                      c={c}
                      t={t}
                    />
                    <Text style={styles.hint}>{t('settings.filters.period_hint')}</Text>
                    <FieldError text={editor.errors.period} styles={styles} />
                  </View>
                )}
              </View>
            )}
            <CheckBox
              checked={!editor.enabled}
              onChange={editor.setSkip}
              label={t('settings.filters.editor.skip_rule')}
              styles={styles}
              c={c}
            />
            {editor.isEdit && onDelete && (
              <Pressable onPress={onDelete} style={styles.deleteRow} accessibilityRole="button" hitSlop={8}>
                <Text style={styles.deleteText}>{t('settings.filters.delete_rule')}</Text>
              </Pressable>
            )}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>

      <View style={styles.footer}>
        {applyChoice && (
          <Pressable
            onPress={() => choose(t('settings.filters.editor.apply_to'), editor.applyOptions, editor.effectiveApply, editor.setApplyTo)}
            style={({ pressed }) => [styles.applyButton, pressed && styles.pressed]}
            accessibilityRole="button"
            accessibilityLabel={`${t('settings.filters.editor.apply_to')}: ${applyChoice.label}`}
            testID="rule-apply-to"
          >
            <Text style={styles.applyLabel}>{t('settings.filters.editor.apply_to')}</Text>
            <Text style={styles.applyValue} numberOfLines={1}>{applyChoice.label}</Text>
            <ChevronDown size={14} color={c.mutedForeground} />
          </Pressable>
        )}
        <Button onPress={() => void editor.save()} style={styles.saveButton}>
          {t('settings.filters.save')}
        </Button>
      </View>

      <ChoiceSheet picker={picker} onClose={() => setPicker(null)} styles={styles} c={c} />
      <MoveSheet
        visible={folderFor !== null}
        onClose={() => setFolderFor(null)}
        mailboxes={folderTargets}
        currentMailboxId={null}
        onPick={(id) => {
          const mailbox = mailboxes.find((m) => m.id === id);
          if (folderFor && mailbox) editor.actionControls.pickFolder(folderFor, mailbox.originalId ?? mailbox.id);
          setFolderFor(null);
        }}
      />
    </>
  );
}

type Styles = ReturnType<typeof makeStyles>;
type Translate = ReturnType<typeof useLocaleStore.getState>['t'];
type Choose = <T extends string>(title: string, options: Choice<T>[], selected: T, onPick: (value: T) => void) => void;

function ConditionCard({ row, editor, styles, c, t, choose }: {
  row: RuleEditorState['conditionRows'][number];
  editor: RuleEditorState;
  styles: Styles;
  c: ThemePalette;
  t: Translate;
  choose: Choose;
}) {
  const { index, condition } = row;
  const kinds: Choice<ConditionKind>[] = CONDITION_KINDS.map((kind) => ({
    value: kind,
    label: kind === 'attachment_any'
      ? t('settings.filters.editor.has_attachment')
      : kind === 'attachment_type'
        ? t('settings.filters.editor.attachment_type')
        : t(`settings.filters.condition_fields.${kind}`),
  }));
  const comparatorLabel = (cmp: FilterComparator) => t(`settings.filters.comparators.${cmp}`);
  return (
    <View style={[styles.card, row.invalid && styles.invalidBorder]} testID={`rule-condition-${index + 1}`}>
      <View style={styles.cardTop}>
        <View style={styles.badge} importantForAccessibility="no-hide-descendants">
          <Text style={styles.badgeText}>{index + 1}</Text>
        </View>
        <Pressable
          onPress={() => choose(
            t('settings.filters.editor.condition_number', undefined, { number: index + 1 }),
            kinds,
            row.kind,
            (kind) => editor.conditionActions.setKind(index, kind),
          )}
          style={({ pressed }) => [styles.pickerButton, styles.flex, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={`${t('settings.filters.editor.condition_number', undefined, { number: index + 1 })}: ${row.kindLabel}`}
        >
          <Text style={styles.pickerText} numberOfLines={1}>{row.kindLabel}</Text>
          <ChevronDown size={14} color={c.mutedForeground} />
        </Pressable>
        <Pressable
          onPress={() => editor.conditionActions.remove(index)}
          disabled={!row.removable}
          hitSlop={8}
          style={[styles.removeButton, !row.removable && styles.disabled]}
          accessibilityRole="button"
          accessibilityLabel={t('settings.filters.remove_condition')}
        >
          <X size={16} color={c.mutedForeground} />
        </Pressable>
      </View>

      {row.kind === 'header' && (
        <Input
          value={condition.headerName ?? ''}
          onChangeText={(v) => editor.conditionActions.setHeaderName(index, v)}
          placeholder={t('settings.filters.header_name')}
          accessibilityLabel={t('settings.filters.header_name')}
          autoCapitalize="none"
          autoCorrect={false}
          invalid={row.headerInvalid}
        />
      )}

      {row.comparators.length > 0 && (
        <Pressable
          onPress={() => choose(
            t('settings.filters.editor.comparison'),
            row.comparators.map((cmp) => ({ value: cmp, label: comparatorLabel(cmp) })),
            condition.comparator,
            (cmp) => editor.conditionActions.setComparator(index, cmp),
          )}
          style={({ pressed }) => [styles.pickerButton, styles.comparatorButton, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={`${t('settings.filters.editor.comparison')}: ${comparatorLabel(condition.comparator)}`}
        >
          <Text style={styles.pickerText} numberOfLines={1}>{comparatorLabel(condition.comparator)}</Text>
          <ChevronDown size={14} color={c.mutedForeground} />
        </Pressable>
      )}

      {row.size && (
        <View style={styles.sizeRow}>
          <Input
            value={row.size.amount}
            onChangeText={(v) => editor.conditionActions.setSizeAmount(index, v.replace(/[^\d]/g, ''))}
            keyboardType="number-pad"
            accessibilityLabel={t('settings.filters.condition_value')}
            containerStyle={styles.flex}
            invalid={row.invalid}
          />
          <View style={styles.segment} accessibilityRole="radiogroup" accessibilityLabel={t('settings.filters.editor.size_unit')}>
            {SIZE_UNITS.map((unit: SizeUnit) => {
              const on = row.size!.unit === unit;
              return (
                <Pressable
                  key={unit || 'bytes'}
                  onPress={() => editor.conditionActions.setSizeUnit(index, unit)}
                  style={[styles.segmentItem, on && styles.segmentItemOn]}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on }}
                >
                  <Text style={[styles.segmentText, on && styles.segmentTextOn]}>{t(`settings.filters.editor.size_units.${SIZE_UNIT_KEYS[unit]}`)}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      )}

      {!row.size && row.takesValue && (
        <Input
          value={row.text}
          onChangeText={(v) => editor.conditionActions.setText(index, v)}
          onBlur={() => editor.conditionActions.commitText(index)}
          placeholder={row.placeholder}
          accessibilityLabel={t('settings.filters.condition_value')}
          accessibilityHint={row.hint}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType={row.kind === 'from' || row.kind === 'to' || row.kind === 'cc' || row.kind === 'delivered_to' ? 'email-address' : 'default'}
          invalid={row.invalid}
        />
      )}
    </View>
  );
}

const ACTION_LABEL_KEYS: Record<ChecklistKey, string> = {
  markRead: 'mark_read', star: 'star', tag: 'add_label', copy: 'copy', move: 'move',
  forward: 'forward', keep: 'keep', reject: 'reject', discard: 'discard',
};

function CheckRow({ editor, k, styles, c, t, children }: {
  editor: RuleEditorState;
  k: ChecklistKey;
  styles: Styles;
  c: ThemePalette;
  t: Translate;
  children?: React.ReactNode;
}) {
  const value = editor.checklist[k];
  const on = typeof value === 'boolean' ? value : value.on;
  const disabled = !on && (editor.blocked.has(k) || (k === 'forward' && editor.forwardLocked));
  return (
    <View style={styles.checkRow}>
      <CheckBox
        checked={on}
        onChange={(next) => editor.actionControls.toggle(k, next)}
        label={t(`settings.filters.action_types.${ACTION_LABEL_KEYS[k]}`)}
        disabled={disabled}
        styles={styles}
        c={c}
      />
      {children && <View style={[styles.checkControl, !on && styles.dimmed]}>{children}</View>}
    </View>
  );
}

function CheckBox({ checked, onChange, label, disabled, muted, styles, c }: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
  muted?: boolean;
  styles: Styles;
  c: ThemePalette;
}) {
  const Icon = checked ? CheckSquare : Square;
  return (
    <Pressable
      onPress={() => onChange(!checked)}
      disabled={disabled}
      style={({ pressed }) => [styles.checkBox, pressed && styles.pressed]}
      accessibilityRole="checkbox"
      accessibilityState={{ checked, disabled: !!disabled }}
      accessibilityLabel={label}
    >
      <Icon size={22} color={disabled ? c.textMuted : checked ? c.primary : c.mutedForeground} />
      <Text style={[styles.checkLabel, (disabled || muted) && styles.checkLabelMuted]}>{label}</Text>
    </Pressable>
  );
}

function PeriodField({ label, value, onChange, styles, c, t }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  styles: Styles;
  c: ThemePalette;
  t: Translate;
}) {
  const date = parseLocalInput(value);
  const [iosOpen, setIosOpen] = useState(false);
  const toInput = (d: Date) => utcIsoToLocalInput(d.toISOString());
  const open = () => {
    const start = date ?? new Date();
    if (Platform.OS === 'android') {
      DateTimePickerAndroid.open({
        value: start,
        mode: 'date',
        onChange: (event: DateTimePickerEvent, day?: Date) => {
          if (event.type !== 'set' || !day) return;
          DateTimePickerAndroid.open({
            value: day,
            mode: 'time',
            onChange: (timeEvent: DateTimePickerEvent, time?: Date) => {
              if (timeEvent.type !== 'set' || !time) return;
              const picked = new Date(day);
              picked.setHours(time.getHours(), time.getMinutes(), 0, 0);
              onChange(toInput(picked));
            },
          });
        },
      });
    } else {
      if (!date) onChange(toInput(start));
      setIosOpen((v) => !v);
    }
  };
  return (
    <View style={{ gap: spacing.xs }}>
      <View style={styles.periodRow}>
        <Text style={styles.periodLabel}>{label}</Text>
        <Pressable
          onPress={open}
          style={({ pressed }) => [styles.pickerButton, styles.flex, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${value || '—'}`}
        >
          <Text style={[styles.pickerText, !value && styles.placeholderText]}>{value || '—'}</Text>
        </Pressable>
        {!!value && (
          <Pressable
            onPress={() => { onChange(''); setIosOpen(false); }}
            hitSlop={8}
            style={styles.removeButton}
            accessibilityRole="button"
            accessibilityLabel={`${label}: ${t('common.delete')}`}
          >
            <X size={16} color={c.mutedForeground} />
          </Pressable>
        )}
      </View>
      {Platform.OS === 'ios' && iosOpen && date && (
        <DateTimePicker
          value={date}
          mode="datetime"
          display="inline"
          maximumDate={new Date(9999, 11, 31, 23, 59)}
          onChange={(_e: DateTimePickerEvent, d?: Date) => { if (d) onChange(toInput(d)); }}
        />
      )}
    </View>
  );
}

function ChoiceSheet({ picker, onClose, styles, c }: {
  picker: Picker | null;
  onClose: () => void;
  styles: Styles;
  c: ThemePalette;
}) {
  const { height } = useWindowDimensions();
  const [shown, setShown] = useState<Picker | null>(picker);
  useEffect(() => { if (picker) setShown(picker); }, [picker]);
  return (
    <ActionSheet visible={!!picker} title={shown?.title ?? ''} items={[]} onClose={onClose}>
      <ScrollView style={{ maxHeight: height * 0.6 }} keyboardShouldPersistTaps="handled">
        {shown?.options.map((option) => {
          const selected = option.value === shown.selected;
          return (
            <Pressable
              key={option.value}
              onPress={() => {
                if (option.disabled) return;
                shown.onPick(option.value);
                onClose();
              }}
              disabled={option.disabled}
              style={({ pressed }) => [styles.choice, pressed && styles.pressed, option.disabled && styles.disabled]}
              accessibilityRole="menuitem"
              accessibilityState={{ selected, disabled: !!option.disabled }}
            >
              <Text style={[styles.choiceText, selected && styles.choiceTextOn]}>{option.label}</Text>
              {selected && <Check size={18} color={c.primary} />}
            </Pressable>
          );
        })}
      </ScrollView>
    </ActionSheet>
  );
}

function FieldError({ text, styles }: { text: string | null; styles: Styles }) {
  if (!text) return null;
  return <Text style={styles.error} accessibilityRole="alert" accessibilityLiveRegion="assertive">{text}</Text>;
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      height: componentSizes.headerHeight,
      paddingHorizontal: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    headerButton: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
    headerTitle: { ...typography.h3, color: c.text, flex: 1, textAlign: 'center' },
    body: { padding: spacing.lg, gap: spacing.xxl, paddingBottom: spacing.xxxl },
    flex: { flex: 1 },
    pressed: { opacity: 0.6 },
    disabled: { opacity: 0.35 },
    dimmed: { opacity: 0.55 },

    sentence: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing.xs, marginBottom: spacing.md },
    sentenceText: { ...typography.baseMedium, color: c.text },
    matchChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: spacing.md,
      minHeight: 36,
      borderRadius: radius.full,
      backgroundColor: c.primaryBg,
      borderWidth: 1,
      borderColor: c.primaryBorder,
    },
    matchChipText: { ...typography.baseMedium, color: c.primary },

    conditions: { gap: spacing.sm },
    card: {
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radius.lg,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.card,
    },
    cardTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    badge: {
      width: 28,
      height: 28,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    badgeText: { ...typography.captionMedium, color: c.mutedForeground },
    removeButton: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
    pickerButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
      minHeight: 44,
      paddingHorizontal: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.muted,
    },
    comparatorButton: { alignSelf: 'stretch' },
    pickerText: { ...typography.base, color: c.text, flexShrink: 1 },
    placeholderText: { color: c.mutedForeground },
    invalidBorder: { borderColor: c.error },
    invalidRing: { borderWidth: 1, borderColor: c.error, borderRadius: radius.md, padding: spacing.xs },

    sizeRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
    segment: {
      flexDirection: 'row',
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      overflow: 'hidden',
      minHeight: 44,
    },
    segmentItem: { paddingHorizontal: spacing.md, justifyContent: 'center', minHeight: 44 },
    segmentItemOn: { backgroundColor: c.primary },
    segmentText: { ...typography.bodyMedium, color: c.text },
    segmentTextOn: { color: c.primaryForeground },

    conditionFooter: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
      marginTop: spacing.md,
    },
    addRow: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 36 },
    addText: { ...typography.bodyMedium, color: c.primary },
    previewCount: { flexShrink: 1 },
    previewToggle: { flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 36 },
    previewText: { ...typography.body, color: c.mutedForeground },
    previewList: {
      maxHeight: 264,
      marginTop: spacing.sm,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      overflow: 'hidden',
    },
    previewItem: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
      gap: 2,
    },
    previewTop: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm },
    previewFrom: { ...typography.bodySemibold, color: c.text, flex: 1 },
    previewDate: { ...typography.caption, color: c.mutedForeground },
    previewSubject: { ...typography.body, color: c.mutedForeground },

    sectionTitle: { ...typography.baseMedium, color: c.text, marginBottom: spacing.xs },
    checklist: {},
    checkRow: { paddingVertical: 2 },
    checkControl: { marginLeft: 34, marginBottom: spacing.sm, gap: spacing.xs },
    checkBox: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, minHeight: 44 },
    checkLabel: { ...typography.base, color: c.text, flexShrink: 1 },
    checkLabelMuted: { color: c.mutedForeground },
    separator: { height: StyleSheet.hairlineWidth, backgroundColor: c.border, marginVertical: spacing.xs },
    tagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
    tagChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm - 2,
      paddingHorizontal: spacing.md,
      minHeight: 32,
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.muted,
    },
    tagDot: { width: 8, height: 8, borderRadius: 4 },
    tagChipText: { ...typography.body, color: c.text },
    warning: { ...typography.caption, color: c.warning },

    meta: { gap: spacing.lg },
    periodBox: { marginLeft: 34, gap: spacing.sm },
    periodRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    periodLabel: { ...typography.body, color: c.mutedForeground, minWidth: 72 },
    hint: { ...typography.caption, color: c.mutedForeground, marginTop: spacing.xs },
    deleteRow: { minHeight: 44, justifyContent: 'center' },
    deleteText: { ...typography.baseMedium, color: c.error },
    error: { ...typography.caption, color: c.error, marginTop: spacing.sm },

    footer: {
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      paddingBottom: spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
      backgroundColor: c.background,
    },
    applyButton: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      minHeight: 44,
      paddingHorizontal: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
    },
    applyLabel: { ...typography.body, color: c.mutedForeground },
    applyValue: { ...typography.bodyMedium, color: c.text, flex: 1 },
    saveButton: { alignSelf: 'stretch' },

    choice: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      minHeight: 48,
      paddingHorizontal: spacing.lg,
    },
    choiceText: { ...typography.base, color: c.text, flexShrink: 1 },
    choiceTextOn: { color: c.primary, fontWeight: '600' },
  });
}
