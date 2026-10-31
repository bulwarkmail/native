import React from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator, Alert } from 'react-native';
import { Download, Eye, ExternalLink, Save, Share2, FolderArchive, FolderOpen } from '../icons';
import type { Attachment, Email } from '../../api/types';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSettingsStore } from '../../stores/settings-store';
import { useLocaleStore } from '../../stores/locale-store';
import {
  shareAttachment, downloadAttachment, shareAttachmentViaSheet, fetchBlobBytes, shareBytes, attachmentSaveName,
} from '../../lib/email-export';
import {
  getAttachmentDisplayName, visibleAttachments, formatSize,
} from '../../lib/attachment-display';
import { emailExportFilename } from '../../lib/download-filename';
import { attachmentKind } from '../../lib/list-attachments';
import { ATTACHMENT_ICONS, attachmentIconColor } from './attachment-icons';
import { ActionSheet, type ActionSheetItem } from './ActionSheet';
import { AttachmentPreviewModal } from './AttachmentPreviewModal';
import type { ExtractedAttachment } from './use-body-override';
import { previewKindOf, useFilePreview, type PreviewSource } from './use-file-preview';
import { supportsFiles } from '../../api/files';
import { saveAttachmentToFiles } from '../../lib/compose-files';
import { toast } from '../../stores/toast-store';
import { FilesPickerSheet } from '../compose/FilesPickerSheet';

interface Props {
  email: Email;
  jmapAccountId?: string;
  calendarBannerShown: boolean;
  tnefUnpacked?: boolean;
  /** Parts extracted client-side (TNEF / embedded message). */
  extracted?: ExtractedAttachment[];
  /** Server-listed parts to leave out (a decrypted PGP/MIME message's control parts). */
  hidePart?: (att: Attachment) => boolean;
}

type Item =
  | { key: string; kind: 'blob'; att: Attachment; name: string; type: string; size?: number }
  | { key: string; kind: 'bytes'; part: ExtractedAttachment; name: string; type: string; size?: number };

const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;

/**
 * Attachment chips: tap follows the "attachment click action" setting
 * (in-app preview when the type supports it, else the platform viewer /
 * save), long-press opens Preview / Open / Save / Share, and "Download all"
 * bundles every part into a zip named by the export template.
 */
export function AttachmentChips({ email, jmapAccountId, calendarBannerShown, tnefUnpacked, extracted, hidePart }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const hideInlineImageAttachments = useSettingsStore((s) => s.hideInlineImageAttachments);
  const mailAttachmentAction = useSettingsStore((s) => s.mailAttachmentAction);
  // Select primitives, not a fresh object: zustand v5 compares snapshots with
  // Object.is, so a selector returning a new object literal on every call
  // reports a change on every render - React then re-renders until it gives
  // up with "Maximum update depth exceeded" (it crashed the whole viewer).
  const exportSpaceReplacement = useSettingsStore((s) => s.exportSpaceReplacement);
  const exportLowercase = useSettingsStore((s) => s.exportLowercase);
  const exportStripDiacritics = useSettingsStore((s) => s.exportStripDiacritics);
  const exportOpts = React.useMemo(
    () => ({
      spaceReplacement: exportSpaceReplacement,
      lowercase: exportLowercase,
      stripDiacritics: exportStripDiacritics,
    }),
    [exportSpaceReplacement, exportLowercase, exportStripDiacritics],
  );

  const [expanded, setExpanded] = React.useState(false);
  const [busyKey, setBusyKey] = React.useState<string | null>(null);
  const [sheetItem, setSheetItem] = React.useState<Item | null>(null);
  // The attachment Save to Files picks a folder for.
  const [filesTarget, setFilesTarget] = React.useState<Extract<Item, { kind: 'blob' }> | null>(null);
  const preview = useFilePreview();

  const items = React.useMemo<Item[]>(() => {
    const blobs = visibleAttachments(email, { hideInlineImageAttachments, calendarBannerShown, tnefUnpacked })
      .filter((att) => !hidePart?.(att))
      .map<Item>((att, i) => ({
        key: att.blobId || `att-${i}`,
        kind: 'blob',
        att,
        name: getAttachmentDisplayName(att.name, att.type),
        type: att.type || 'application/octet-stream',
        size: att.size,
      }));
    const extra = (extracted ?? []).map<Item>((part, i) => ({
      key: `x-${i}-${part.name}`,
      kind: 'bytes',
      part,
      name: getAttachmentDisplayName(part.name, part.type),
      type: part.type,
      size: part.size,
    }));
    return [...blobs, ...extra];
  }, [email, hideInlineImageAttachments, calendarBannerShown, tnefUnpacked, extracted, hidePart]);

  if (items.length === 0) return null;

  const run = async (key: string, fn: () => Promise<void>, failTitle: string) => {
    if (busyKey) return;
    setBusyKey(key);
    try {
      await fn();
    } catch (e) {
      Alert.alert(failTitle, e instanceof Error ? e.message : String(e));
    } finally {
      setBusyKey(null);
    }
  };

  const open = (item: Item) => run(item.key, async () => {
    if (item.kind === 'blob') await shareAttachment(item.att.blobId, item.att.name, item.att.type, email, jmapAccountId);
    else await shareBytes(item.part.bytes, item.name, item.type);
  }, t('email_viewer.attachment_failed', 'Could not open attachment'));

  const save = (item: Item) => run(item.key, async () => {
    if (item.kind === 'blob') await downloadAttachment(item.att.blobId, item.att.name, item.att.type, email, jmapAccountId);
    else await shareBytes(item.part.bytes, item.name, item.type, { forceSheet: true });
  }, t('email_viewer.attachment_failed', 'Could not save attachment'));

  const share = (item: Item) => run(item.key, async () => {
    if (item.kind === 'blob') await shareAttachmentViaSheet(item.att.blobId, item.att.name, item.att.type, email, jmapAccountId);
    else await shareBytes(item.part.bytes, item.name, item.type, { forceSheet: true });
  }, t('email_viewer.attachment_failed', 'Could not share attachment'));

  // File the attachment in the user's Files by its blob: nothing is
  // downloaded. A shared or group mailbox's blob is copied over first
  // (webmail save-to-files-dialog).
  const saveToFiles = (item: Extract<Item, { kind: 'blob' }>, parentId: string | null, folderName: string) => run(item.key, async () => {
    try {
      await saveAttachmentToFiles({ blobId: item.att.blobId, name: item.name, type: item.type }, parentId, jmapAccountId);
    } catch (e) {
      toast.error(
        t('email_viewer.save_to_files.failed', "Couldn't save to Files"),
        e instanceof Error ? e.message : undefined,
      );
      return;
    }
    toast.success(
      t('email_viewer.save_to_files.saved', 'Saved to Files'),
      { message: t('email_viewer.save_to_files.saved_to', 'In {folder}', { folder: folderName }) },
    );
  }, t('email_viewer.save_to_files.failed', "Couldn't save to Files"));

  const sourceOf = (item: Item): PreviewSource => (item.kind === 'blob'
    ? {
      from: 'blob',
      blobId: item.att.blobId,
      accountId: jmapAccountId,
      email,
      name: item.name,
      type: item.type,
      size: item.size,
      saveName: attachmentSaveName(email, item.att.name, item.att.type),
    }
    : { from: 'bytes', bytes: item.part.bytes, name: item.name, type: item.type, size: item.size });

  // The in-app preview where the type has one, else straight to another app.
  const showPreview = (item: Item) => run(
    item.key,
    () => preview.open(sourceOf(item)),
    t('email_viewer.attachment_failed', 'Could not open attachment'),
  );

  const onTap = (item: Item) => {
    if (mailAttachmentAction === 'download') void save(item);
    else void showPreview(item);
  };

  const downloadAll = () => run('__all__', async () => {
    const total = items.reduce((n, i) => n + (i.size ?? 0), 0);
    if (total > MAX_BUNDLE_BYTES) throw new Error(t('email_viewer.bundle_too_large', 'The attachments are too large to bundle.'));
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    const used = new Set<string>();
    for (const item of items) {
      let name = item.name;
      if (used.has(name)) {
        const dot = name.lastIndexOf('.');
        name = dot > 0 ? `${name.slice(0, dot)} (${used.size})${name.slice(dot)}` : `${name} (${used.size})`;
      }
      used.add(name);
      const bytes = item.kind === 'blob'
        ? await fetchBlobBytes(item.att.blobId, item.att.name, item.att.type, jmapAccountId)
        : item.part.bytes;
      zip.file(name, bytes);
    }
    const out = await zip.generateAsync({ type: 'uint8array' });
    const stem = emailExportFilename(email, { ...exportOpts, template: '{date} {subject}' }).replace(/\.eml$/i, '');
    await shareBytes(out, `${stem}.zip`, 'application/zip', { forceSheet: true });
  }, t('email_viewer.attachment_failed', 'Could not bundle attachments'));

  const visible = expanded ? items : items.slice(0, 3);
  const sheetActions: ActionSheetItem[] = sheetItem ? [
    ...(previewKindOf(sheetItem) !== 'none' ? [{
      key: 'preview',
      label: t('email_viewer.attachment_actions.preview', 'Preview'),
      icon: <Eye size={18} color={c.textSecondary} />,
      onPress: () => { const it = sheetItem; setSheetItem(null); void showPreview(it); },
    }] : []),
    {
      key: 'open',
      label: t('email_viewer.attachment_actions.open', 'Open'),
      icon: <ExternalLink size={18} color={c.textSecondary} />,
      onPress: () => { const it = sheetItem; setSheetItem(null); void open(it); },
    },
    {
      key: 'save',
      label: t('email_viewer.attachment_actions.save', 'Save'),
      icon: <Save size={18} color={c.textSecondary} />,
      onPress: () => { const it = sheetItem; setSheetItem(null); void save(it); },
    },
    {
      key: 'share',
      label: t('email_viewer.attachment_actions.share', 'Share'),
      icon: <Share2 size={18} color={c.textSecondary} />,
      onPress: () => { const it = sheetItem; setSheetItem(null); void share(it); },
    },
    ...(sheetItem.kind === 'blob' && supportsFiles() ? [{
      key: 'save_to_files',
      label: t('email_viewer.save_to_files.title', 'Save to Files'),
      icon: <FolderOpen size={18} color={c.textSecondary} />,
      onPress: () => {
        const it = sheetItem;
        setSheetItem(null);
        if (it.kind === 'blob') setFilesTarget(it);
      },
    }] : []),
  ] : [];

  return (
    <View style={styles.block}>
      <View style={styles.row}>
        {visible.map((item) => {
          const busy = busyKey === item.key;
          // Typed and coloured like the list's chips (webmail a78d03a18).
          const kind = attachmentKind(item.type, item.name);
          const Icon = ATTACHMENT_ICONS[kind];
          return (
            <Pressable
              key={item.key}
              style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
              onPress={() => onTap(item)}
              onLongPress={() => setSheetItem(item)}
              disabled={!!busyKey}
              accessibilityLabel={item.name}
            >
              {busy ? <ActivityIndicator size="small" color={c.textMuted} /> : <Icon size={14} color={attachmentIconColor(kind, c)} />}
              <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
              <Text style={styles.size}>{formatSize(item.size)}</Text>
              <Download size={14} color={c.textMuted} />
            </Pressable>
          );
        })}
      </View>
      <View style={styles.footer}>
        {items.length > 3 && (
          <Pressable onPress={() => setExpanded((v) => !v)} style={styles.link} hitSlop={6}>
            <Text style={styles.linkText}>
              {expanded
                ? t('email_viewer.show_less', 'Show less')
                : t('email_viewer.show_all_count', 'Show all ({count})', { count: items.length })}
            </Text>
          </Pressable>
        )}
        {items.length > 1 && (
          <Pressable onPress={downloadAll} style={styles.link} hitSlop={6} disabled={!!busyKey}>
            {busyKey === '__all__' ? <ActivityIndicator size="small" color={c.primary} /> : <FolderArchive size={14} color={c.primary} />}
            <Text style={styles.linkText}>{t('email_viewer.download_all', 'Download all')}</Text>
          </Pressable>
        )}
      </View>

      <ActionSheet
        visible={!!sheetItem}
        title={sheetItem?.name ?? ''}
        subtitle={sheetItem ? `${sheetItem.type}${sheetItem.size ? ` · ${formatSize(sheetItem.size)}` : ''}` : undefined}
        items={sheetActions}
        onClose={() => setSheetItem(null)}
      />

      <AttachmentPreviewModal {...preview.modalProps} />

      <FilesPickerSheet
        visible={!!filesTarget}
        mode="folder"
        onClose={() => setFilesTarget(null)}
        onPickFolder={(parentId, folderName) => {
          const target = filesTarget;
          setFilesTarget(null);
          if (target) void saveToFiles(target, parentId, folderName);
        }}
      />
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    block: {
      backgroundColor: c.background,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      gap: spacing.xs,
    },
    row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
    chip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
      paddingHorizontal: spacing.sm,
      paddingVertical: 6,
      backgroundColor: c.surface,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
    },
    chipPressed: { backgroundColor: c.surfaceHover, opacity: 0.85 },
    name: { ...typography.caption, color: c.text, maxWidth: 180 },
    size: { ...typography.small, color: c.textMuted },
    footer: { flexDirection: 'row', gap: spacing.lg, alignItems: 'center' },
    link: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingVertical: 4 },
    linkText: { ...typography.caption, color: c.primary, fontWeight: '600' },
  });
}
