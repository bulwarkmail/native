import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput } from 'react-native';
import { X, Plus } from 'lucide-react-native';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import Button from '../Button';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSettingsStore, type ReplyIdentityMatch, type SignaturePosition } from '../../stores/settings-store';
import { useLocaleStore } from '../../stores/locale-store';
import { SUPPORTED_SUB_ADDRESS_DELIMITERS } from '../../lib/sub-addressing';

export function ComposingSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const autoSelectReplyIdentity = useSettingsStore((s) => s.autoSelectReplyIdentity);
  const replyIdentityMatch = useSettingsStore((s) => s.replyIdentityMatch);
  const t = useLocaleStore((s) => s.t);
  const setAutoSelectReplyIdentity = useSettingsStore((s) => s.setAutoSelectReplyIdentity);
  const attachmentReminderEnabled = useSettingsStore((s) => s.attachmentReminderEnabled);
  const setAttachmentReminderEnabled = useSettingsStore((s) => s.setAttachmentReminderEnabled);
  const attachmentReminderKeywords = useSettingsStore((s) => s.attachmentReminderKeywords);
  const setAttachmentReminderKeywords = useSettingsStore((s) => s.setAttachmentReminderKeywords);
  const sendDelaySeconds = useSettingsStore((s) => s.sendDelaySeconds);
  const plainTextMode = useSettingsStore((s) => s.plainTextMode);
  const signaturePosition = useSettingsStore((s) => s.signaturePosition);
  const signatureSeparatorEnabled = useSettingsStore((s) => s.signatureSeparatorEnabled);
  const requestReadReceiptDefault = useSettingsStore((s) => s.requestReadReceiptDefault);
  const emptySubjectWarningEnabled = useSettingsStore((s) => s.emptySubjectWarningEnabled);
  const autoSaveDraftInterval = useSettingsStore((s) => s.autoSaveDraftInterval);
  const subAddressDelimiter = useSettingsStore((s) => s.subAddressDelimiter);
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
    // Same set the webmail accepts (0/10/30/60); the store rejects others.
    { label: t('settings.email_behavior.send_delay.off', "Off"), value: 0 },
    { label: t('settings.email_behavior.send_delay.seconds', '{seconds} seconds', { seconds: 10 }), value: 10 },
    { label: t('settings.email_behavior.send_delay.seconds', '{seconds} seconds', { seconds: 30 }), value: 30 },
    { label: t('settings.email_behavior.send_delay.seconds', '{seconds} seconds', { seconds: 60 }), value: 60 },
  ];

  const AUTOSAVE_OPTIONS: { label: string; value: number }[] = [
    { label: t('settings.composer.autosave.30s', 'Every 30 seconds'), value: 30000 },
    { label: t('settings.composer.autosave.1m', 'Every minute'), value: 60000 },
    { label: t('settings.composer.autosave.2m', 'Every 2 minutes'), value: 120000 },
    { label: t('settings.composer.autosave.5m', 'Every 5 minutes'), value: 300000 },
  ];

  const SIGNATURE_POSITIONS: { label: string; value: SignaturePosition }[] = [
    { label: t('settings.email_behavior.signature_position.above_quote', 'Before quoted text'), value: 'above_quote' },
    { label: t('settings.email_behavior.signature_position.below_quote', 'After quoted text'), value: 'below_quote' },
  ];

  const REPLY_IDENTITY_MATCHES: { label: string; value: ReplyIdentityMatch }[] = [
    { label: t('settings.email_behavior.reply_identity_match.exact', 'Exact address only'), value: 'exact' },
    { label: t('settings.email_behavior.reply_identity_match.domain', 'Any address on my domains'), value: 'domain' },
  ];

  const segmented = <T extends string | number>(
    options: { label: string; value: T }[],
    current: T,
    onPick: (value: T) => void,
  ) => (
    <View style={styles.segmentRow}>
      {options.map((opt) => {
        const active = current === opt.value;
        return (
          <Pressable
            key={String(opt.value)}
            onPress={() => onPick(opt.value)}
            style={[styles.segment, active && styles.segmentActive]}
          >
            <Text style={[styles.segmentText, active && styles.segmentTextActive]} numberOfLines={1}>
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  return (
    <SettingsSection
      title={t('settings.composer.title', "Composer")}
      description={t('settings.composer.description', "Configure email composition settings")}
    >
      <SettingItem
        label={t('settings.email_behavior.auto_select_reply_identity.label', "Reply From Received Address")}
        description={t('settings.email_behavior.auto_select_reply_identity.description_mobile', "Replies always come from the identity a message was sent to. With this on, a reply to another address on your domains (a catch-all alias) is sent from that address too.")}
      >
        <ToggleSwitch checked={autoSelectReplyIdentity} onChange={setAutoSelectReplyIdentity} />
      </SettingItem>

      {autoSelectReplyIdentity && (
        <View style={styles.subBlock}>
          <Text style={styles.subLabel}>{t('settings.email_behavior.reply_identity_match.label', 'Received Address Matching')}</Text>
          <Text style={styles.subDescription}>
            {t('settings.email_behavior.reply_identity_match.description', 'Which received addresses count as yours. Exact address only picks one of your configured identities. Same domain also treats any other address on one of your identity domains as a catch-all alias and rewrites the From header to it. Choose exact address if those addresses are distribution lists rather than aliases.')}
          </Text>
          {segmented(REPLY_IDENTITY_MATCHES, replyIdentityMatch, (v) => updateSetting('replyIdentityMatch', v))}
        </View>
      )}

      <SettingItem
        label={t('settings.email_behavior.plain_text_mode.label', "Plain Text Only")}
        description={t('settings.email_behavior.plain_text_mode.description', "Disable the rich text editor and send all emails as plain text only, including replies and forwards")}
      >
        <ToggleSwitch checked={plainTextMode} onChange={(v) => updateSetting('plainTextMode', v)} />
      </SettingItem>

      <SettingItem
        label={t('settings.email_behavior.request_read_receipt.label', "Request read receipts by default")}
        description={t('settings.email_behavior.request_read_receipt.description', "Pre-enable the read-receipt request when composing a new message.")}
      >
        <ToggleSwitch checked={requestReadReceiptDefault} onChange={(v) => updateSetting('requestReadReceiptDefault', v)} />
      </SettingItem>

      <SettingItem
        label={t('settings.email_behavior.empty_subject_warning.label', "Empty subject warning")}
        description={t('settings.email_behavior.empty_subject_warning.description', "Ask for confirmation before sending a message with no subject.")}
      >
        <ToggleSwitch checked={emptySubjectWarningEnabled} onChange={(v) => updateSetting('emptySubjectWarningEnabled', v)} />
      </SettingItem>

      <View style={styles.subBlock}>
        <Text style={styles.subLabel}>{t('settings.email_behavior.signature_position.label', "Signature Position")}</Text>
        <Text style={styles.subDescription}>
          {t('settings.email_behavior.signature_position.description', "Where to insert your signature in replies and forwards. Above the quoted text reads naturally as a closing for the reply; below keeps the original message contiguous.")}
        </Text>
        {segmented(SIGNATURE_POSITIONS, signaturePosition, (v) => updateSetting('signaturePosition', v))}
      </View>

      <SettingItem
        label={t('settings.email_behavior.signature_separator.label', "Signature Delimiter")}
        description={t('settings.email_behavior.signature_separator.description', 'Prefix the signature with the standard "-- " delimiter line (RFC 3676). Turn off if you\'d rather flow straight from your message into the signature.')}
      >
        <ToggleSwitch checked={signatureSeparatorEnabled} onChange={(v) => updateSetting('signatureSeparatorEnabled', v)} />
      </SettingItem>

      <View style={styles.subBlock}>
        <Text style={styles.subLabel}>{t('settings.composer.autosave.label', "Auto-save Interval")}</Text>
        <Text style={styles.subDescription}>
          {t('settings.composer.autosave.description', "How often to save drafts automatically")}
        </Text>
        {segmented(AUTOSAVE_OPTIONS, autoSaveDraftInterval, (v) => updateSetting('autoSaveDraftInterval', v))}
      </View>

      <View style={styles.subBlock}>
        <Text style={styles.subLabel}>{t('settings.email_behavior.sub_address_delimiter.label', "Sub-Address Delimiter")}</Text>
        <Text style={styles.subDescription}>
          {t('settings.email_behavior.sub_address_delimiter.description', "Character separating your username from a sub-address tag. Match the delimiter your mail server uses (e.g. user{delimiter}tag@domain.com).", { delimiter: subAddressDelimiter })}
        </Text>
        {segmented(
          SUPPORTED_SUB_ADDRESS_DELIMITERS.map((d) => ({ label: `user${d}tag`, value: d as string })),
          subAddressDelimiter,
          (v) => updateSetting('subAddressDelimiter', v),
        )}
      </View>

      <View style={styles.subBlock}>
        <Text style={styles.subLabel}>{t('settings.email_behavior.send_delay.label', "Undo send / send delay")}</Text>
        <Text style={styles.subDescription}>
          {t('settings.email_behavior.send_delay.description_mobile', "Hold outgoing mail for a few seconds so you can cancel it. Requires server support.")}
        </Text>
        {segmented(SEND_DELAY_OPTIONS, sendDelaySeconds, (v) => updateSetting('sendDelaySeconds', v))}
      </View>

      <SettingItem
        label={t('settings.email_behavior.attachment_reminder.label', "Attachment Reminder")}
        description={t('settings.email_behavior.attachment_reminder.description', "Warn before sending when your message mentions attachments but none are attached")}
      >
        <ToggleSwitch
          checked={attachmentReminderEnabled}
          onChange={setAttachmentReminderEnabled}
        />
      </SettingItem>

      {attachmentReminderEnabled && (
        <View style={styles.subBlock}>
          <Text style={styles.subLabel}>{t('settings.email_behavior.attachment_reminder.keywords_label', "Trigger keywords")}</Text>
          <Text style={styles.subDescription}>
            {t('settings.email_behavior.attachment_reminder.keywords_description', "Words or phrases that trigger the reminder when found in your message")}
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
              placeholder={t('settings.email_behavior.attachment_reminder.add_placeholder', "Add keyword...")}
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
              {t('settings.email_behavior.attachment_reminder.add', "Add")}
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
    paddingHorizontal: 4,
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
