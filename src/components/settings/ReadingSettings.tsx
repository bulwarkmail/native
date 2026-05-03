import React, { useEffect, useState } from 'react';
import { ActivityIndicator, View, Text, StyleSheet, Pressable, TextInput } from 'react-native';
import { AlertTriangle, FolderSync, X } from 'lucide-react-native';
import { SettingsSection, SettingItem, Select, RadioGroup, ToggleSwitch } from './settings-section';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import {
  useSettingsStore,
  type ArchiveMode,
  type DeleteAction,
  type MailLayout,
  type MailAttachmentAction,
  type AttachmentPosition,
} from '../../stores/settings-store';
import { useEmailStore } from '../../stores/email-store';
import { archiveEmails, queryEmails, getEmails } from '../../api/email';

function MailLayoutPreview({ value }: { value: MailLayout }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const isSplit = value === 'split';
  return (
    <View style={styles.layoutPreview}>
      <View>
        <Text style={styles.layoutTitle}>{isSplit ? 'Split' : 'Focus'}</Text>
        <Text style={styles.layoutDesc}>
          {isSplit ? 'List and reader side by side.' : 'Single column for focused reading.'}
        </Text>
      </View>
      <View style={styles.layoutFrame}>
        <View style={styles.layoutRail} />
        {isSplit ? (
          <>
            <View style={styles.layoutList}>
              {[1, 2, 3].map((i) => (
                <View
                  key={i}
                  style={[styles.layoutRow, i === 2 && styles.layoutRowSel]}
                >
                  <Text style={styles.layoutRowName}>Alice</Text>
                  <Text style={styles.layoutRowSub}>Subject line</Text>
                </View>
              ))}
            </View>
            <View style={styles.layoutReader}>
              <View style={[styles.layoutBar, { width: 80 }]} />
              <View style={[styles.layoutBar, { width: '100%', marginTop: 8 }]} />
              <View style={[styles.layoutBar, { width: '85%', marginTop: 6 }]} />
              <View style={[styles.layoutBar, { width: '60%', marginTop: 6 }]} />
            </View>
          </>
        ) : (
          <View style={{ flex: 1, padding: 8 }}>
            {[1, 2, 3].map((i) => (
              <View
                key={i}
                style={[styles.layoutFocus, i === 2 && styles.layoutFocusSel]}
              >
                <Text style={styles.layoutFocusText}>
                  <Text style={{ fontWeight: '500' }}>Alice </Text>
                  Subject line preview…
                </Text>
              </View>
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

export function ReadingSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);
  const update = useSettingsStore((s) => s.updateSetting);

  const archiveMode = useSettingsStore((s) => s.archiveMode);
  const markAsReadDelay = useSettingsStore((s) => s.markAsReadDelay);
  const deleteAction = useSettingsStore((s) => s.deleteAction);
  const permanentlyDeleteJunk = useSettingsStore((s) => s.permanentlyDeleteJunk);
  const showPreview = useSettingsStore((s) => s.showPreview);
  const mailLayout = useSettingsStore((s) => s.mailLayout);
  const disableThreading = useSettingsStore((s) => s.disableThreading);
  const autoSelectReplyIdentity = useSettingsStore((s) => s.autoSelectReplyIdentity);
  const plainTextMode = useSettingsStore((s) => s.plainTextMode);
  const emailsPerPage = useSettingsStore((s) => s.emailsPerPage);
  const mailAttachmentAction = useSettingsStore((s) => s.mailAttachmentAction);
  const attachmentPosition = useSettingsStore((s) => s.attachmentPosition);
  const attachmentReminderEnabled = useSettingsStore((s) => s.attachmentReminderEnabled);
  const attachmentReminderKeywords = useSettingsStore((s) => s.attachmentReminderKeywords);
  const hideInlineImageAttachments = useSettingsStore((s) => s.hideInlineImageAttachments);

  const [newKeyword, setNewKeyword] = useState('');
  const [reorganizing, setReorganizing] = useState(false);
  const [reorganizeResult, setReorganizeResult] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  const handleReorganizeArchive = async () => {
    const { mailboxes, fetchMailboxes } = useEmailStore.getState();
    const archiveMailbox = mailboxes.find(
      (m) => m.role === 'archive' || m.name.toLowerCase() === 'archive',
    );
    if (!archiveMailbox) {
      setReorganizeResult('No archive folder found.');
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
        const refreshed = useEmailStore.getState().mailboxes;
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

      setReorganizeResult(`Moved ${moved} of ${total} emails.`);
    } catch (err) {
      setReorganizeResult(err instanceof Error ? err.message : 'Reorganize failed.');
    } finally {
      setReorganizing(false);
    }
  };

  return (
    <SettingsSection title="Email Behavior" description="How your inbox behaves day to day.">
      <SettingItem label="Mark as Read" description="When to flag an email as read.">
        <Select
          value={String(markAsReadDelay)}
          onChange={(v) => update('markAsReadDelay', Number(v))}
          options={[
            { value: '0', label: 'Instant' },
            { value: '3000', label: 'After 3s' },
            { value: '5000', label: 'After 5s' },
            { value: '-1', label: 'Never' },
          ]}
        />
      </SettingItem>

      <View style={styles.group}>
        <SettingItem label="Delete Action" description="Where deleted emails go." noBorder />
        <Select
          value={deleteAction}
          onChange={(v) => update('deleteAction', v as DeleteAction)}
          options={[
            { value: 'trash', label: 'Move to Trash' },
            { value: 'permanent', label: 'Permanently delete' },
          ]}
        />
        {deleteAction === 'permanent' && (
          <View style={styles.warning}>
            <AlertTriangle size={14} color={c.error} />
            <Text style={styles.warningText}>Permanent deletion cannot be undone.</Text>
          </View>
        )}
        <View style={styles.divider} />
      </View>

      <View style={styles.group}>
        <SettingItem label="Archive Mode" description="Organize archive into subfolders." noBorder />
        <Select
          value={archiveMode}
          onChange={(v) => update('archiveMode', v as ArchiveMode)}
          options={[
            { value: 'single', label: 'Single folder' },
            { value: 'year', label: 'By year' },
            { value: 'month', label: 'By year/month' },
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
                {reorganizing ? 'Reorganizing…' : 'Reorganize existing archive'}
              </Text>
            </Pressable>
            {reorganizeResult && (
              <Text style={styles.reorganizeResult}>{reorganizeResult}</Text>
            )}
          </>
        )}
        <View style={styles.divider} />
      </View>

      <SettingItem label="Permanently Delete Junk" description="Skip the trash when deleting spam.">
        <ToggleSwitch checked={permanentlyDeleteJunk} onChange={(v) => update('permanentlyDeleteJunk', v)} />
      </SettingItem>

      <View style={styles.group}>
        <SettingItem label="Mail Layout" description="Choose between split view and focus view." noBorder />
        <RadioGroup
          value={mailLayout}
          onChange={(v) => update('mailLayout', v as MailLayout)}
          options={[
            { value: 'split', label: 'Split' },
            { value: 'focus', label: 'Focus' },
          ]}
        />
        <MailLayoutPreview value={mailLayout} />
        <View style={styles.divider} />
      </View>

      <SettingItem label="Show Preview" description="Preview text under each subject.">
        <ToggleSwitch checked={showPreview} onChange={(v) => update('showPreview', v)} />
      </SettingItem>

      <SettingItem label="Disable Thread Grouping" description="Show emails individually instead of threaded.">
        <ToggleSwitch checked={disableThreading} onChange={(v) => update('disableThreading', v)} />
      </SettingItem>

      <SettingItem label="Plain Text Mode" description="Compose and read in plain text only.">
        <ToggleSwitch checked={plainTextMode} onChange={(v) => update('plainTextMode', v)} />
      </SettingItem>

      <SettingItem label="Auto-select Reply Identity" description="Pick the best identity when replying.">
        <ToggleSwitch checked={autoSelectReplyIdentity} onChange={(v) => update('autoSelectReplyIdentity', v)} />
      </SettingItem>

      <SettingItem label="Attachment Reminder" description="Warn when the word 'attached' is present but no file is attached.">
        <ToggleSwitch
          checked={attachmentReminderEnabled}
          onChange={(v) => update('attachmentReminderEnabled', v)}
        />
      </SettingItem>

      {attachmentReminderEnabled && (
        <View style={styles.group}>
          <Text style={styles.subLabel}>Trigger Keywords</Text>
          <Text style={styles.subDesc}>Add words that should trigger the reminder.</Text>
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
              placeholder="Add a keyword"
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
              <Text style={styles.addKeywordText}>Add</Text>
            </Pressable>
          </View>
          <View style={styles.divider} />
        </View>
      )}

      <SettingItem label="Hide Inline Image Attachments" description="Don't list inline images in the attachment list.">
        <ToggleSwitch checked={hideInlineImageAttachments} onChange={(v) => update('hideInlineImageAttachments', v)} />
      </SettingItem>

      <SettingItem label="Attachment Click Action" description="What happens when you tap an attachment.">
        <Select
          value={mailAttachmentAction}
          onChange={(v) => update('mailAttachmentAction', v as MailAttachmentAction)}
          options={[
            { value: 'preview', label: 'Preview' },
            { value: 'download', label: 'Download' },
          ]}
        />
      </SettingItem>

      <SettingItem label="Attachment Position" description="Where attachments appear in messages.">
        <Select
          value={attachmentPosition}
          onChange={(v) => update('attachmentPosition', v as AttachmentPosition)}
          options={[
            { value: 'beside-sender', label: 'Beside sender' },
            { value: 'below-header', label: 'Below header' },
          ]}
        />
      </SettingItem>

      <SettingItem label="Emails Per Page" description="How many emails to load at a time.">
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
  layoutPreview: {
    marginTop: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    backgroundColor: c.background,
    padding: spacing.md,
  },
  layoutTitle: {
    ...typography.bodyMedium,
    color: c.text,
  },
  layoutDesc: {
    ...typography.caption,
    color: c.mutedForeground,
    marginTop: 2,
  },
  layoutFrame: {
    flexDirection: 'row',
    height: 112,
    marginTop: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    overflow: 'hidden',
    backgroundColor: 'rgba(24,24,27,0.4)',
  },
  layoutRail: {
    width: 32,
    borderRightWidth: 1,
    borderRightColor: c.border,
    backgroundColor: 'rgba(24,24,27,0.6)',
  },
  layoutList: {
    width: 96,
    borderRightWidth: 1,
    borderRightColor: c.border,
    backgroundColor: c.background,
  },
  layoutRow: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  layoutRowSel: {
    backgroundColor: 'rgba(59,130,246,0.1)',
  },
  layoutRowName: {
    fontSize: 9,
    fontWeight: '500',
    color: c.text,
  },
  layoutRowSub: {
    fontSize: 9,
    color: c.mutedForeground,
  },
  layoutReader: {
    flex: 1,
    padding: spacing.md,
    backgroundColor: c.background,
  },
  layoutBar: {
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(250,250,250,0.1)',
  },
  layoutFocus: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    backgroundColor: 'rgba(24,24,27,0.4)',
    borderRadius: radius.xs,
    marginBottom: 4,
  },
  layoutFocusSel: {
    backgroundColor: 'rgba(59,130,246,0.1)',
  },
  layoutFocusText: {
    fontSize: 9,
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
