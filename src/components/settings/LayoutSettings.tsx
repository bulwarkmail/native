import React, { useEffect } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { ArrowRight, ArrowLeft, MoveVertical, ArrowDownWideNarrow } from 'lucide-react-native';
import { SettingsSection, SettingItem, ToggleSwitch, RadioGroup, Select } from './settings-section';
import { spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import {
  useSettingsStore,
  normalizeBottomQuickActions,
  REPLY_QUICK_ACTIONS,
  ALL_QUICK_ACTIONS,
  type SwipeAction,
  type SwipeMode,
  type QuickAction,
} from '../../stores/settings-store';
import { useEmailStore } from '../../stores/email-store';
import { useKeywordsStore } from '../../stores/keywords-store';
import {
  ORDER_PRESETS, detectPreset, presetLevels, sanitizeSortLevels,
  type OrderPreset, type MessageListOrderScope,
} from '../../lib/message-list-order';

type Translate = (key: string, fallback?: string) => string;

const swipeOptions = (t: Translate): { value: SwipeAction; label: string }[] => [
  { value: 'none',    label: t('settings.email_behavior.swipe_actions.none', 'None') },
  { value: 'archive', label: t('settings.email_behavior.swipe_actions.archive', 'Archive') },
  { value: 'delete',  label: t('settings.email_behavior.swipe_actions.delete', 'Delete') },
  { value: 'spam',    label: t('settings.email_behavior.swipe_actions.spam', 'Mark as spam') },
  { value: 'read',    label: t('settings.email_behavior.swipe_actions.mark_read', 'Toggle read') },
  { value: 'star',    label: t('settings.email_behavior.swipe_actions.star', 'Toggle star') },
  { value: 'pin',     label: t('settings.email_behavior.swipe_actions.pin', 'Pin') },
  { value: 'move',    label: t('settings.email_behavior.swipe_actions.move', 'Move to folder') },
];

const swipeModeOptions = (t: Translate): { value: SwipeMode; label: string }[] => [
  { value: 'instant', label: t('settings.layout.swipe_mode.instant', 'Instant (swipe = action)') },
  { value: 'reveal',  label: t('settings.layout.swipe_mode.reveal', 'Reveal (swipe, then tap)') },
];

const quickActionLabels = (t: Translate): Record<QuickAction, string> => ({
  reply: t('email_viewer.reply', 'Reply'),
  replyAll: t('email_viewer.reply_all', 'Reply All'),
  forward: t('email_viewer.forward', 'Forward'),
  delete: t('email_viewer.delete', 'Delete'),
  archive: t('email_viewer.archive', 'Archive'),
  markUnread: t('settings.layout.quick_actions.mark_unread', 'Mark Read/Unread'),
  star: t('settings.layout.quick_actions.star', 'Star'),
  move: t('settings.email_behavior.swipe_actions.move', 'Move to folder'),
  spam: t('settings.layout.quick_actions.spam', 'Spam'),
  tag: t('settings.layout.quick_actions.tag', 'Tag'),
});

const PRESET_FALLBACKS: Partial<Record<OrderPreset, string>> = {
  chronological: 'Newest first',
  unread_first: 'Unread first',
  starred_first: 'Starred first',
  tagged_first: 'Tagged first',
};

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
  const t = useLocaleStore((s) => s.t);
  const SWIPE_OPTIONS = React.useMemo(() => swipeOptions(t), [t]);
  const SWIPE_MODE_OPTIONS = React.useMemo(() => swipeModeOptions(t), [t]);
  const QUICK_ACTION_LABELS = React.useMemo(() => quickActionLabels(t), [t]);
  const QUICK_ACTION_OPTIONS = React.useMemo(
    () => ALL_QUICK_ACTIONS.map((value) => ({ value, label: QUICK_ACTION_LABELS[value] })),
    [QUICK_ACTION_LABELS],
  );

  useEffect(() => { if (!hydrated) void hydrate(); }, [hydrated, hydrate]);

  // Message-list order presets (#718). Any change drops the cached query
  // windows so the list is re-queried under the new order.
  const messageListOrderRaw = useSettingsStore((s) => s.messageListOrder);
  const messageListOrderScope = useSettingsStore((s) => s.messageListOrderScope);
  const showAvatarsInJunk = useSettingsStore((s) => s.showAvatarsInJunk);
  const showFolderTotalCount = useSettingsStore((s) => s.showFolderTotalCount);
  const unifiedCrossAccount = useSettingsStore((s) => s.unifiedCrossAccount);
  const keywordDefs = useKeywordsStore((s) => s.keywords);
  const invalidateListOrder = useEmailStore((s) => s.invalidateListOrder);
  const order = React.useMemo(() => sanitizeSortLevels(messageListOrderRaw), [messageListOrderRaw]);
  const preset = detectPreset(order);
  const orderTagId = order.find((l) => l.criterion === 'tag')?.tagId ?? keywordDefs[0]?.id;
  const setPreset = (next: OrderPreset) => {
    if (next === 'custom') return;
    update('messageListOrder', presetLevels(next, orderTagId));
    invalidateListOrder();
  };
  const setOrderTag = (tagId: string) => {
    update('messageListOrder', presetLevels('tagged_first', tagId));
    invalidateListOrder();
  };
  const setScope = (scope: MessageListOrderScope) => {
    update('messageListOrderScope', scope);
    invalidateListOrder();
  };
  const PRESET_OPTIONS = ORDER_PRESETS.map((value) => ({
    value,
    label: t(`settings.message_list_order.preset_${value}`, PRESET_FALLBACKS[value] ?? value),
  }));
  const SCOPE_OPTIONS: { value: MessageListOrderScope; label: string }[] = [
    { value: 'inbox', label: t('settings.message_list_order.scope_inbox', 'Inbox only') },
    { value: 'all', label: t('settings.message_list_order.scope_all', 'All folders') },
  ];

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
    <SettingsSection title={t('settings.tabs.layout', 'Layout')} description={t('settings.layout.description', 'Tune the email list interactions for mobile.')}>
      <View style={{ gap: spacing.sm }}>
        <View style={styles.row}>
          <ArrowDownWideNarrow size={14} color={c.mutedForeground} />
          <Text style={styles.rowLabel}>{t('settings.message_list_order.title', 'Message list order')}</Text>
        </View>
        <Text style={styles.rowDescription}>
          {t('settings.message_list_order.description', 'Which messages come first in the list. Newest first is the tie-breaker within each group; the header toggle still flips oldest/newest.')}
        </Text>
        <RadioGroup
          value={preset === 'custom' ? 'chronological' : preset}
          onChange={(v) => setPreset(v as OrderPreset)}
          options={PRESET_OPTIONS}
        />
        {preset === 'tagged_first' && keywordDefs.length > 0 && (
          <View style={styles.slotRow}>
            <Text style={styles.slotLabel}>{t('settings.message_list_order.tag', 'Tag')}</Text>
            <Select
              value={orderTagId ?? ''}
              onChange={setOrderTag}
              options={keywordDefs.map((k) => ({ value: k.id, label: k.label }))}
            />
          </View>
        )}
        <Text style={styles.rowDescription}>
          {t('settings.message_list_order.scope', 'Apply to')}
        </Text>
        <RadioGroup
          value={messageListOrderScope}
          onChange={(v) => setScope(v as MessageListOrderScope)}
          options={SCOPE_OPTIONS}
        />
      </View>

      <View style={{ marginTop: spacing.lg }}>
        <SettingItem
          label={t('settings.layout.show_folder_total_count', 'Show total message count on folders')}
          description={t('settings.layout.show_folder_total_count_description', 'Show the total next to the unread count in the folder list.')}
        >
          <ToggleSwitch checked={showFolderTotalCount} onChange={(v) => update('showFolderTotalCount', v)} />
        </SettingItem>
        <SettingItem
          label={t('settings.layout.show_avatars_in_junk', 'Show sender avatars in Junk')}
          description={t('settings.layout.show_avatars_in_junk_description', 'Load sender logos for messages in the Junk folder. Off keeps spam senders from being contacted.')}
        >
          <ToggleSwitch checked={showAvatarsInJunk} onChange={(v) => update('showAvatarsInJunk', v)} />
        </SettingItem>
        <SettingItem
          label={t('settings.layout.unified_cross_account', 'Unified views across accounts')}
          description={t('settings.layout.unified_cross_account_description', 'Combine every signed-in account in "All inboxes". Off keeps the unified views inside the active account and its shared folders.')}
          noBorder
        >
          <ToggleSwitch checked={unifiedCrossAccount} onChange={(v) => update('unifiedCrossAccount', v)} />
        </SettingItem>
      </View>

      <View style={{ gap: spacing.sm, marginTop: spacing.lg }}>
        <Text style={styles.rowLabel}>{t('settings.layout.swipe_mode.label', 'Swipe behavior')}</Text>
        <Text style={styles.rowDescription}>
          {t(
            'settings.layout.swipe_mode.description',
            'Pick instant (swipe past the threshold to fire the action) or reveal (swipe to expose an action band, then tap to confirm).',
          )}
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
          <Text style={styles.rowLabel}>{t('settings.email_behavior.swipe_right_action.label_mobile', "Swipe right (left → right)")}</Text>
        </View>
        <Text style={styles.rowDescription}>
          {t('settings.email_behavior.swipe_right_action.description_mobile', "Action when you drag a row from its left edge towards the right.")}
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
          <Text style={styles.rowLabel}>{t('settings.email_behavior.swipe_left_action.label_mobile', "Swipe left (right → left)")}</Text>
        </View>
        <Text style={styles.rowDescription}>
          {t('settings.email_behavior.swipe_left_action.description_mobile', "Action when you drag a row from its right edge towards the left.")}
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
          <Text style={styles.rowLabel}>{t('settings.layout.quick_actions.label', "Reader quick actions")}</Text>
        </View>
        <Text style={styles.rowDescription}>
          {t('settings.layout.quick_actions.description', "The three buttons shown between Prev/Next at the bottom of an open email. Defaults to Reply, Reply All and Forward.")}
        </Text>
        {bottomActions.map((action, index) => (
          <View key={index} style={styles.slotRow}>
            <Text style={styles.slotLabel}>{t('settings.layout.quick_actions.slot', 'Slot {n}', { n: index + 1 })}</Text>
            <Select
              value={action}
              onChange={(v) => setQuickActionSlot(index, v as QuickAction)}
              options={QUICK_ACTION_OPTIONS}
            />
          </View>
        ))}
        {relocated.length > 0 && (
          <Text style={styles.rowDescription}>
            {t(
              'settings.layout.quick_actions.relocated',
              '{count, plural, one {{actions} is moved to the top toolbar so you can still use it.} other {{actions} are moved to the top toolbar so you can still use them.}}',
              { count: relocated.length, actions: relocated.map((a) => QUICK_ACTION_LABELS[a]).join(', ') },
            )}
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
