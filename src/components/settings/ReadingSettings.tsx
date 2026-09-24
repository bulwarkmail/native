import React, { useEffect, useState } from 'react';
import { ActivityIndicator, View, Text, StyleSheet, Pressable, TextInput } from 'react-native';
import { AlertTriangle, FolderSync, X } from 'lucide-react-native';
import { SettingsSection, SettingItem, Select, ToggleSwitch } from './settings-section';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import {
  useSettingsStore,
  type ArchiveMode,
  type DeleteAction,
  type MailAttachmentAction,
  type AttachmentPosition,
  type PlainTextFont,
  type MessageSpacing,
  type ReadReceiptResponse,
} from '../../stores/settings-store';
import { useEmailStore } from '../../stores/email-store';
import { archiveEmails, queryEmails, getEmails } from '../../api/email';
import { ownMailboxes } from '../../lib/mailbox-tree';
import { useLocaleStore } from '../../stores/locale-store';

export function ReadingSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const t = useLocaleStore((s) => s.t);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const update = useSettingsStore((s) => s.updateSetting);

  const archiveMode = useSettingsStore((s) => s.archiveMode);
  const markAsReadDelay = useSettingsStore((s) => s.markAsReadDelay);
  const deleteAction = useSettingsStore((s) => s.deleteAction);
  const permanentlyDeleteJunk = useSettingsStore((s) => s.permanentlyDeleteJunk);
  const showPreview = useSettingsStore((s) => s.showPreview);
  const clearSearchOnFolderChange = useSettingsStore((s) => s.clearSearchOnFolderChange);
  const disableThreading = useSettingsStore((s) => s.disableThreading);
  const includeGroupInUnified = useSettingsStore((s) => s.includeGroupInUnified);
  const autoSelectReplyIdentity = useSettingsStore((s) => s.autoSelectReplyIdentity);
  const plainTextMode = useSettingsStore((s) => s.plainTextMode);
  const emailsPerPage = useSettingsStore((s) => s.emailsPerPage);
  const mailAttachmentAction = useSettingsStore((s) => s.mailAttachmentAction);
  const attachmentPosition = useSettingsStore((s) => s.attachmentPosition);
  const attachmentReminderEnabled = useSettingsStore((s) => s.attachmentReminderEnabled);
  const attachmentReminderKeywords = useSettingsStore((s) => s.attachmentReminderKeywords);
  const hideInlineImageAttachments = useSettingsStore((s) => s.hideInlineImageAttachments);
  const plainTextFont = useSettingsStore((s) => s.plainTextFont);
  const messageSpacing = useSettingsStore((s) => s.messageSpacing);
  const readReceiptResponse = useSettingsStore((s) => s.readReceiptResponse);

  const [newKeyword, setNewKeyword] = useState('');
  const [reorganizing, setReorganizing] = useState(false);
  const [reorganizeResult, setReorganizeResult] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  const handleReorganizeArchive = async () => {
    const { mailboxes, fetchMailboxes } = useEmailStore.getState();
    // Reorganising runs against the user's own archive only.
    const archiveMailbox = ownMailboxes(mailboxes).find(
      (m) => m.role === 'archive' || m.name.toLowerCase() === 'archive',
    );
    if (!archiveMailbox) {
      setReorganizeResult(t('settings.email_behavior.archive_mode.no_archive', "No archive folder found."));
      return;
    }

    setReorganizing(true);
    setReorganizeResult(null);

    try {
      // Drain the archive in pages so we don't OOM on huge mailboxes.
      const PAGE = 100;
      let position = 0;
      let total = 0;
      let moved = 0;

      while (true) {
        const { ids, total: pageTotal } = await queryEmails(archiveMailbox.id, {
          position,
          limit: PAGE,
        });
        if (position === 0) total = pageTotal;
        if (ids.length === 0) break;

        const list = await getEmails(ids);
        const refreshed = ownMailboxes(useEmailStore.getState().mailboxes);
        await archiveEmails(
          list.map((e) => ({ id: e.id, receivedAt: e.receivedAt })),
          archiveMailbox.id,
          archiveMode,
          refreshed,
        );
        moved += list.length;

        // Newly-created year/month folders need to be visible to the next batch
        // so we don't try to create the same folder twice.
        await fetchMailboxes();

        // Items just got moved out of the root archive view; the next page
        // starts again at position 0 of the now-shorter list.
        if (ids.length < PAGE) break;
      }

      setReorganizeResult(t('settings.email_behavior.archive_mode.reorganize_result', 'Moved {moved} of {total} emails.', { moved, total }));
    } catch (err) {
      setReorganizeResult(err instanceof Error ? err.message : t('settings.email_behavior.archive_mode.reorganize_error', "Failed to reorganize archive"));
    } finally {
      setReorganizing(false);
    }
  };

  return (
    <SettingsSection title={t('settings.email_behavior.title', "Email Behavior")} description={t('settings.email_behavior.description', "Configure how emails are handled")}>
      <SettingItem label={t('settings.email_behavior.mark_read.label', "Mark as Read")} description={t('settings.email_behavior.mark_read.description', "When to mark emails as read when opened")}>
        <Select
          value={String(markAsReadDelay)}
          onChange={(v) => update('markAsReadDelay', Number(v))}
          options={[
            { value: '0', label: t('settings.email_behavior.mark_read.instant', "Instantly") },
            { value: '3000', label: t('settings.email_behavior.mark_read.delay_3s', "After 3 seconds") },
            { value: '5000', label: t('settings.email_behavior.mark_read.delay_5s', "After 5 seconds") },
            { value: '-1', label: t('settings.email_behavior.mark_read.never', "Never") },
          ]}
        />
      </SettingItem>

      <View style={styles.group}>
        <SettingItem label={t('settings.email_behavior.delete_action.label', "Delete Action")} description={t('settings.email_behavior.delete_action.description', "What happens when you delete an email")} noBorder />
        <Select
          value={deleteAction}
          onChange={(v) => update('deleteAction', v as DeleteAction)}
          options={[
            { value: 'trash', label: t('settings.email_behavior.delete_action.trash', "Move to Trash") },
            { value: 'trash-and-read', label: t('settings.email_behavior.delete_action.trash_and_read', "Move to Trash and mark as read") },
            { value: 'permanent', label: t('settings.email_behavior.delete_action.permanent', "Delete Permanently") },
          ]}
        />
        {deleteAction === 'permanent' && (
          <View style={styles.warning}>
            <AlertTriangle size={14} color={c.error} />
            <Text style={styles.warningText}>{t('settings.email_behavior.delete_action.warning', "Emails will be permanently deleted and cannot be recovered. This action is irreversible.")}</Text>
          </View>
        )}
        <View style={styles.divider} />
      </View>

      <View style={styles.group}>
        <SettingItem label={t('settings.email_behavior.archive_mode.label', "Archive in")} description={t('settings.email_behavior.archive_mode.description', "How to organize emails when archiving")} noBorder />
        <Select
          value={archiveMode}
          onChange={(v) => update('archiveMode', v as ArchiveMode)}
          options={[
            { value: 'single', label: t('settings.email_behavior.archive_mode.single', "A single folder") },
            { value: 'year', label: t('settings.email_behavior.archive_mode.year', "A folder per year") },
            { value: 'month', label: t('settings.email_behavior.archive_mode.month', "A folder per month") },
          ]}
        />
        {archiveMode !== 'single' && (
          <>
            <Pressable
              style={[styles.inlineBtn, reorganizing && styles.inlineBtnDisabled]}
              onPress={reorganizing ? undefined : handleReorganizeArchive}
              disabled={reorganizing}
            >
              {reorganizing ? (
                <ActivityIndicator size="small" color={c.text} />
              ) : (
                <FolderSync size={14} color={c.text} />
              )}
              <Text style={styles.inlineBtnText}>
                {reorganizing ? t('settings.email_behavior.archive_mode.reorganizing', "Reorganizing…") : t('settings.email_behavior.archive_mode.reorganize', "Reorganize existing archive")}
              </Text>
            </Pressable>
            {reorganizeResult && (
              <Text style={styles.reorganizeResult}>{reorganizeResult}</Text>
            )}
          </>
        )}
        <View style={styles.divider} />
      </View>

      <SettingItem label={t('settings.email_behavior.permanently_delete_junk.label', "Permanently Delete Junk")} description={t('settings.email_behavior.permanently_delete_junk.description', "Permanently delete emails from the Junk/Spam folder instead of moving them to Trash")}>
        <ToggleSwitch checked={permanentlyDeleteJunk} onChange={(v) => update('permanentlyDeleteJunk', v)} />
      </SettingItem>

      <SettingItem label={t('settings.email_behavior.clear_search_on_folder_change.label', "Clear search when switching folders")} description={t('settings.email_behavior.clear_search_on_folder_change.description', "Clicking a folder (Inbox, Sent, …) clears the active search and browses that folder. When off, the search stays applied and re-runs in the folder you switch to.")}>
        <ToggleSwitch checked={clearSearchOnFolderChange} onChange={(v) => update('clearSearchOnFolderChange', v)} />
      </SettingItem>

      <SettingItem label={t('settings.email_behavior.show_preview.label', "Show Preview Text")} description={t('settings.email_behavior.show_preview.description', "Display email preview in the list")}>
        <ToggleSwitch checked={showPreview} onChange={(v) => update('showPreview', v)} />
      </SettingItem>

      <SettingItem label={t('settings.email_behavior.disable_threading.label', "Disable Conversation Grouping")} description={t('settings.email_behavior.disable_threading.description', "Show emails as individual messages instead of grouped by conversation")}>
        <ToggleSwitch checked={disableThreading} onChange={(v) => update('disableThreading', v)} />
      </SettingItem>

      <SettingItem label={t('settings.appearance.unified_mailbox.include_group.label', "Include group inboxes")} description={t('settings.appearance.unified_mailbox.include_group.description', "Also merge shared/group inboxes into the unified view.")}>
        <ToggleSwitch checked={includeGroupInUnified} onChange={(v) => update('includeGroupInUnified', v)} />
      </SettingItem>

      <SettingItem label={t('settings.email_behavior.plain_text_mode.label', "Plain Text Only")} description={t('settings.email_behavior.plain_text_mode.description_mobile', "Compose and read in plain text only.")}>
        <ToggleSwitch checked={plainTextMode} onChange={(v) => update('plainTextMode', v)} />
      </SettingItem>

      <SettingItem label={t('settings.email_behavior.auto_select_reply_identity.label', "Reply From Received Address")} description={t('settings.email_behavior.auto_select_reply_identity.description_mobile', "When replying, send from the address the message was originally sent to.")}>
        <ToggleSwitch checked={autoSelectReplyIdentity} onChange={(v) => update('autoSelectReplyIdentity', v)} />
      </SettingItem>

      <SettingItem label={t('settings.email_behavior.attachment_reminder.label', "Attachment Reminder")} description={t('settings.email_behavior.attachment_reminder.description', "Warn before sending when your message mentions attachments but none are attached")}>
        <ToggleSwitch
          checked={attachmentReminderEnabled}
          onChange={(v) => update('attachmentReminderEnabled', v)}
        />
      </SettingItem>

      {attachmentReminderEnabled && (
        <View style={styles.group}>
          <Text style={styles.subLabel}>{t('settings.email_behavior.attachment_reminder.keywords_label', "Trigger keywords")}</Text>
          <Text style={styles.subDesc}>{t('settings.email_behavior.attachment_reminder.keywords_description', "Words or phrases that trigger the reminder when found in your message")}</Text>
          <View style={styles.chipRow}>
            {attachmentReminderKeywords.map((kw) => (
              <View key={kw} style={styles.chip}>
                <Text style={styles.chipText}>{kw}</Text>
                <Pressable
                  onPress={() =>
                    update(
                      'attachmentReminderKeywords',
                      attachmentReminderKeywords.filter((k) => k !== kw),
                    )
                  }
                  hitSlop={6}
                >
                  <X size={12} color={c.mutedForeground} />
                </Pressable>
              </View>
            ))}
          </View>
          <View style={styles.addKeywordRow}>
            <TextInput
              value={newKeyword}
              onChangeText={setNewKeyword}
              placeholder={t('settings.email_behavior.attachment_reminder.add_placeholder', "Add keyword...")}
              placeholderTextColor={c.mutedForeground}
              style={styles.keywordInput}
              onSubmitEditing={() => {
                const t = newKeyword.trim().toLowerCase();
                if (t && !attachmentReminderKeywords.includes(t)) {
                  update('attachmentReminderKeywords', [...attachmentReminderKeywords, t]);
                }
                setNewKeyword('');
              }}
            />
            <Pressable
              style={styles.addKeywordBtn}
              onPress={() => {
                const t = newKeyword.trim().toLowerCase();
                if (t && !attachmentReminderKeywords.includes(t)) {
                  update('attachmentReminderKeywords', [...attachmentReminderKeywords, t]);
                }
                setNewKeyword('');
              }}
            >
              <Text style={styles.addKeywordText}>{t('settings.email_behavior.attachment_reminder.add', "Add")}</Text>
            </Pressable>
          </View>
          <View style={styles.divider} />
        </View>
      )}

      <SettingItem label={t('settings.email_behavior.hide_inline_image_attachments.label', "Hide inline images from attachments")} description={t('settings.email_behavior.hide_inline_image_attachments.description', "Images embedded in the message body are not listed as separate attachments")}>
        <ToggleSwitch checked={hideInlineImageAttachments} onChange={(v) => update('hideInlineImageAttachments', v)} />
      </SettingItem>

      <SettingItem label={t('settings.email_behavior.attachment_click_action.label', "Attachment Click Action")} description={t('settings.email_behavior.attachment_click_action.description_mobile', "What happens when you tap an attachment.")}>
        <Select
          value={mailAttachmentAction}
          onChange={(v) => update('mailAttachmentAction', v as MailAttachmentAction)}
          options={[
            { value: 'preview', label: t('settings.email_behavior.attachment_click_action.preview', "Preview when possible") },
            { value: 'download', label: t('settings.email_behavior.attachment_click_action.download', "Download immediately") },
          ]}
        />
      </SettingItem>

      <SettingItem label={t('settings.email_behavior.attachment_position.label', "Attachment Position")} description={t('settings.email_behavior.attachment_position.description', "Where to display attachments in the email header")}>
        <Select
          value={attachmentPosition}
          onChange={(v) => update('attachmentPosition', v as AttachmentPosition)}
          options={[
            { value: 'beside-sender', label: t('settings.email_behavior.attachment_position.beside-sender', "Next to sender") },
            { value: 'below-header', label: t('settings.email_behavior.attachment_position.below-header', "Below header") },
          ]}
        />
      </SettingItem>

      <SettingItem label={t('settings.email_behavior.plain_text_font.label', "Plain Text Font")} description={t('settings.email_behavior.plain_text_font.description', "Font used for plain text emails")}>
        <Select
          value={plainTextFont}
          onChange={(v) => update('plainTextFont', v as PlainTextFont)}
          options={[
            { value: 'sans', label: t('settings.email_behavior.plain_text_font.sans', "Normal (same as the app)") },
            { value: 'mono', label: t('settings.email_behavior.plain_text_font.mono', "Monospace") },
          ]}
        />
      </SettingItem>

      <SettingItem label={t('settings.email_behavior.message_spacing.label', "Message Spacing")} description={t('settings.email_behavior.message_spacing.description', "Padding around the message body in the reader")}>
        <Select
          value={messageSpacing}
          onChange={(v) => update('messageSpacing', v as MessageSpacing)}
          options={[
            { value: 'auto', label: t('settings.email_behavior.message_spacing.auto', "Auto (recommended)") },
            { value: 'always', label: t('settings.email_behavior.message_spacing.always', "Always add spacing") },
            { value: 'edge', label: t('settings.email_behavior.message_spacing.edge', "Edge to edge") },
          ]}
        />
      </SettingItem>

      <SettingItem label={t('settings.email_behavior.read_receipt_response.label', "Respond to read-receipt requests")} description={t('settings.email_behavior.read_receipt_response.description', "What to do when an incoming message asks for a read receipt.")}>
        <Select
          value={readReceiptResponse}
          onChange={(v) => update('readReceiptResponse', v as ReadReceiptResponse)}
          options={[
            { value: 'ask', label: t('settings.email_behavior.read_receipt_response.ask', "Ask each time") },
            { value: 'always', label: t('settings.email_behavior.read_receipt_response.always', "Always send") },
            { value: 'never', label: t('settings.email_behavior.read_receipt_response.never', "Never send") },
          ]}
        />
      </SettingItem>

      <SettingItem label={t('settings.email_behavior.emails_per_page.label', "Emails Per Page")} description={t('settings.email_behavior.emails_per_page.description', "Number of emails to load at once")}>
        <Select
          value={String(emailsPerPage)}
          onChange={(v) => update('emailsPerPage', Number(v))}
          options={[
            { value: '10', label: '10' },
            { value: '25', label: '25' },
            { value: '50', label: '50' },
            { value: '100', label: '100' },
          ]}
        />
      </SettingItem>

    </SettingsSection>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  group: {},
  warning: {
    flexDirection: 'row',
    gap: spacing.sm,
    padding: spacing.sm,
    backgroundColor: 'rgba(239,68,68,0.1)',
    borderRadius: radius.sm,
    marginTop: spacing.sm,
  },
  warningText: {
    ...typography.caption,
    color: c.error,
    flex: 1,
  },
  divider: {
    height: 1,
    backgroundColor: c.border,
    marginTop: spacing.md,
  },
  inlineBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    backgroundColor: c.muted,
    borderRadius: radius.sm,
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
  },
  inlineBtnText: {
    ...typography.body,
    color: c.text,
  },
  inlineBtnDisabled: {
    opacity: 0.6,
  },
  reorganizeResult: {
    ...typography.caption,
    color: c.mutedForeground,
    marginTop: spacing.xs,
  },
  subLabel: {
    ...typography.bodyMedium,
    color: c.text,
    marginTop: spacing.sm,
  },
  subDesc: {
    ...typography.caption,
    color: c.mutedForeground,
    marginTop: 2,
    marginBottom: spacing.sm,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
    backgroundColor: c.muted,
  },
  chipText: {
    ...typography.caption,
    color: c.text,
  },
  addKeywordRow: {
    flexDirection: 'row',
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  keywordInput: {
    flex: 1,
    height: 32,
    paddingHorizontal: spacing.sm,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.sm,
    backgroundColor: c.background,
    color: c.text,
    ...typography.body,
  },
  addKeywordBtn: {
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    backgroundColor: c.muted,
    borderRadius: radius.sm,
  },
  addKeywordText: {
    ...typography.body,
    color: c.text,
  },
  trustedList: {
    marginTop: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.muted,
  },
  trustedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  trustedEmail: { ...typography.caption, color: c.text, flex: 1 },
});
}
