import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Alert } from 'react-native';
import {
  Plus, X, Code, AlertTriangle, Filter, RotateCcw, Lock,
  ChevronUp, ChevronDown, Palmtree,
} from 'lucide-react-native';
import { SettingsSection, ToggleSwitch } from './settings-section';
import Button from '../Button';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSettingsStore } from '../../stores/settings-store';
import { useFilterStore } from '../../stores/filter-store';
import { useVacationStore } from '../../stores/vacation-store';
import { useEmailStore } from '../../stores/email-store';
import { useLocaleStore } from '../../stores/locale-store';
import { FilterRuleModal } from '../filters/FilterRuleModal';
import { SieveEditorSheet } from '../filters/SieveEditorSheet';
import type { FilterRule } from '../../lib/sieve/types';

type Translate = (key: string, fallback?: string) => string;

function isReadonlyRule(r: FilterRule): boolean {
  return r.origin === 'external' || r.origin === 'opaque';
}

function summarizeRule(rule: FilterRule, t: Translate): string {
  const joiner = rule.matchType === 'all' ? t('settings.filters.and', 'and') : t('settings.filters.or', 'or');
  const conditions = rule.conditions.slice(0, 2).map((cond) => {
    const field = t(`settings.filters.condition_fields.${cond.field}`, cond.field);
    const comparator = t(`settings.filters.comparators.${cond.comparator}`, cond.comparator);
    return `${field} ${comparator} "${cond.value}"`;
  });
  const extra = rule.conditions.length > 2 ? ` (+${rule.conditions.length - 2})` : '';
  const actions = rule.actions.slice(0, 2).map((a) => {
    const action = t(`settings.filters.action_types.${a.type}`, a.type);
    return a.value ? `${action} "${a.value}"` : action;
  });
  return `${conditions.join(` ${joiner} `)}${extra} → ${actions.join(', ')}`;
}

export function FilterSettings() {
  const c = useColors();
  const styles = useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);

  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const expandedView = useSettingsStore((s) => s.filtersExpandedView);
  const updateSetting = useSettingsStore((s) => s.updateSetting);

  const mailboxes = useEmailStore((s) => s.mailboxes);
  const vacationEnabled = useVacationStore((s) => s.isEnabled);

  const {
    rules, isLoading, isSaving, error, isSupported, isOpaque, rawScript, vacationSettings,
    fetchFilters, saveFilters, addRule, updateRule, deleteRule, reorderRules, toggleRule,
    setOpaqueScript, resetToVisualBuilder, validateScript,
  } = useFilterStore();

  const [editingRule, setEditingRule] = useState<FilterRule | undefined>();
  const [showRuleModal, setShowRuleModal] = useState(false);
  const [showSieveEditor, setShowSieveEditor] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  useEffect(() => {
    void fetchFilters();
  }, [fetchFilters]);

  const showVacationBanner = (vacationEnabled || vacationSettings?.isEnabled) ?? false;

  // Editable (Bulwark-managed) rules, in order, for reorder math.
  const editableIds = useMemo(
    () => rules.filter((r) => !isReadonlyRule(r)).map((r) => r.id),
    [rules],
  );

  const persist = useCallback(async (rollback: () => void) => {
    try {
      await saveFilters();
    } catch {
      rollback();
      Alert.alert(t('settings.filters.save_failed', 'Failed to save filters'));
    }
  }, [saveFilters, t]);

  const handleToggle = useCallback((ruleId: string) => {
    toggleRule(ruleId);
    void persist(() => toggleRule(ruleId));
  }, [toggleRule, persist]);

  const handleDelete = useCallback((rule: FilterRule) => {
    Alert.alert(
      t('settings.filters.delete_rule', 'Delete Rule'),
      t('settings.filters.delete_confirm', 'Are you sure you want to delete this rule?'),
      [
        { text: t('settings.filters.cancel', 'Cancel'), style: 'cancel' },
        {
          text: t('settings.filters.confirm_delete', 'Delete'),
          style: 'destructive',
          onPress: () => {
            deleteRule(rule.id);
            void persist(() => addRule(rule));
          },
        },
      ],
    );
  }, [deleteRule, addRule, persist, t]);

  const handleSaveRule = useCallback((rule: FilterRule) => {
    const previous = useFilterStore.getState().rules;
    if (editingRule) updateRule(rule.id, rule);
    else addRule(rule);
    setShowRuleModal(false);
    setEditingRule(undefined);
    void persist(() => useFilterStore.setState({ rules: previous }));
  }, [editingRule, updateRule, addRule, persist]);

  const handleSaveSieve = useCallback((content: string) => {
    const previous = useFilterStore.getState();
    setOpaqueScript(content);
    setShowSieveEditor(false);
    void persist(() => useFilterStore.setState({
      isOpaque: previous.isOpaque,
      rules: previous.rules,
      rawScript: previous.rawScript,
    }));
  }, [setOpaqueScript, persist]);

  const handleResetToVisual = useCallback(() => {
    if (!showResetConfirm) {
      setShowResetConfirm(true);
      return;
    }
    const previous = useFilterStore.getState();
    resetToVisualBuilder();
    setShowResetConfirm(false);
    void persist(() => useFilterStore.setState({
      isOpaque: previous.isOpaque,
      rules: previous.rules,
      rawScript: previous.rawScript,
      externalRequires: previous.externalRequires,
    }));
  }, [showResetConfirm, resetToVisualBuilder, persist]);

  const moveRule = useCallback((ruleId: string, dir: -1 | 1) => {
    const idx = editableIds.indexOf(ruleId);
    const target = idx + dir;
    if (idx === -1 || target < 0 || target >= editableIds.length) return;
    const previousOrder = [...editableIds];
    const next = [...editableIds];
    [next[idx], next[target]] = [next[target], next[idx]];
    reorderRules(next);
    void persist(() => reorderRules(previousOrder));
  }, [editableIds, reorderRules, persist]);

  const handleValidate = useCallback(
    (content: string) => validateScript(content),
    [validateScript],
  );

  // ── Status screens ──────────────────────────────────────
  if (!isSupported && !isLoading) {
    return (
      <SettingsSection title={t('settings.filters.title', 'Email Filters')} description={t('settings.filters.description', 'Create rules to automatically sort, label, and manage incoming emails')}>
        <Text style={styles.statusText}>{t('settings.filters.not_supported', 'Your mail server does not support email filters.')}</Text>
      </SettingsSection>
    );
  }

  if (isLoading) {
    return (
      <SettingsSection title={t('settings.filters.title', 'Email Filters')} description={t('settings.filters.description', 'Create rules to automatically sort, label, and manage incoming emails')}>
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={c.mutedForeground} />
          <Text style={styles.statusText}>{t('settings.filters.loading', 'Loading filters...')}</Text>
        </View>
      </SettingsSection>
    );
  }

  if (error) {
    return (
      <SettingsSection title={t('settings.filters.title', 'Email Filters')} description={t('settings.filters.description', 'Create rules to automatically sort, label, and manage incoming emails')}>
        <Text style={[styles.statusText, { color: c.error }]}>{t('settings.filters.fetch_error', 'Failed to load filters')}</Text>
      </SettingsSection>
    );
  }

  return (
    <View style={{ gap: spacing.xl }}>
      <SettingsSection title={t('settings.filters.title', 'Email Filters')} description={t('settings.filters.description', 'Create rules to automatically sort, label, and manage incoming emails')}>
        {isOpaque && (
          <View style={styles.opaqueBanner}>
            <AlertTriangle size={16} color={c.warning} />
            <View style={{ flex: 1 }}>
              <Text style={styles.opaqueText}>
                {t('settings.filters.opaque_warning', 'This script was edited outside the visual builder. Only raw Sieve editing is available.')}
              </Text>
              <View style={styles.opaqueActions}>
                <Pressable onPress={() => setShowSieveEditor(true)}>
                  <Text style={styles.linkPrimary}>{t('settings.filters.open_sieve_editor', 'Open raw Sieve editor')}</Text>
                </Pressable>
                {showResetConfirm ? (
                  <View style={styles.resetConfirmRow}>
                    <Pressable onPress={handleResetToVisual}>
                      <Text style={styles.linkDanger}>{t('settings.filters.confirm_reset', 'Reset')}</Text>
                    </Pressable>
                    <Pressable onPress={() => setShowResetConfirm(false)}>
                      <Text style={styles.linkMuted}>{t('settings.filters.cancel', 'Cancel')}</Text>
                    </Pressable>
                  </View>
                ) : (
                  <Pressable onPress={handleResetToVisual} style={styles.resetLink}>
                    <RotateCcw size={12} color={c.error} />
                    <Text style={styles.linkDanger}>{t('settings.filters.reset_to_visual', 'Reset to visual builder')}</Text>
                  </Pressable>
                )}
              </View>
            </View>
          </View>
        )}

        {!isOpaque && showVacationBanner && (
          <View style={styles.vacationBanner}>
            <View style={styles.vacationIcon}>
              <Palmtree size={16} color={c.success} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.vacationTitle}>{t('settings.filters.vacation_active', 'Vacation Responder is active')}</Text>
              <Text style={styles.vacationDesc}>{t('settings.filters.vacation_active_description', 'Auto-reply is enabled for incoming messages')}</Text>
            </View>
          </View>
        )}

        {!isOpaque && rules.length === 0 && !showVacationBanner && (
          <View style={styles.emptyState}>
            <Filter size={40} color={c.mutedForeground} style={{ opacity: 0.4 }} />
            <Text style={styles.emptyText}>{t('settings.filters.no_rules', 'No filter rules')}</Text>
          </View>
        )}

        {!isOpaque && rules.length > 0 && (
          <View style={{ gap: spacing.sm }}>
            {rules.map((rule) => {
              const readonly = isReadonlyRule(rule);
              const editIdx = editableIds.indexOf(rule.id);

              if (readonly) {
                const label = rule.originLabel || t('settings.filters.origin_external', 'External');
                const hasStructured = rule.origin === 'external' && rule.conditions.length > 0 && rule.actions.length > 0;
                return (
                  <View key={rule.id} style={styles.ruleRow}>
                    <Lock size={16} color={c.mutedForeground} style={{ marginTop: 2 }} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <View style={styles.ruleNameRow}>
                        <Text style={styles.ruleName} numberOfLines={1}>{rule.name}</Text>
                        <View style={styles.originBadge}><Text style={styles.originBadgeText}>{label}</Text></View>
                      </View>
                      {hasStructured ? (
                        <Text style={styles.ruleSummary} numberOfLines={expandedView ? undefined : 2}>
                          {summarizeRule(rule, t)}
                        </Text>
                      ) : rule.rawBlock ? (
                        <Text style={styles.rawBlock} numberOfLines={expandedView ? undefined : 4}>
                          {rule.rawBlock.trim()}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                );
              }

              return (
                <View key={rule.id} style={[styles.ruleRow, !rule.enabled && styles.ruleDisabled]}>
                  <View style={{ paddingTop: 2 }}>
                    <ToggleSwitch checked={rule.enabled} onChange={() => handleToggle(rule.id)} />
                  </View>

                  <Pressable
                    style={{ flex: 1, minWidth: 0 }}
                    onPress={() => { setEditingRule(rule); setShowRuleModal(true); }}
                  >
                    <Text style={styles.ruleName} numberOfLines={1}>{rule.name}</Text>
                    <Text style={styles.ruleSummary} numberOfLines={expandedView ? undefined : 2}>
                      {summarizeRule(rule, t)}
                    </Text>
                  </Pressable>

                  <View style={styles.reorderCol}>
                    <Pressable
                      onPress={() => moveRule(rule.id, -1)}
                      disabled={editIdx <= 0}
                      hitSlop={6}
                      style={[styles.reorderBtn, editIdx <= 0 && styles.reorderBtnDisabled]}
                    >
                      <ChevronUp size={16} color={c.mutedForeground} />
                    </Pressable>
                    <Pressable
                      onPress={() => moveRule(rule.id, 1)}
                      disabled={editIdx === editableIds.length - 1}
                      hitSlop={6}
                      style={[styles.reorderBtn, editIdx === editableIds.length - 1 && styles.reorderBtnDisabled]}
                    >
                      <ChevronDown size={16} color={c.mutedForeground} />
                    </Pressable>
                  </View>

                  <Pressable onPress={() => handleDelete(rule)} hitSlop={6} style={styles.deleteBtn}>
                    <X size={16} color={c.mutedForeground} />
                  </Pressable>
                </View>
              );
            })}
          </View>
        )}
      </SettingsSection>

      <View style={styles.footer}>
        <View style={styles.footerBtns}>
          {!isOpaque && (
            <Button
              variant="outline"
              size="sm"
              icon={<Plus size={14} color={c.text} />}
              onPress={() => { setEditingRule(undefined); setShowRuleModal(true); }}
            >
              {t('settings.filters.add_rule', 'Add Rule')}
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            icon={<Code size={14} color={c.text} />}
            onPress={() => setShowSieveEditor(true)}
          >
            {t('settings.filters.raw_editor', 'Raw Sieve Editor')}
          </Button>
        </View>

        <View style={styles.footerRight}>
          {isSaving && <ActivityIndicator size="small" color={c.mutedForeground} />}
          {!isOpaque && rules.length > 0 && (
            <View style={styles.expandedToggle}>
              <Text style={styles.expandedLabel}>{t('settings.filters.expanded_view', 'Expanded view')}</Text>
              <ToggleSwitch checked={expandedView} onChange={(v) => updateSetting('filtersExpandedView', v)} />
            </View>
          )}
        </View>
      </View>

      <FilterRuleModal
        visible={showRuleModal}
        rule={editingRule}
        mailboxes={mailboxes}
        onSave={handleSaveRule}
        onClose={() => { setShowRuleModal(false); setEditingRule(undefined); }}
      />

      <SieveEditorSheet
        visible={showSieveEditor}
        content={rawScript}
        onSave={handleSaveSieve}
        onClose={() => setShowSieveEditor(false)}
        onValidate={handleValidate}
      />
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    statusText: { ...typography.body, color: c.mutedForeground, paddingVertical: spacing.md },
    loadingRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.md },

    opaqueBanner: {
      flexDirection: 'row',
      gap: spacing.sm,
      padding: spacing.md,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: 'rgba(252, 211, 77, 0.4)',
      backgroundColor: 'rgba(120, 53, 15, 0.25)',
      alignItems: 'flex-start',
    },
    opaqueText: { ...typography.caption, color: '#fde68a' },
    opaqueActions: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.sm, flexWrap: 'wrap', alignItems: 'center' },
    resetConfirmRow: { flexDirection: 'row', gap: spacing.md, alignItems: 'center' },
    resetLink: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    linkPrimary: { ...typography.caption, color: c.primary, fontWeight: '500' },
    linkDanger: { ...typography.caption, color: c.error, fontWeight: '500' },
    linkMuted: { ...typography.caption, color: c.mutedForeground },

    vacationBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      padding: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.success,
      backgroundColor: c.successBg,
    },
    vacationIcon: {
      width: 32, height: 32, borderRadius: radius.full,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: 'rgba(34,197,94,0.15)',
    },
    vacationTitle: { ...typography.bodyMedium, color: c.success },
    vacationDesc: { ...typography.caption, color: c.mutedForeground, marginTop: 2 },

    emptyState: { alignItems: 'center', paddingVertical: spacing.xxl, gap: spacing.md },
    emptyText: { ...typography.body, color: c.mutedForeground },

    ruleRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
      padding: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
    },
    ruleDisabled: { opacity: 0.6 },
    ruleNameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' },
    ruleName: { ...typography.bodyMedium, color: c.text, flexShrink: 1 },
    ruleSummary: { ...typography.caption, color: c.mutedForeground, marginTop: 2 },
    rawBlock: {
      ...typography.caption,
      color: c.mutedForeground,
      fontFamily: 'monospace',
      marginTop: spacing.sm,
      padding: spacing.sm,
      backgroundColor: c.muted,
      borderRadius: radius.xs,
    },
    originBadge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.full, backgroundColor: c.muted },
    originBadgeText: { fontSize: 10, fontWeight: '500', color: c.mutedForeground },

    reorderCol: { alignItems: 'center' },
    reorderBtn: { padding: 2 },
    reorderBtnDisabled: { opacity: 0.25 },
    deleteBtn: {
      width: 28, height: 28,
      alignItems: 'center', justifyContent: 'center',
      borderRadius: radius.sm,
    },

    footer: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.md,
      flexWrap: 'wrap',
    },
    footerBtns: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
    footerRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
    expandedToggle: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    expandedLabel: { ...typography.caption, color: c.mutedForeground },
  });
}
