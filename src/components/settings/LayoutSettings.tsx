import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { ArrowRight, ArrowLeft } from 'lucide-react-native';
import { SettingsSection, RadioGroup } from './settings-section';
import { spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSettingsStore, type SwipeAction, type SwipeMode } from '../../stores/settings-store';

const SWIPE_OPTIONS: { value: SwipeAction; label: string }[] = [
  { value: 'none',    label: 'None' },
  { value: 'archive', label: 'Archive' },
  { value: 'delete',  label: 'Delete' },
  { value: 'spam',    label: 'Spam' },
  { value: 'read',    label: 'Read/Unread' },
  { value: 'star',    label: 'Star' },
  { value: 'pin',     label: 'Pin' },
  { value: 'move',    label: 'Move to folder' },
];

const SWIPE_MODE_OPTIONS: { value: SwipeMode; label: string }[] = [
  { value: 'instant', label: 'Instant (swipe = action)' },
  { value: 'reveal',  label: 'Reveal (swipe, then tap)' },
];

export function LayoutSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const swipeLeftAction = useSettingsStore((s) => s.swipeLeftAction);
  const setSwipeLeftAction = useSettingsStore((s) => s.setSwipeLeftAction);
  const swipeRightAction = useSettingsStore((s) => s.swipeRightAction);
  const setSwipeRightAction = useSettingsStore((s) => s.setSwipeRightAction);
  const swipeMode = useSettingsStore((s) => s.swipeMode);
  const setSwipeMode = useSettingsStore((s) => s.setSwipeMode);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);

  useEffect(() => { if (!hydrated) void hydrate(); }, [hydrated, hydrate]);

  return (
    <SettingsSection title="Layout" description="Tune the email list interactions for mobile.">
      <View style={{ gap: spacing.sm }}>
        <Text style={styles.rowLabel}>Swipe behavior</Text>
        <Text style={styles.rowDescription}>
          Pick instant (swipe past the threshold to fire the action) or reveal
          (swipe to expose an action band, then tap to confirm).
        </Text>
        <RadioGroup
          value={swipeMode}
          onChange={(v) => setSwipeMode(v as SwipeMode)}
          options={SWIPE_MODE_OPTIONS}
        />
      </View>

      <View style={{ gap: spacing.sm, marginTop: spacing.lg }}>
        <View style={styles.row}>
          <ArrowRight size={14} color={c.mutedForeground} />
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
          <ArrowLeft size={14} color={c.mutedForeground} />
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

    </SettingsSection>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowLabel: { ...typography.bodyMedium, color: c.text },
  rowDescription: { ...typography.caption, color: c.mutedForeground },
});
}
