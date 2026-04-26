import React, { useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { Plus, GripVertical, X, Code, Filter, AlertTriangle, RotateCcw } from 'lucide-react-native';
import { SettingsSection, ToggleSwitch } from './settings-section';
import Button from '../Button';
import { colors, spacing, radius, typography } from '../../theme/tokens';

interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  summary: string;
  action: string;
}

const SAMPLE_RULES: Rule[] = [];

export function FilterSettings() {
  const [rules, setRules] = useState<Rule[]>(SAMPLE_RULES);
  const [expandedView, setExpandedView] = useState(false);
  const [isOpaque] = useState(false);
  const [deleteId, setDeleteId] = useState<string | null>(null);

  const toggle = (id: string) => {
    setRules((rs) => rs.map((r) => r.id === id ? { ...r, enabled: !r.enabled } : r));
  };

  const remove = (id: string) => {
    setRules((rs) => rs.filter((r) => r.id !== id));
    setDeleteId(null);
  };

  return (
    <View style={styles.container}>
      <SettingsSection title="Filters & Rules" description="Server-side rules that process incoming mail.">
        {isOpaque && (
          <View style={styles.opaqueWarning}>
            <AlertTriangle size={16} color="#fbbf24" />
            <View style={{ flex: 1 }}>
              <Text style={styles.opaqueText}>
                Your Sieve script contains advanced features. Edit raw or reset to visual builder.
              </Text>
              <View style={styles.opaqueActions}>
                <Pressable>
                  <Text style={styles.linkText}>Open Sieve Editor</Text>
                </Pressable>
                <Pressable style={styles.resetLink}>
                  <RotateCcw size={12} color={colors.error} />
                  <Text style={styles.resetText}>Reset to visual</Text>
                </Pressable>
              </View>
            </View>
          </View>
        )}

        {rules.length === 0 && !isOpaque && (
          <View style={styles.emptyState}>
            <Filter size={40} color={colors.mutedForeground} style={{ opacity: 0.4 }} />
            <Text style={styles.emptyText}>No rules yet.</Text>
          </View>
        )}

        {rules.length > 0 && (
          <View style={{ gap: 4 }}>
            {rules.map((rule) => (
              <View key={rule.id} style={[styles.ruleRow, !rule.enabled && styles.ruleDisabled]}>
                <View style={styles.grip}>
                  <GripVertical size={16} color={colors.mutedForeground} />
                </View>

                <ToggleSwitch checked={rule.enabled} onChange={() => toggle(rule.id)} />

                <View style={{ flex: 1 }}>
                  <Text style={styles.ruleName}>{rule.name}</Text>
                  <Text style={styles.ruleSummary} numberOfLines={expandedView ? 0 : 1}>
                    {rule.summary} → {rule.action}
                  </Text>
                </View>

                {deleteId === rule.id ? (
                  <View style={{ flexDirection: 'row', gap: 4 }}>
                    <Button variant="destructive" size="sm" onPress={() => remove(rule.id)}>
                      Confirm
                    </Button>
                    <Button variant="ghost" size="sm" onPress={() => setDeleteId(null)}>
                      Cancel
                    </Button>
                  </View>
                ) : (
                  <Pressable style={styles.iconBtn} onPress={() => setDeleteId(rule.id)}>
                    <X size={16} color={colors.mutedForeground} />
                  </Pressable>
                )}
              </View>
            ))}
          </View>
        )}
      </SettingsSection>

      <View style={styles.footer}>
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          {!isOpaque && (
            <Button variant="outline" size="sm" icon={<Plus size={14} color={colors.text} />}>
              Add Rule
            </Button>
          )}
          <Button variant="outline" size="sm" icon={<Code size={14} color={colors.text} />}>
            Raw Editor
          </Button>
        </View>

        {!isOpaque && rules.length > 0 && (
          <View style={styles.expandedToggle}>
            <Text style={styles.expandedLabel}>Expanded view</Text>
            <ToggleSwitch checked={expandedView} onChange={setExpandedView} />
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: spacing.xl },
  opaqueWarning: {
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
  opaqueActions: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.sm },
  linkText: { ...typography.caption, color: colors.primary, fontWeight: '500' },
  resetLink: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  resetText: { ...typography.caption, color: colors.error, fontWeight: '500' },
  emptyState: { alignItems: 'center', paddingVertical: spacing.xxl, gap: spacing.md },
  emptyText: { ...typography.body, color: colors.mutedForeground },
  ruleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
  },
  ruleDisabled: { opacity: 0.6 },
  grip: { paddingTop: 2 },
  ruleName: { ...typography.bodyMedium, color: colors.text },
  ruleSummary: { ...typography.caption, color: colors.mutedForeground, marginTop: 2 },
  iconBtn: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    flexWrap: 'wrap',
  },
  expandedToggle: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  expandedLabel: { ...typography.caption, color: colors.mutedForeground },
});
