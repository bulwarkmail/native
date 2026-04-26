import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput } from 'react-native';
import { X, Plus } from 'lucide-react-native';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import Button from '../Button';
import { colors, spacing, radius, typography } from '../../theme/tokens';
import { useSettingsStore } from '../../stores/settings-store';

export function ComposingSettings() {
  const autoSelectReplyIdentity = useSettingsStore((s) => s.autoSelectReplyIdentity);
  const setAutoSelectReplyIdentity = useSettingsStore((s) => s.setAutoSelectReplyIdentity);
  const attachmentReminderEnabled = useSettingsStore((s) => s.attachmentReminderEnabled);
  const setAttachmentReminderEnabled = useSettingsStore((s) => s.setAttachmentReminderEnabled);
  const attachmentReminderKeywords = useSettingsStore((s) => s.attachmentReminderKeywords);
  const setAttachmentReminderKeywords = useSettingsStore((s) => s.setAttachmentReminderKeywords);
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
                  <X size={12} color={colors.textSecondary} />
                </Pressable>
              </View>
            ))}
          </View>

          <View style={styles.addRow}>
            <TextInput
              value={newKeyword}
              onChangeText={setNewKeyword}
              placeholder="e.g. attached"
              placeholderTextColor={colors.textMuted}
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
              icon={<Plus size={14} color={colors.primaryForeground} />}
            >
              Add
            </Button>
          </View>
        </View>
      )}
    </SettingsSection>
  );
}

const styles = StyleSheet.create({
  subBlock: { paddingVertical: spacing.md, gap: spacing.sm },
  subLabel: { ...typography.bodyMedium, color: colors.text },
  subDescription: { ...typography.caption, color: colors.mutedForeground },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: radius.full,
    backgroundColor: colors.muted,
  },
  chipText: { ...typography.caption, color: colors.text },
  addRow: { flexDirection: 'row', gap: spacing.sm, marginTop: 4 },
  input: {
    flex: 1,
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    color: colors.text,
    ...typography.body,
  },
});
