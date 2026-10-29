import React from 'react';
import { View, Text, StyleSheet, Pressable, FlatList, ActivityIndicator } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { ArrowLeft, X, Folder, FileText, Check, ChevronRight } from '../icons';
import { getAllFileNodes, fileNodeKind } from '../../api/files';
import type { FileNode } from '../../api/types';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useLocaleStore } from '../../stores/locale-store';
import { SafeAreaModal } from '../SafeAreaModal';
import { MODAL_ORIENTATIONS } from '../../lib/modal-orientations';
import { folderPath, pickerEntries } from '../../lib/compose-files';
import { formatSize } from '../../lib/attachment-display';

type Props =
  | {
    visible: boolean;
    /** Pick files to attach (#1179). */
    mode: 'files';
    onClose: () => void;
    onPickFiles: (nodes: FileNode[]) => void;
  }
  | {
    visible: boolean;
    /** Pick the folder an attachment is saved to. */
    mode: 'folder';
    onClose: () => void;
    onPickFolder: (parentId: string | null, folderName: string) => void;
  };

/**
 * The user's Files, folder by folder: pick files to attach, or the folder
 * to save an attachment in (webmail file-picker-dialog and the Save to
 * Files folder picker). Own files only, without the hidden ones.
 */
export function FilesPickerSheet(props: Props) {
  const { visible, mode, onClose } = props;
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const [nodes, setNodes] = React.useState<FileNode[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [here, setHere] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<FileNode[]>([]);

  const load = React.useCallback(() => {
    setNodes(null);
    setError(null);
    getAllFileNodes().then(
      (list) => setNodes(list),
      (e: unknown) => {
        console.warn('[files-picker] listing failed', e);
        setError(t('email_composer.files_picker.load_failed', 'Your files could not be loaded'));
      },
    );
  }, [t]);

  React.useEffect(() => {
    if (!visible) return;
    setHere(null);
    setSelected([]);
    load();
  }, [visible, load]);

  const entries = React.useMemo(
    () => (nodes ? pickerEntries(nodes, here, mode === 'folder') : []),
    [nodes, here, mode],
  );
  const path = React.useMemo(() => (nodes ? folderPath(nodes, here) : []), [nodes, here]);
  const myFiles = t('files.my_files', 'My files');
  const title = mode === 'folder'
    ? t('email_viewer.save_to_files.title', 'Save to Files')
    : t('email_composer.attach_from_files', 'Attach from Files');

  const toggle = (node: FileNode) => setSelected((prev) => (prev.some((n) => n.id === node.id)
    ? prev.filter((n) => n.id !== node.id)
    : [...prev, node]));

  const confirm = () => {
    if (props.mode === 'folder') {
      props.onPickFolder(here, path.at(-1)?.name ?? myFiles);
    } else if (selected.length > 0) {
      props.onPickFiles(selected);
    }
  };

  const renderItem = ({ item }: { item: FileNode }) => {
    const folder = fileNodeKind(item) === 'directory';
    const isSelected = selected.some((n) => n.id === item.id);
    return (
      <Pressable
        style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
        onPress={() => (folder ? setHere(item.id) : toggle(item))}
        accessibilityRole="button"
        accessibilityState={folder ? undefined : { selected: isSelected }}
      >
        {folder ? <Folder size={18} color={c.primary} /> : <FileText size={18} color={c.textSecondary} />}
        <View style={styles.rowMain}>
          <Text style={styles.rowName} numberOfLines={1}>{item.name}</Text>
          {!folder && item.size != null && <Text style={styles.rowMeta}>{formatSize(item.size)}</Text>}
        </View>
        {folder
          ? <ChevronRight size={16} color={c.textMuted} />
          : isSelected && <Check size={18} color={c.primary} />}
      </Pressable>
    );
  };

  const confirmLabel = mode === 'folder'
    ? t('email_viewer.save_to_files.save_here', 'Save here')
    : t('email_composer.files_picker.attach', '{count, plural, =0 {Attach} one {Attach 1 file} other {Attach # files}}', { count: selected.length });

  return (
    <SafeAreaModal
      supportedOrientations={MODAL_ORIENTATIONS}
      visible={visible}
      animationType="slide"
      onRequestClose={here !== null ? () => setHere(path.at(-2)?.id ?? null) : onClose}
    >
      <SafeAreaView style={styles.container} edges={['top', 'bottom', 'left', 'right']}>
        <View style={styles.header}>
          <Pressable
            onPress={here !== null ? () => setHere(path.at(-2)?.id ?? null) : onClose}
            style={styles.headerBtn}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={here !== null ? t('common.back', 'Back') : t('common.close', 'Close')}
          >
            {here !== null ? <ArrowLeft size={22} color={c.text} /> : <X size={22} color={c.text} />}
          </Pressable>
          <View style={styles.headerText}>
            <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
            <Text style={styles.headerPath} numberOfLines={1}>
              {[myFiles, ...path.map((n) => n.name)].join(' / ')}
            </Text>
          </View>
        </View>

        {error ? (
          <View style={styles.center}>
            <Text style={styles.error}>{error}</Text>
            <Pressable onPress={load}>
              <Text style={styles.retry}>{t('common.retry', 'Retry')}</Text>
            </Pressable>
          </View>
        ) : !nodes ? (
          <View style={styles.center}><ActivityIndicator color={c.primary} /></View>
        ) : (
          <FlatList
            data={entries}
            keyExtractor={(n) => n.id}
            renderItem={renderItem}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            ListEmptyComponent={(
              <View style={styles.center}>
                <Text style={styles.empty}>{t('email_composer.files_picker.empty_folder', 'This folder is empty')}</Text>
              </View>
            )}
          />
        )}

        <View style={styles.footer}>
          <Pressable
            onPress={confirm}
            disabled={!nodes || (mode === 'files' && selected.length === 0)}
            style={({ pressed }) => [
              styles.confirm,
              (!nodes || (mode === 'files' && selected.length === 0)) && styles.confirmDisabled,
              pressed && styles.rowPressed,
            ]}
            accessibilityRole="button"
          >
            <Text style={styles.confirmText}>{confirmLabel}</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    </SafeAreaModal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { flex: 1, backgroundColor: c.background },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      minHeight: componentSizes.headerHeight,
      paddingHorizontal: spacing.lg,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      gap: spacing.sm,
    },
    headerBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: radius.md },
    headerText: { flex: 1, minWidth: 0 },
    headerTitle: { ...typography.h3, color: c.text },
    headerPath: { ...typography.caption, color: c.textMuted },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      minHeight: 52,
    },
    rowPressed: { opacity: 0.7 },
    rowMain: { flex: 1, minWidth: 0 },
    rowName: { ...typography.body, color: c.text },
    rowMeta: { ...typography.caption, color: c.textMuted },
    separator: { height: StyleSheet.hairlineWidth, backgroundColor: c.border },
    center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.sm, padding: spacing.lg },
    empty: { ...typography.body, color: c.textSecondary },
    error: { ...typography.body, color: c.error, textAlign: 'center' },
    retry: { ...typography.bodyMedium, color: c.primary, marginTop: spacing.sm },
    footer: { padding: spacing.md, borderTopWidth: 1, borderTopColor: c.border },
    confirm: {
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: 44,
      borderRadius: radius.sm,
      backgroundColor: c.primary,
    },
    confirmDisabled: { opacity: 0.5 },
    confirmText: { ...typography.bodyMedium, color: c.primaryForeground },
  });
}
