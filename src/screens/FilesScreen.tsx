import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  TouchableWithoutFeedback,
  View,
} from 'react-native';
import {
  ChevronLeft, FileText, Folder, FolderPlus, HardDrive, FileImage, FileVideo,
  FileAudio, FileArchive, FileSpreadsheet, FileCode2, LayoutGrid, List as ListIcon,
  MoreVertical, Pencil, Share2, Trash2, Upload, X, Download,
} from 'lucide-react-native';

// expo-document-picker is loaded lazily on first upload. Its native module
// is registered at app launch via Expo autolinking; on builds that predate
// the dep being added, requiring it at import time crashes the whole bundle
// with "Cannot find native module 'ExpoDocumentPicker'". Deferring the
// require keeps every other Files tab feature working until the user
// rebuilds the native shell.
type DocumentPickerModule = typeof import('expo-document-picker');
let documentPickerModule: DocumentPickerModule | null = null;
function loadDocumentPicker(): DocumentPickerModule | null {
  if (documentPickerModule) return documentPickerModule;
  try {
    documentPickerModule = require('expo-document-picker') as DocumentPickerModule;
    return documentPickerModule;
  } catch {
    return null;
  }
}

import {
  createFolder, deleteWithDescendants, getAllFileNodes, isDirectChildOfPrefix,
  isDirectory, nodeDisplayName, pathToPrefix, PATH_SEP, renameFileNode,
  uploadFileNode,
} from '../api/files';
import { downloadAttachment, shareAttachment } from '../lib/email-export';
import type { FileNode } from '../api/types';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { useSettingsStore, type FilesViewMode } from '../stores/settings-store';
import Dialog from '../components/Dialog';

// A file row carries the resolved display name alongside the original
// server-side name (the path-encoded `node.name` field).
interface FileRow extends FileNode {
  displayName: string;
}

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

  const [path, setPath] = useState<string[]>([]);
  const [allNodes, setAllNodes] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const [confirmDelete, setConfirmDelete] = useState<{ rows: FileRow[] } | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renameTarget, setRenameTarget] = useState<FileRow | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [actionsTarget, setActionsTarget] = useState<FileRow | null>(null);

  const showIcons = useSettingsStore((s) => s.filesShowIcons);
  const coloredIcons = useSettingsStore((s) => s.filesColoredIcons);
  const showHiddenFiles = useSettingsStore((s) => s.filesShowHiddenFiles);
  const sortKey = useSettingsStore((s) => s.filesDefaultSortKey);
  const sortDir = useSettingsStore((s) => s.filesDefaultSortDir);
  const defaultViewMode = useSettingsStore((s) => s.filesDefaultViewMode);
  const setSetting = useSettingsStore((s) => s.updateSetting);

  const [viewOverride, setViewOverride] = useState<FilesViewMode | null>(null);
  const viewMode: FilesViewMode = viewOverride ?? defaultViewMode;

  const selectionMode = selection.size > 0;
  const prefix = useMemo(() => pathToPrefix(path), [path]);
  const headerName = path.length === 0 ? 'Files' : path[path.length - 1];

  const loadFiles = useCallback(
    async (mode: 'initial' | 'refresh' = 'initial') => {
      if (mode === 'refresh') setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        const nodes = await getAllFileNodes();
        setAllNodes(nodes);
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
    void loadFiles();
  }, [loadFiles]);

  // If we navigated into a folder that no longer exists (it was deleted, or
  // we never had it), walk back up until we land on one that does. The check
  // looks for a directory node whose serverName matches the encoded path.
  useEffect(() => {
    if (allNodes.length === 0) return;
    setPath((prev) => {
      let next = prev;
      while (next.length > 0) {
        const parentPrefix = pathToPrefix(next.slice(0, -1));
        const expectedName = parentPrefix + next[next.length - 1];
        const exists = allNodes.some((n) => n.name === expectedName && isDirectory(n));
        if (exists) break;
        next = next.slice(0, -1);
      }
      return next.length === prev.length ? prev : next;
    });
  }, [allNodes]);

  const visibleFiles = useMemo<FileRow[]>(() => {
    const rows = allNodes
      .filter((n) => isDirectChildOfPrefix(n, prefix))
      .map<FileRow>((n) => ({ ...n, displayName: nodeDisplayName(n, prefix) }))
      .filter((r) => showHiddenFiles || !r.displayName.startsWith('.'));
    const dir = sortDir === 'desc' ? -1 : 1;
    return rows.sort((a, b) => {
      const aDir = isDirectory(a) ? 0 : 1;
      const bDir = isDirectory(b) ? 0 : 1;
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
          return a.displayName.localeCompare(b.displayName) * dir;
      }
    });
  }, [allNodes, prefix, showHiddenFiles, sortKey, sortDir]);

  const clearSelection = useCallback(() => setSelection(new Set()), []);

  const toggleSelect = useCallback((id: string) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const previewFile = useCallback(async (row: FileRow) => {
    if (!row.blobId) return;
    setBusyId(row.id);
    try {
      await shareAttachment(row.blobId, row.displayName, row.type);
    } catch (e) {
      Alert.alert('Preview failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, []);

  const downloadFile = useCallback(async (row: FileRow) => {
    if (!row.blobId) return;
    setBusyId(row.id);
    try {
      await downloadAttachment(row.blobId, row.displayName, row.type);
    } catch (e) {
      Alert.alert('Download failed', e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, []);

  const handleRowPress = useCallback(
    (row: FileRow) => {
      if (selectionMode) {
        toggleSelect(row.id);
        return;
      }
      if (isDirectory(row)) {
        setPath((p) => [...p, row.displayName]);
        return;
      }
      void previewFile(row);
    },
    [selectionMode, toggleSelect, previewFile],
  );

  const handleRowLongPress = useCallback((row: FileRow) => {
    toggleSelect(row.id);
  }, [toggleSelect]);

  const goBack = useCallback(() => {
    setPath((p) => (p.length > 0 ? p.slice(0, -1) : p));
    clearSelection();
  }, [clearSelection]);

  const toggleView = useCallback(() => {
    const next: FilesViewMode = viewMode === 'list' ? 'grid' : 'list';
    setViewOverride(next);
    setSetting('filesDefaultViewMode', next);
  }, [viewMode, setSetting]);

  const onRefresh = useCallback(() => {
    void loadFiles('refresh');
  }, [loadFiles]);

  const submitNewFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name) return;
    if (name.includes(PATH_SEP) || name.includes('/')) {
      Alert.alert('Invalid name', 'Folder names cannot contain "/".');
      return;
    }
    setNewFolderOpen(false);
    setNewFolderName('');
    try {
      await createFolder(name, path);
      await loadFiles('refresh');
    } catch (e) {
      Alert.alert('Create folder failed', e instanceof Error ? e.message : String(e));
    }
  }, [newFolderName, path, loadFiles]);

  const submitRename = useCallback(async () => {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name || name === renameTarget.displayName) {
      setRenameTarget(null);
      return;
    }
    if (name.includes(PATH_SEP) || name.includes('/')) {
      Alert.alert('Invalid name', 'Names cannot contain "/".');
      return;
    }
    const target = renameTarget;
    setRenameTarget(null);
    setRenameValue('');
    try {
      await renameFileNode(target, name, path, allNodes);
      await loadFiles('refresh');
    } catch (e) {
      Alert.alert('Rename failed', e instanceof Error ? e.message : String(e));
    }
  }, [renameTarget, renameValue, path, allNodes, loadFiles]);

  const startUpload = useCallback(async () => {
    if (uploading) return;
    const picker = loadDocumentPicker();
    if (!picker) {
      Alert.alert(
        'Upload unavailable',
        'The file picker is not installed in this build. Rebuild the app (expo run:android) to enable uploads.',
      );
      return;
    }
    let result;
    try {
      result = await picker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
      });
    } catch (e) {
      Alert.alert('Pick failed', e instanceof Error ? e.message : String(e));
      return;
    }
    if (result.canceled || result.assets.length === 0) return;
    const asset = result.assets[0];
    setUploading(true);
    try {
      await uploadFileNode(
        asset.uri,
        asset.name,
        asset.mimeType || 'application/octet-stream',
        path,
      );
      await loadFiles('refresh');
    } catch (e) {
      Alert.alert('Upload failed', e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  }, [uploading, path, loadFiles]);

  const requestDelete = useCallback((rows: FileRow[]) => {
    if (rows.length === 0) return;
    setConfirmDelete({ rows });
  }, []);

  const performDelete = useCallback(async () => {
    if (!confirmDelete) return;
    const targets = confirmDelete.rows;
    setConfirmDelete(null);
    clearSelection();
    try {
      await deleteWithDescendants(targets, allNodes);
      await loadFiles('refresh');
    } catch (e) {
      Alert.alert('Delete failed', e instanceof Error ? e.message : String(e));
    }
  }, [confirmDelete, allNodes, clearSelection, loadFiles]);

  const renderHeader = () => {
    const canBack = path.length > 0;
    const ToggleIcon = viewMode === 'list' ? LayoutGrid : ListIcon;
    if (selectionMode) {
      const selectedRows = visibleFiles.filter((r) => selection.has(r.id));
      return (
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <Pressable onPress={clearSelection} hitSlop={8} style={styles.headerBtn}>
              <X size={22} color={c.text} />
            </Pressable>
            <Text style={styles.title}>{selection.size} selected</Text>
            <View style={styles.headerActions}>
              <Pressable
                onPress={() => requestDelete(selectedRows)}
                hitSlop={8}
                style={styles.headerBtn}
                accessibilityLabel="Delete selected"
              >
                <Trash2 size={20} color={c.error} />
              </Pressable>
            </View>
          </View>
        </View>
      );
    }
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
              {headerName}
            </Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable
              onPress={() => setNewFolderOpen(true)}
              hitSlop={8}
              style={styles.headerBtn}
              accessibilityLabel="New folder"
            >
              <FolderPlus size={20} color={c.text} />
            </Pressable>
            <Pressable
              onPress={() => void startUpload()}
              hitSlop={8}
              style={styles.headerBtn}
              accessibilityLabel="Upload file"
              disabled={uploading}
            >
              {uploading ? (
                <ActivityIndicator size="small" color={c.text} />
              ) : (
                <Upload size={20} color={c.text} />
              )}
            </Pressable>
            <Pressable
              onPress={toggleView}
              hitSlop={8}
              style={styles.headerBtn}
              accessibilityLabel={viewMode === 'list' ? 'Switch to grid view' : 'Switch to list view'}
            >
              <ToggleIcon size={20} color={c.text} />
            </Pressable>
          </View>
        </View>
        {canBack ? (
          <Text style={styles.breadcrumb} numberOfLines={1}>
            {['Files', ...path].join(' / ')}
          </Text>
        ) : null}
      </View>
    );
  };

  const renderRow = (item: FileRow) => {
    const isDir = isDirectory(item);
    const Icon = isDir ? Folder : pickFileIcon(item.displayName);
    const tint = isDir
      ? (coloredIcons ? c.calendar.blue : c.textMuted)
      : (coloredIcons ? fileIconColor(item.displayName, c) : c.textMuted);
    const selected = selection.has(item.id);
    const busy = busyId === item.id;
    return (
      <Pressable
        onPress={() => handleRowPress(item)}
        onLongPress={() => handleRowLongPress(item)}
        delayLongPress={300}
        style={({ pressed }) => [
          styles.fileRow,
          selected && { backgroundColor: c.primaryBg },
          pressed && !selected && { backgroundColor: c.surfaceHover },
        ]}
      >
        {showIcons && <Icon size={20} color={tint} />}
        <View style={styles.fileInfo}>
          <Text style={styles.fileName} numberOfLines={1}>
            {item.displayName}
          </Text>
          <View style={styles.fileMetaRow}>
            {item.size != null && !isDir ? (
              <Text style={styles.fileMeta}>{formatFileSize(item.size)}</Text>
            ) : null}
            {item.updated ? (
              <Text style={styles.fileMeta}>{formatModified(item.updated)}</Text>
            ) : null}
          </View>
        </View>
        {busy ? (
          <ActivityIndicator size="small" color={c.textMuted} />
        ) : !selectionMode ? (
          <Pressable
            onPress={(e) => {
              e.stopPropagation();
              setActionsTarget(item);
            }}
            hitSlop={8}
            style={styles.rowMore}
          >
            <MoreVertical size={18} color={c.textMuted} />
          </Pressable>
        ) : null}
      </Pressable>
    );
  };

  const renderGridCell = (item: FileRow) => {
    const isDir = isDirectory(item);
    const Icon = isDir ? Folder : pickFileIcon(item.displayName);
    const tint = isDir
      ? (coloredIcons ? c.calendar.blue : c.textMuted)
      : (coloredIcons ? fileIconColor(item.displayName, c) : c.textMuted);
    const selected = selection.has(item.id);
    return (
      <Pressable
        onPress={() => handleRowPress(item)}
        onLongPress={() => handleRowLongPress(item)}
        delayLongPress={300}
        style={({ pressed }) => [
          styles.gridItem,
          selected && { backgroundColor: c.primaryBg },
          pressed && !selected && { backgroundColor: c.surfaceHover },
        ]}
      >
        {showIcons ? (
          <Icon size={36} color={tint} />
        ) : (
          <View style={{ width: 36, height: 36 }} />
        )}
        <Text style={styles.gridName} numberOfLines={2}>
          {item.displayName}
        </Text>
        {item.size != null && !isDir ? (
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
          onPress={() => void loadFiles()}
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
          {path.length > 0 ? 'This folder is empty' : 'No files yet'}
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
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />
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
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.primary} />
        }
      />
    );
  }

  return (
    <View style={styles.container}>
      {renderHeader()}
      {body}

      <PromptModal
        visible={newFolderOpen}
        title="New folder"
        placeholder="Folder name"
        confirmText="Create"
        value={newFolderName}
        onChange={setNewFolderName}
        onCancel={() => {
          setNewFolderOpen(false);
          setNewFolderName('');
        }}
        onSubmit={submitNewFolder}
      />

      <PromptModal
        visible={renameTarget != null}
        title="Rename"
        placeholder="Name"
        confirmText="Rename"
        value={renameValue}
        onChange={setRenameValue}
        onCancel={() => {
          setRenameTarget(null);
          setRenameValue('');
        }}
        onSubmit={submitRename}
      />

      <ActionsSheet
        target={actionsTarget}
        onClose={() => setActionsTarget(null)}
        onPreview={(r) => {
          setActionsTarget(null);
          void previewFile(r);
        }}
        onDownload={(r) => {
          setActionsTarget(null);
          void downloadFile(r);
        }}
        onRename={(r) => {
          setActionsTarget(null);
          setRenameTarget(r);
          setRenameValue(r.displayName);
        }}
        onDelete={(r) => {
          setActionsTarget(null);
          requestDelete([r]);
        }}
      />

      <Dialog
        visible={confirmDelete != null}
        title={
          confirmDelete && confirmDelete.rows.length > 1
            ? `Delete ${confirmDelete.rows.length} items?`
            : 'Delete this item?'
        }
        message="Folders are deleted along with everything inside them. This can't be undone."
        variant="destructive"
        confirmText="Delete"
        onConfirm={() => void performDelete()}
        onCancel={() => setConfirmDelete(null)}
      />
    </View>
  );
}

interface PromptModalProps {
  visible: boolean;
  title: string;
  placeholder: string;
  confirmText: string;
  value: string;
  onChange: (v: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

function PromptModal(props: PromptModalProps) {
  const c = useColors();
  const styles = React.useMemo(() => makePromptStyles(c), [c]);
  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="fade"
      onRequestClose={props.onCancel}
    >
      <TouchableWithoutFeedback onPress={props.onCancel}>
        <View style={styles.backdrop}>
          <TouchableWithoutFeedback>
            <View style={styles.dialog}>
              <Text style={styles.title}>{props.title}</Text>
              <TextInput
                value={props.value}
                onChangeText={props.onChange}
                placeholder={props.placeholder}
                placeholderTextColor={c.textMuted}
                style={styles.input}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={props.onSubmit}
              />
              <View style={styles.row}>
                <Pressable onPress={props.onCancel} style={styles.btnGhost}>
                  <Text style={styles.btnGhostText}>Cancel</Text>
                </Pressable>
                <Pressable
                  onPress={props.onSubmit}
                  style={[styles.btnPrimary, !props.value.trim() && { opacity: 0.5 }]}
                  disabled={!props.value.trim()}
                >
                  <Text style={styles.btnPrimaryText}>{props.confirmText}</Text>
                </Pressable>
              </View>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

interface ActionsSheetProps {
  target: FileRow | null;
  onClose: () => void;
  onPreview: (r: FileRow) => void;
  onDownload: (r: FileRow) => void;
  onRename: (r: FileRow) => void;
  onDelete: (r: FileRow) => void;
}

function ActionsSheet({ target, onClose, onPreview, onDownload, onRename, onDelete }: ActionsSheetProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeSheetStyles(c), [c]);
  if (!target) return null;
  const isDir = isDirectory(target);
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop}>
          <TouchableWithoutFeedback>
            <View style={styles.sheet}>
              <Text style={styles.sheetTitle} numberOfLines={1}>
                {target.displayName}
              </Text>
              {!isDir ? (
                <Pressable style={styles.action} onPress={() => onPreview(target)}>
                  <Share2 size={18} color={c.text} />
                  <Text style={styles.actionLabel}>Preview / Share</Text>
                </Pressable>
              ) : null}
              {!isDir ? (
                <Pressable style={styles.action} onPress={() => onDownload(target)}>
                  <Download size={18} color={c.text} />
                  <Text style={styles.actionLabel}>Save to device</Text>
                </Pressable>
              ) : null}
              <Pressable style={styles.action} onPress={() => onRename(target)}>
                <Pencil size={18} color={c.text} />
                <Text style={styles.actionLabel}>Rename</Text>
              </Pressable>
              <Pressable style={styles.action} onPress={() => onDelete(target)}>
                <Trash2 size={18} color={c.error} />
                <Text style={[styles.actionLabel, { color: c.error }]}>Delete</Text>
              </Pressable>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
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
    headerActions: {
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
    rowMore: {
      padding: spacing.xs,
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

function makePromptStyles(c: ThemePalette) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'center',
      alignItems: 'center',
      padding: spacing.lg,
    },
    dialog: {
      width: '100%',
      maxWidth: 400,
      backgroundColor: c.background,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.lg,
      padding: spacing.lg,
      gap: spacing.md,
    },
    title: {
      ...typography.h3,
      color: c.text,
    },
    input: {
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      color: c.text,
      fontSize: typography.body.fontSize,
      backgroundColor: c.surface,
    },
    row: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: spacing.sm,
    },
    btnGhost: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.md,
    },
    btnGhostText: {
      color: c.text,
      fontWeight: '600' as const,
    },
    btnPrimary: {
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.md,
      backgroundColor: c.primary,
    },
    btnPrimaryText: {
      color: c.primaryForeground,
      fontWeight: '600' as const,
    },
  });
}

function makeSheetStyles(c: ThemePalette) {
  return StyleSheet.create({
    backdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.5)',
      justifyContent: 'flex-end',
    },
    sheet: {
      backgroundColor: c.background,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      paddingTop: spacing.md,
      paddingBottom: spacing.xxl,
      paddingHorizontal: spacing.md,
      gap: spacing.xs,
    },
    sheetTitle: {
      ...typography.bodyMedium,
      color: c.textMuted,
      paddingHorizontal: spacing.sm,
      paddingBottom: spacing.sm,
    },
    action: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.md,
      borderRadius: radius.md,
    },
    actionLabel: {
      ...typography.body,
      color: c.text,
    },
  });
}
