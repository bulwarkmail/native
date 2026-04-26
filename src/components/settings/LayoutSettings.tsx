import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { ArrowRight, ArrowLeft } from 'lucide-react-native';
import { SettingsSection, SettingItem, RadioGroup } from './settings-section';
import { colors, spacing, typography } from '../../theme/tokens';
import { useSettingsStore, type SwipeAction } from '../../stores/settings-store';

const SWIPE_OPTIONS: { value: SwipeAction; label: string }[] = [
  { value: 'none',    label: 'None' },
  { value: 'archive', label: 'Archive' },
  { value: 'delete',  label: 'Delete' },
  { value: 'spam',    label: 'Spam' },
  { value: 'read',    label: 'Read/Unread' },
  { value: 'star',    label: 'Star' },
];

export function LayoutSettings() {
  const swipeLeftAction = useSettingsStore((s) => s.swipeLeftAction);
  const setSwipeLeftAction = useSettingsStore((s) => s.setSwipeLeftAction);
  const swipeRightAction = useSettingsStore((s) => s.swipeRightAction);
  const setSwipeRightAction = useSettingsStore((s) => s.setSwipeRightAction);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);

  useEffect(() => { if (!hydrated) void hydrate(); }, [hydrated, hydrate]);

  return (
    <SettingsSection title="Layout" description="Tune the email list interactions for mobile.">
      <View style={{ gap: spacing.sm }}>
        <View style={styles.row}>
          <ArrowRight size={14} color={colors.mutedForeground} />
          <Text style={styles.rowLabel}>Swipe right (left → right)</Text>
        </View>
        <Text style={styles.rowDescription}>
          Action when you drag a row from its left edge towards the right.
        </Text>
        <RadioGroup
          value={swipeRightAction}
          onChange={(v) => setSwipeRightAction(v as SwipeAction)}
          options={SWIPE_OPTIONS}
        />
      </View>

      <View style={{ gap: spacing.sm, marginTop: spacing.lg }}>
        <View style={styles.row}>
          <ArrowLeft size={14} color={colors.mutedForeground} />
          <Text style={styles.rowLabel}>Swipe left (right → left)</Text>
        </View>
        <Text style={styles.rowDescription}>
          Action when you drag a row from its right edge towards the left.
        </Text>
        <RadioGroup
          value={swipeLeftAction}
          onChange={(v) => setSwipeLeftAction(v as SwipeAction)}
          options={SWIPE_OPTIONS}
        />
      </View>

      <SettingItem
        label=""
        description="Drag past about half a row to commit; lift earlier to cancel."
      />
    </SettingsSection>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowLabel: { ...typography.bodyMedium, color: colors.text },
  rowDescription: { ...typography.caption, color: colors.mutedForeground },
});
