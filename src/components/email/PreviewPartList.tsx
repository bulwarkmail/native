import React from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  File as FileIcon, FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo,
} from '../icons';
import { formatSize } from '../../lib/attachment-display';
import { filePreviewKind, handoffMimeType } from '../../lib/file-preview';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';

/** A file inside a file: an archive entry or an attachment of an .eml. */
export interface PreviewPart {
  key: string;
  name: string;
  /** Folder inside an archive, '' at the top. */
  folder?: string;
  type?: string;
  size?: number;
  read: () => Promise<Uint8Array>;
}

function iconFor(part: PreviewPart) {
  const type = part.type || handoffMimeType(part.name, '');
  if (/\.(xlsx?|ods|csv|tsv|numbers)$/i.test(part.name)) return FileSpreadsheet;
  if (/\.(zip|7z|rar|gz|tgz|tar|bz2|xz)$/i.test(part.name)) return FileArchive;
  // Platform-independent: the icon names the format, not what plays here.
  switch (filePreviewKind({ name: part.name, type }, { platform: 'android' })) {
    case 'image': return FileImage;
    case 'video': return FileVideo;
    case 'audio': return FileAudio;
    case 'none': return /^(application\/(msword|vnd\.|rtf)|text\/)/.test(type) ? FileText : FileIcon;
    default: return FileText;
  }
}

interface Props {
  parts: PreviewPart[];
  /** Opens a part; the row shows a spinner until the promise settles. */
  onOpen: (part: PreviewPart) => Promise<void>;
  /** Above the rows (an .eml's body, an archive's summary). */
  header?: React.ReactElement;
  /** Renders as a plain column inside a parent ScrollView instead of a list of its own. */
  inline?: boolean;
}

/**
 * The files inside an archive or an embedded message, each opening in the
 * file preview like any attachment.
 */
export function PreviewPartList({ parts, onOpen, header, inline = false }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [busy, setBusy] = React.useState<string | null>(null);

  const open = (part: PreviewPart) => {
    if (busy) return;
    setBusy(part.key);
    onOpen(part).finally(() => setBusy(null));
  };

  const renderRow = (part: PreviewPart) => {
    const Icon = iconFor(part);
    return (
      <Pressable
        key={part.key}
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        onPress={() => open(part)}
        disabled={!!busy}
        accessibilityRole="button"
        accessibilityLabel={part.name}
      >
        <View style={styles.icon}>
          {busy === part.key ? <ActivityIndicator size="small" color={c.textMuted} /> : <Icon size={20} color={c.textMuted} />}
        </View>
        <View style={styles.text}>
          <Text style={styles.name} numberOfLines={1}>{part.name}</Text>
          {part.folder ? <Text style={styles.folder} numberOfLines={1}>{part.folder}</Text> : null}
        </View>
        {part.size != null ? <Text style={styles.size}>{formatSize(part.size) || '0 B'}</Text> : null}
      </Pressable>
    );
  };

  if (inline) {
    return (
      <View style={styles.inline}>
        {header}
        {parts.map(renderRow)}
      </View>
    );
  }
  return (
    <FlatList
      style={styles.list}
      data={parts}
      keyExtractor={(p) => p.key}
      renderItem={({ item }) => renderRow(item)}
      ListHeaderComponent={header}
      initialNumToRender={30}
    />
  );
}

/** The summary line above an archive's entries. */
export function ArchiveSummary({ count, truncated }: { count: number; truncated: boolean }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  return (
    <Text style={styles.summary}>
      {truncated
        ? t('email_viewer.preview.archive_first_files', 'The first {count} files', { count })
        : t('email_viewer.preview.archive_files', '{count, plural, one {# file} other {# files}}', { count })}
    </Text>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    list: { flex: 1 },
    inline: { paddingBottom: spacing.lg },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      minHeight: 52,
    },
    rowPressed: { backgroundColor: c.surfaceHover },
    icon: {
      width: 36,
      height: 36,
      borderRadius: radius.md,
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    text: { flex: 1, minWidth: 0 },
    name: { ...typography.body, color: c.text },
    folder: { ...typography.caption, color: c.textMuted },
    size: { ...typography.caption, color: c.textMuted },
    summary: {
      ...typography.caption,
      color: c.textMuted,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.md,
      paddingBottom: spacing.xs,
    },
  });
}
