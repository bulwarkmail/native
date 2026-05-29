import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput } from 'react-native';
import { X, Plus } from 'lucide-react-native';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import Button from '../Button';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSettingsStore } from '../../stores/settings-store';

export function ComposingSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const autoSelectReplyIdentity = useSettingsStore((s) => s.autoSelectReplyIdentity);
  const setAutoSelectReplyIdentity = useSettingsStore((s) => s.setAutoSelectReplyIdentity);
  const attachmentReminderEnabled = useSettingsStore((s) => s.attachmentReminderEnabled);
  const setAttachmentReminderEnabled = useSettingsStore((s) => s.setAttachmentReminderEnabled);
  const attachmentReminderKeywords = useSettingsStore((s) => s.attachmentReminderKeywords);
  const setAttachmentReminderKeywords = useSettingsStore((s) => s.setAttachmentReminderKeywords);
  const sendDelaySeconds = useSettingsStore((s) => s.sendDelaySeconds);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);

  const [newKeyword, setNewKeyword] = useState('');

  useEffect(() => { if (!hydrated) void hydrate(); }, [hydrated, hydrate]);

  const addKeyword = () => {
    const trimmed = newKeyword.trim().toLowerCase();
    if (!trimmed || attachmentReminderKeywords.includes(trimmed)) {
      setNewKeyword('');
      return;
    }
    setAttachmentReminderKeywords([...attachmentReminderKeywords, trimmed]);
    setNewKeyword('');
  };

  const removeKeyword = (kw: string) => {
    setAttachmentReminderKeywords(attachmentReminderKeywords.filter((k) => k !== kw));
  };

  const SEND_DELAY_OPTIONS: { label: string; value: number }[] = [
    { label: 'Off', value: 0 },
    { label: '5s', value: 5 },
    { label: '10s', value: 10 },
    { label: '20s', value: 20 },
    { label: '30s', value: 30 },
  ];

  return (
    <SettingsSection
      title="Composing"
      description="How the composer behaves when you reply, forward, or send."
    >
      <SettingItem
        label="Auto-select reply identity"
        description="When replying, pick the identity that received the original message."
      >
        <ToggleSwitch checked={autoSelectReplyIdentity} onChange={setAutoSelectReplyIdentity} />
      </SettingItem>

      <View style={styles.subBlock}>
        <Text style={styles.subLabel}>Undo send delay</Text>
        <Text style={styles.subDescription}>
          Hold outgoing mail for a few seconds so you can cancel it. Requires server support.
        </Text>
        <View style={styles.segmentRow}>
          {SEND_DELAY_OPTIONS.map((opt) => {
            const active = sendDelaySeconds === opt.value;
            return (
              <Pressable
                key={opt.value}
                onPress={() => updateSetting('sendDelaySeconds', opt.value)}
                style={[styles.segment, active && styles.segmentActive]}
              >
                <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <SettingItem
        label="Attachment reminder"
        description="Warn before sending if the message mentions an attachment but none is attached."
      >
        <ToggleSwitch
          checked={attachmentReminderEnabled}
          onChange={setAttachmentReminderEnabled}
        />
      </SettingItem>

      {attachmentReminderEnabled && (
        <View style={styles.subBlock}>
          <Text style={styles.subLabel}>Trigger keywords</Text>
          <Text style={styles.subDescription}>
            Words that, when found in the body or subject without an attachment, trigger the reminder.
          </Text>

          <View style={styles.chips}>
            {attachmentReminderKeywords.map((kw) => (
              <View key={kw} style={styles.chip}>
                <Text style={styles.chipText}>{kw}</Text>
                <Pressable onPress={() => removeKeyword(kw)} hitSlop={6}>
                  <X size={12} color={c.textSecondary} />
                </Pressable>
              </View>
            ))}
          </View>

          <View style={styles.addRow}>
            <TextInput
              value={newKeyword}
              onChangeText={setNewKeyword}
              placeholder="e.g. attached"
              placeholderTextColor={c.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.input}
              onSubmitEditing={addKeyword}
              returnKeyType="done"
            />
            <Button
              variant="default"
              size="sm"
              onPress={addKeyword}
              disabled={!newKeyword.trim()}
              icon={<Plus size={14} color={c.primaryForeground} />}
            >
              Add
            </Button>
          </View>
        </View>
      )}
    </SettingsSection>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  subBlock: { paddingVertical: spacing.md, gap: spacing.sm },
  subLabel: { ...typography.bodyMedium, color: c.text },
  subDescription: { ...typography.caption, color: c.mutedForeground },
  segmentRow: { flexDirection: 'row', gap: 6, marginTop: 4 },
  segment: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 8,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.background,
  },
  segmentActive: { backgroundColor: c.primary, borderColor: c.primary },
  segmentText: { ...typography.caption, color: c.text },
  segmentTextActive: { color: c.primaryForeground, fontWeight: '600' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.full,
    backgroundColor: c.muted,
  },
  chipText: { ...typography.caption, color: c.text },
  addRow: { flexDirection: 'row', gap: spacing.sm, marginTop: 4 },
  input: {
    flex: 1,
    backgroundColor: c.background,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    color: c.text,
    ...typography.body,
  },
});
}
