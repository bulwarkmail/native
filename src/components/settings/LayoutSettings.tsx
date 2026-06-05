import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { ArrowRight, ArrowLeft, MoveVertical } from 'lucide-react-native';
import { SettingsSection, RadioGroup, Select } from './settings-section';
import { spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import {
  useSettingsStore,
  normalizeBottomQuickActions,
  REPLY_QUICK_ACTIONS,
  ALL_QUICK_ACTIONS,
  type SwipeAction,
  type SwipeMode,
  type QuickAction,
} from '../../stores/settings-store';

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

const QUICK_ACTION_LABELS: Record<QuickAction, string> = {
  reply: 'Reply',
  replyAll: 'Reply All',
  forward: 'Forward',
  delete: 'Delete',
  archive: 'Archive',
  markUnread: 'Mark Read/Unread',
  star: 'Star',
  move: 'Move to folder',
  spam: 'Spam',
  tag: 'Tag',
};

const QUICK_ACTION_OPTIONS = ALL_QUICK_ACTIONS.map((value) => ({
  value,
  label: QUICK_ACTION_LABELS[value],
}));

export function LayoutSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const swipeLeftAction = useSettingsStore((s) => s.swipeLeftAction);
  const setSwipeLeftAction = useSettingsStore((s) => s.setSwipeLeftAction);
  const swipeRightAction = useSettingsStore((s) => s.swipeRightAction);
  const setSwipeRightAction = useSettingsStore((s) => s.setSwipeRightAction);
  const swipeMode = useSettingsStore((s) => s.swipeMode);
  const setSwipeMode = useSettingsStore((s) => s.setSwipeMode);
  const bottomQuickActionsRaw = useSettingsStore((s) => s.bottomQuickActions);
  const update = useSettingsStore((s) => s.updateSetting);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);

  useEffect(() => { if (!hydrated) void hydrate(); }, [hydrated, hydrate]);

  const bottomActions = normalizeBottomQuickActions(bottomQuickActionsRaw);
  // Pick an action for a bar slot. If the chosen action already occupies
  // another slot, swap the two so the three slots stay unique.
  const setQuickActionSlot = (index: number, value: QuickAction) => {
    const next = [...bottomActions];
    const existing = next.indexOf(value);
    if (existing !== -1 && existing !== index) {
      next[existing] = next[index];
    }
    next[index] = value;
    update('bottomQuickActions', next);
  };
  const relocated = REPLY_QUICK_ACTIONS.filter((a) => !bottomActions.includes(a));

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

      <View style={{ gap: spacing.sm, marginTop: spacing.lg }}>
        <View style={styles.row}>
          <MoveVertical size={14} color={c.mutedForeground} />
          <Text style={styles.rowLabel}>Reader quick actions</Text>
        </View>
        <Text style={styles.rowDescription}>
          The three buttons shown between Prev/Next at the bottom of an open
          email. Defaults to Reply, Reply All and Forward.
        </Text>
        {bottomActions.map((action, index) => (
          <View key={index} style={styles.slotRow}>
            <Text style={styles.slotLabel}>Slot {index + 1}</Text>
            <Select
              value={action}
              onChange={(v) => setQuickActionSlot(index, v as QuickAction)}
              options={QUICK_ACTION_OPTIONS}
            />
          </View>
        ))}
        {relocated.length > 0 && (
          <Text style={styles.rowDescription}>
            {relocated.map((a) => QUICK_ACTION_LABELS[a]).join(', ')}
            {relocated.length === 1 ? ' is' : ' are'} moved to the top toolbar so
            you can still use {relocated.length === 1 ? 'it' : 'them'}.
          </Text>
        )}
      </View>

    </SettingsSection>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  rowLabel: { ...typography.bodyMedium, color: c.text },
  rowDescription: { ...typography.caption, color: c.mutedForeground },
  slotRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    marginTop: spacing.xs,
  },
  slotLabel: { ...typography.body, color: c.text },
});
}
