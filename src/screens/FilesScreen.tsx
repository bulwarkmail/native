import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  ChevronLeft, FileText, Folder, HardDrive, FileImage, FileVideo, FileAudio,
  FileArchive, FileSpreadsheet, FileCode2, LayoutGrid, List as ListIcon,
} from 'lucide-react-native';
import { getFileNodes } from '../api/files';
import type { FileNode } from '../api/types';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { useSettingsStore, type FilesViewMode } from '../stores/settings-store';

interface FolderFrame {
  id: string | null;
  name: string;
}

const ROOT_FRAME: FolderFrame = { id: null, name: 'Files' };

function pickFileIcon(name: string) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return FileImage;
  if (['mp4', 'mov', 'webm', 'avi', 'mkv'].includes(ext)) return FileVideo;
  if (['mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus'].includes(ext)) return FileAudio;
  if (['zip', 'rar', 'tar', 'gz', '7z', 'bz2'].includes(ext)) return FileArchive;
  if (['xlsx', 'xls', 'csv', 'numbers'].includes(ext)) return FileSpreadsheet;
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'json', 'xml', 'yaml', 'yml', 'sh'].includes(ext)) return FileCode2;
  return FileText;
}

function fileIconColor(name: string, c: ThemePalette): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) return c.calendar.green;
  if (['mp4', 'mov', 'webm', 'avi', 'mkv'].includes(ext)) return c.calendar.purple;
  if (['mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus'].includes(ext)) return c.calendar.pink;
  if (['zip', 'rar', 'tar', 'gz', '7z', 'bz2'].includes(ext)) return c.calendar.orange;
  if (['xlsx', 'xls', 'csv', 'numbers'].includes(ext)) return c.calendar.teal;
  if (['pdf'].includes(ext)) return c.error;
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'json', 'xml', 'yaml', 'yml', 'sh'].includes(ext)) return c.calendar.indigo;
  return c.textMuted;
}

function isHidden(node: FileNode): boolean {
  return node.name.startsWith('.');
}

function formatFileSize(bytes?: number): string {
  if (bytes == null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatModified(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export default function FilesScreen() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const [stack, setStack] = useState<FolderFrame[]>([ROOT_FRAME]);
  const [files, setFiles] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const showIcons = useSettingsStore((s) => s.filesShowIcons);
  const coloredIcons = useSettingsStore((s) => s.filesColoredIcons);
  const showHiddenFiles = useSettingsStore((s) => s.filesShowHiddenFiles);
  const sortKey = useSettingsStore((s) => s.filesDefaultSortKey);
  const sortDir = useSettingsStore((s) => s.filesDefaultSortDir);
  const defaultViewMode = useSettingsStore((s) => s.filesDefaultViewMode);
  const setSetting = useSettingsStore((s) => s.updateSetting);

  // Local override so the user can flip view from the toolbar without
  // changing their persisted default. Falls back to the setting.
  const [viewOverride, setViewOverride] = useState<FilesViewMode | null>(null);
  const viewMode: FilesViewMode = viewOverride ?? defaultViewMode;

  const current = stack[stack.length - 1];

  const loadFiles = useCallback(
    async (parentId: string | null, mode: 'initial' | 'refresh' = 'initial') => {
      if (mode === 'refresh') setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const nodes = await getFileNodes(parentId);
        setFiles(nodes);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to load files');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [],
  );

  useEffect(() => {
    void loadFiles(current.id);
  }, [loadFiles, current.id]);

  const visibleFiles = useMemo(() => {
    let out = files;
    if (!showHiddenFiles) out = out.filter((f) => !isHidden(f));
    // Directories always sort to the top regardless of sort key, then secondary
    // sort by the requested column. This matches macOS Finder / web file pickers.
    const dir = sortDir === 'desc' ? -1 : 1;
    return [...out].sort((a, b) => {
      const aDir = a.type === 'directory' ? 0 : 1;
      const bDir = b.type === 'directory' ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      switch (sortKey) {
        case 'size':
          return ((a.size ?? 0) - (b.size ?? 0)) * dir;
        case 'modified': {
          const am = a.updated ? new Date(a.updated).getTime() : 0;
          const bm = b.updated ? new Date(b.updated).getTime() : 0;
          return (am - bm) * dir;
        }
        case 'name':
        default:
          return a.name.localeCompare(b.name) * dir;
      }
    });
  }, [files, showHiddenFiles, sortKey, sortDir]);

  const openNode = useCallback((node: FileNode) => {
    if (node.type === 'directory') {
      setStack((s) => [...s, { id: node.id, name: node.name }]);
    }
    // Files are no-ops for now — opening a blob would need a download flow
    // wired to the JMAP download endpoint.
  }, []);

  const goBack = useCallback(() => {
    setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  }, []);

  const toggleView = useCallback(() => {
    const next: FilesViewMode = viewMode === 'list' ? 'grid' : 'list';
    setViewOverride(next);
    setSetting('filesDefaultViewMode', next);
  }, [viewMode, setSetting]);

  const onRefresh = useCallback(() => {
    void loadFiles(current.id, 'refresh');
  }, [loadFiles, current.id]);

  const renderHeader = () => {
    const canBack = stack.length > 1;
    const ToggleIcon = viewMode === 'list' ? LayoutGrid : ListIcon;
    return (
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View style={styles.headerLeft}>
            {canBack ? (
              <Pressable onPress={goBack} hitSlop={8} style={styles.headerBtn}>
                <ChevronLeft size={22} color={c.text} />
              </Pressable>
            ) : null}
            <Text style={styles.title} numberOfLines={1}>
              {current.name}
            </Text>
          </View>
          <Pressable
            onPress={toggleView}
            hitSlop={8}
            style={styles.headerBtn}
            accessibilityLabel={viewMode === 'list' ? 'Switch to grid view' : 'Switch to list view'}
          >
            <ToggleIcon size={20} color={c.text} />
          </Pressable>
        </View>
        {canBack ? (
          <Text style={styles.breadcrumb} numberOfLines={1}>
            {stack.map((f) => f.name).join(' / ')}
          </Text>
        ) : null}
      </View>
    );
  };

  const renderRow = (item: FileNode) => {
    const Icon = item.type === 'directory' ? Folder : pickFileIcon(item.name);
    const tint = item.type === 'directory'
      ? (coloredIcons ? c.calendar.blue : c.textMuted)
      : (coloredIcons ? fileIconColor(item.name, c) : c.textMuted);
    const tappable = item.type === 'directory';
    return (
      <Pressable
        onPress={() => openNode(item)}
        disabled={!tappable}
        style={({ pressed }) => [
          styles.fileRow,
          pressed && tappable && { backgroundColor: c.surfaceHover },
        ]}
      >
        {showIcons && <Icon size={20} color={tint} />}
        <View style={styles.fileInfo}>
          <Text style={styles.fileName} numberOfLines={1}>
            {item.name}
          </Text>
          <View style={styles.fileMetaRow}>
            {item.size != null && item.type !== 'directory' ? (
              <Text style={styles.fileMeta}>{formatFileSize(item.size)}</Text>
            ) : null}
            {item.updated ? (
              <Text style={styles.fileMeta}>{formatModified(item.updated)}</Text>
            ) : null}
          </View>
        </View>
      </Pressable>
    );
  };

  const renderGridCell = (item: FileNode) => {
    const Icon = item.type === 'directory' ? Folder : pickFileIcon(item.name);
    const tint = item.type === 'directory'
      ? (coloredIcons ? c.calendar.blue : c.textMuted)
      : (coloredIcons ? fileIconColor(item.name, c) : c.textMuted);
    const tappable = item.type === 'directory';
    return (
      <Pressable
        onPress={() => openNode(item)}
        disabled={!tappable}
        style={({ pressed }) => [
          styles.gridItem,
          pressed && tappable && { backgroundColor: c.surfaceHover },
        ]}
      >
        {showIcons ? (
          <Icon size={36} color={tint} />
        ) : (
          <View style={{ width: 36, height: 36 }} />
        )}
        <Text style={styles.gridName} numberOfLines={2}>
          {item.name}
        </Text>
        {item.size != null && item.type !== 'directory' ? (
          <Text style={styles.gridMeta} numberOfLines={1}>
            {formatFileSize(item.size)}
          </Text>
        ) : null}
      </Pressable>
    );
  };

  let body: React.ReactNode;
  if (loading && !refreshing) {
    body = (
      <View style={styles.center}>
        <ActivityIndicator color={c.primary} />
      </View>
    );
  } else if (error) {
    body = (
      <View style={styles.center}>
        <Text style={styles.errorText}>{error}</Text>
        <TouchableOpacity
          style={styles.retryButton}
          onPress={() => void loadFiles(current.id)}
        >
          <Text style={styles.retryText}>Retry</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (visibleFiles.length === 0) {
    body = (
      <View style={styles.center}>
        <HardDrive size={48} color={c.textMuted} />
        <Text style={styles.emptyText}>
          {stack.length > 1 ? 'This folder is empty' : 'No files yet'}
        </Text>
      </View>
    );
  } else if (viewMode === 'grid') {
    body = (
      <FlatList
        data={visibleFiles}
        key="grid"
        numColumns={3}
        keyExtractor={(item) => item.id}
        columnWrapperStyle={styles.gridRow}
        contentContainerStyle={styles.gridContent}
        renderItem={({ item }) => renderGridCell(item)}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={c.primary}
          />
        }
      />
    );
  } else {
    body = (
      <FlatList
        data={visibleFiles}
        key="list"
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => renderRow(item)}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={c.primary}
          />
        }
      />
    );
  }

  return (
    <View style={styles.container}>
      {renderHeader()}
      {body}
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: c.background,
    },
    header: {
      paddingTop: 60,
      paddingHorizontal: spacing.md,
      paddingBottom: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: spacing.sm,
    },
    headerLeft: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    headerBtn: {
      padding: spacing.xs,
      borderRadius: radius.sm,
    },
    title: {
      fontSize: typography.h2.fontSize,
      fontWeight: '700' as const,
      color: c.text,
      flexShrink: 1,
    },
    breadcrumb: {
      marginTop: 2,
      fontSize: typography.caption.fontSize,
      color: c.textMuted,
    },
    center: {
      flex: 1,
      justifyContent: 'center',
      alignItems: 'center',
      gap: spacing.sm,
    },
    emptyText: {
      color: c.textMuted,
      fontSize: typography.body.fontSize,
      marginTop: spacing.sm,
    },
    errorText: {
      color: c.error,
      fontSize: typography.body.fontSize,
      textAlign: 'center',
      paddingHorizontal: spacing.lg,
    },
    retryButton: {
      marginTop: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      backgroundColor: c.primary,
      borderRadius: 8,
    },
    retryText: {
      color: c.primaryForeground,
      fontWeight: '600' as const,
    },
    fileRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
      gap: spacing.sm,
    },
    fileInfo: {
      flex: 1,
    },
    fileName: {
      fontSize: typography.body.fontSize,
      color: c.text,
    },
    fileMetaRow: {
      flexDirection: 'row',
      gap: spacing.sm,
      marginTop: 2,
    },
    fileMeta: {
      fontSize: typography.caption.fontSize,
      color: c.textMuted,
    },
    gridContent: {
      padding: spacing.sm,
    },
    gridRow: {
      gap: spacing.sm,
    },
    gridItem: {
      flex: 1,
      alignItems: 'center',
      gap: spacing.xs,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.xs,
      borderRadius: radius.md,
    },
    gridName: {
      fontSize: typography.caption.fontSize,
      color: c.text,
      textAlign: 'center',
    },
    gridMeta: {
      fontSize: typography.small.fontSize,
      color: c.textMuted,
      textAlign: 'center',
    },
  });
}
