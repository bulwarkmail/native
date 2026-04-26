import React, { useEffect, useState } from 'react';
import { View, Text, StyleSheet, Pressable, TextInput } from 'react-native';
import { AlertTriangle, FolderSync, Mail, X } from 'lucide-react-native';
import { SettingsSection, SettingItem, Select, RadioGroup, ToggleSwitch } from './settings-section';
import { colors, spacing, radius, typography } from '../../theme/tokens';
import { useSettingsStore, type ExternalContentPolicy } from '../../stores/settings-store';

type MailLayout = 'split' | 'focus';
type DeleteAction = 'trash' | 'permanent';
type ArchiveMode = 'single' | 'year' | 'month';
type AttachmentAction = 'preview' | 'download';
type AttachmentPosition = 'beside-sender' | 'below-header';

const DEFAULT_KEYWORDS = ['attached', 'attachment', 'enclosed', 'attaching'];

function MailLayoutPreview({ value }: { value: MailLayout }) {
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
  const externalContentPolicy = useSettingsStore((s) => s.externalContentPolicy);
  const setExternalContentPolicyStore = useSettingsStore((s) => s.setExternalContentPolicy);
  const trustedSenders = useSettingsStore((s) => s.trustedSenders);
  const removeTrustedSender = useSettingsStore((s) => s.removeTrustedSender);
  const hydrated = useSettingsStore((s) => s.hydrated);
  const hydrate = useSettingsStore((s) => s.hydrate);

  const [markAsReadDelay, setMarkAsReadDelay] = useState('0');
  const [deleteAction, setDeleteAction] = useState<DeleteAction>('trash');
  const [permanentlyDeleteJunk, setPermanentlyDeleteJunk] = useState(false);
  const [showPreview, setShowPreview] = useState(true);
  const [mailLayout, setMailLayout] = useState<MailLayout>('split');
  const [disableThreading, setDisableThreading] = useState(false);
  const [autoSelectReplyIdentity, setAutoSelectReplyIdentity] = useState(true);
  const [plainTextMode, setPlainTextMode] = useState(false);
  const [emailsPerPage, setEmailsPerPage] = useState('25');
  const [mailAttachmentAction, setMailAttachmentAction] = useState<AttachmentAction>('preview');
  const [attachmentPosition, setAttachmentPosition] = useState<AttachmentPosition>('beside-sender');
  const [emailAlwaysLightMode, setEmailAlwaysLightMode] = useState(false);
  const [archiveMode, setArchiveMode] = useState<ArchiveMode>('single');
  const [attachmentReminderEnabled, setAttachmentReminderEnabled] = useState(true);
  const [attachmentReminderKeywords, setAttachmentReminderKeywords] = useState<string[]>(DEFAULT_KEYWORDS);
  const [newKeyword, setNewKeyword] = useState('');
  const [hideInlineImageAttachments, setHideInlineImageAttachments] = useState(true);
  const [trustedSendersAddressBook, setTrustedSendersAddressBook] = useState(false);
  const [showTrustedList, setShowTrustedList] = useState(false);

  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  return (
    <SettingsSection title="Email Behavior" description="How your inbox behaves day to day.">
      <SettingItem label="Mark as Read" description="When to flag an email as read.">
        <Select
          value={markAsReadDelay}
          onChange={setMarkAsReadDelay}
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
          onChange={(v) => setDeleteAction(v as DeleteAction)}
          options={[
            { value: 'trash', label: 'Move to Trash' },
            { value: 'permanent', label: 'Permanently delete' },
          ]}
        />
        {deleteAction === 'permanent' && (
          <View style={styles.warning}>
            <AlertTriangle size={14} color={colors.error} />
            <Text style={styles.warningText}>Permanent deletion cannot be undone.</Text>
          </View>
        )}
        <View style={styles.divider} />
      </View>

      <View style={styles.group}>
        <SettingItem label="Archive Mode" description="Organize archive into subfolders." noBorder />
        <Select
          value={archiveMode}
          onChange={(v) => setArchiveMode(v as ArchiveMode)}
          options={[
            { value: 'single', label: 'Single folder' },
            { value: 'year', label: 'By year' },
            { value: 'month', label: 'By year/month' },
          ]}
        />
        {archiveMode !== 'single' && (
          <Pressable style={styles.inlineBtn}>
            <FolderSync size={14} color={colors.text} />
            <Text style={styles.inlineBtnText}>Reorganize existing archive</Text>
          </Pressable>
        )}
        <View style={styles.divider} />
      </View>

      <SettingItem label="Permanently Delete Junk" description="Skip the trash when deleting spam.">
        <ToggleSwitch checked={permanentlyDeleteJunk} onChange={setPermanentlyDeleteJunk} />
      </SettingItem>

      <View style={styles.group}>
        <SettingItem label="Mail Layout" description="Choose between split view and focus view." noBorder />
        <RadioGroup
          value={mailLayout}
          onChange={(v) => setMailLayout(v as MailLayout)}
          options={[
            { value: 'split', label: 'Split' },
            { value: 'focus', label: 'Focus' },
          ]}
        />
        <MailLayoutPreview value={mailLayout} />
        <View style={styles.divider} />
      </View>

      <SettingItem label="Show Preview" description="Preview text under each subject.">
        <ToggleSwitch checked={showPreview} onChange={setShowPreview} />
      </SettingItem>

      <SettingItem label="Disable Thread Grouping" description="Show emails individually instead of threaded.">
        <ToggleSwitch checked={disableThreading} onChange={setDisableThreading} />
      </SettingItem>

      <SettingItem label="Plain Text Mode" description="Compose and read in plain text only.">
        <ToggleSwitch checked={plainTextMode} onChange={setPlainTextMode} />
      </SettingItem>

      <SettingItem label="Auto-select Reply Identity" description="Pick the best identity when replying.">
        <ToggleSwitch checked={autoSelectReplyIdentity} onChange={setAutoSelectReplyIdentity} />
      </SettingItem>

      <SettingItem label="Attachment Reminder" description="Warn when the word 'attached' is present but no file is attached.">
        <ToggleSwitch
          checked={attachmentReminderEnabled}
          onChange={setAttachmentReminderEnabled}
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
                    setAttachmentReminderKeywords((list) => list.filter((k) => k !== kw))
                  }
                  hitSlop={6}
                >
                  <X size={12} color={colors.mutedForeground} />
                </Pressable>
              </View>
            ))}
          </View>
          <View style={styles.addKeywordRow}>
            <TextInput
              value={newKeyword}
              onChangeText={setNewKeyword}
              placeholder="Add a keyword"
              placeholderTextColor={colors.mutedForeground}
              style={styles.keywordInput}
              onSubmitEditing={() => {
                const t = newKeyword.trim().toLowerCase();
                if (t && !attachmentReminderKeywords.includes(t)) {
                  setAttachmentReminderKeywords([...attachmentReminderKeywords, t]);
                }
                setNewKeyword('');
              }}
            />
            <Pressable
              style={styles.addKeywordBtn}
              onPress={() => {
                const t = newKeyword.trim().toLowerCase();
                if (t && !attachmentReminderKeywords.includes(t)) {
                  setAttachmentReminderKeywords([...attachmentReminderKeywords, t]);
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
        <ToggleSwitch checked={hideInlineImageAttachments} onChange={setHideInlineImageAttachments} />
      </SettingItem>

      <SettingItem label="Attachment Click Action" description="What happens when you tap an attachment.">
        <Select
          value={mailAttachmentAction}
          onChange={(v) => setMailAttachmentAction(v as AttachmentAction)}
          options={[
            { value: 'preview', label: 'Preview' },
            { value: 'download', label: 'Download' },
          ]}
        />
      </SettingItem>

      <SettingItem label="Attachment Position" description="Where attachments appear in messages.">
        <Select
          value={attachmentPosition}
          onChange={(v) => setAttachmentPosition(v as AttachmentPosition)}
          options={[
            { value: 'beside-sender', label: 'Beside sender' },
            { value: 'below-header', label: 'Below header' },
          ]}
        />
      </SettingItem>

      <SettingItem label="Emails Per Page" description="How many emails to load at a time.">
        <Select
          value={emailsPerPage}
          onChange={setEmailsPerPage}
          options={[
            { value: '10', label: '10' },
            { value: '25', label: '25' },
            { value: '50', label: '50' },
            { value: '100', label: '100' },
          ]}
        />
      </SettingItem>

      <SettingItem label="Always Light Mode for Emails" description="Render email content on a white background.">
        <ToggleSwitch checked={emailAlwaysLightMode} onChange={setEmailAlwaysLightMode} />
      </SettingItem>

      <SettingItem label="External Content" description="How to handle images and remote resources in incoming email.">
        <Select
          value={externalContentPolicy}
          onChange={(v) => setExternalContentPolicyStore(v as ExternalContentPolicy)}
          options={[
            { value: 'ask', label: 'Ask' },
            { value: 'block', label: 'Block' },
            { value: 'allow', label: 'Allow' },
          ]}
        />
      </SettingItem>

      <View style={styles.group}>
        <SettingItem
          label="Trusted Senders"
          description="Senders whose external content loads without asking."
          noBorder
        >
          <Pressable style={styles.inlineBtn} onPress={() => setShowTrustedList((v) => !v)}>
            <Text style={styles.inlineBtnText}>
              {trustedSenders.length === 0
                ? 'No trusted senders'
                : `${trustedSenders.length} sender${trustedSenders.length === 1 ? '' : 's'}`}
            </Text>
          </Pressable>
        </SettingItem>
        {showTrustedList && trustedSenders.length > 0 && (
          <View style={styles.trustedList}>
            {trustedSenders.map((email) => (
              <View key={email} style={styles.trustedRow}>
                <Text style={styles.trustedEmail} numberOfLines={1}>{email}</Text>
                <Pressable onPress={() => removeTrustedSender(email)} hitSlop={8}>
                  <X size={14} color={colors.mutedForeground} />
                </Pressable>
              </View>
            ))}
          </View>
        )}
        <View style={styles.divider} />
      </View>

      <SettingItem label="Sync Trusted Senders" description="Store trusted senders in the address book.">
        <ToggleSwitch
          checked={trustedSendersAddressBook}
          onChange={setTrustedSendersAddressBook}
        />
      </SettingItem>
    </SettingsSection>
  );
}

const styles = StyleSheet.create({
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
    color: colors.error,
    flex: 1,
  },
  divider: {
    height: 1,
    backgroundColor: colors.border,
    marginTop: spacing.md,
  },
  inlineBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    backgroundColor: colors.muted,
    borderRadius: radius.sm,
    alignSelf: 'flex-start',
    marginTop: spacing.sm,
  },
  inlineBtnText: {
    ...typography.body,
    color: colors.text,
  },
  subLabel: {
    ...typography.bodyMedium,
    color: colors.text,
    marginTop: spacing.sm,
  },
  subDesc: {
    ...typography.caption,
    color: colors.mutedForeground,
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
    backgroundColor: colors.muted,
  },
  chipText: {
    ...typography.caption,
    color: colors.text,
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
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.background,
    color: colors.text,
    ...typography.body,
  },
  addKeywordBtn: {
    paddingHorizontal: spacing.md,
    justifyContent: 'center',
    backgroundColor: colors.muted,
    borderRadius: radius.sm,
  },
  addKeywordText: {
    ...typography.body,
    color: colors.text,
  },
  layoutPreview: {
    marginTop: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.background,
    padding: spacing.md,
  },
  layoutTitle: {
    ...typography.bodyMedium,
    color: colors.text,
  },
  layoutDesc: {
    ...typography.caption,
    color: colors.mutedForeground,
    marginTop: 2,
  },
  layoutFrame: {
    flexDirection: 'row',
    height: 112,
    marginTop: spacing.md,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    overflow: 'hidden',
    backgroundColor: 'rgba(24,24,27,0.4)',
  },
  layoutRail: {
    width: 32,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    backgroundColor: 'rgba(24,24,27,0.6)',
  },
  layoutList: {
    width: 96,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    backgroundColor: colors.background,
  },
  layoutRow: {
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  layoutRowSel: {
    backgroundColor: 'rgba(59,130,246,0.1)',
  },
  layoutRowName: {
    fontSize: 9,
    fontWeight: '500',
    color: colors.text,
  },
  layoutRowSub: {
    fontSize: 9,
    color: colors.mutedForeground,
  },
  layoutReader: {
    flex: 1,
    padding: spacing.md,
    backgroundColor: colors.background,
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
    color: colors.text,
  },
  trustedList: {
    marginTop: spacing.sm,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.muted,
  },
  trustedRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  trustedEmail: { ...typography.caption, color: colors.text, flex: 1 },
});
