import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Image,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
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
  MoreVertical, Pencil, Share2, Trash2, Upload, Users, X, Download, Search,
  ArrowUpDown, ArrowUp, ArrowDown, FolderInput, Copy, Check, Eye, ExternalLink,
} from 'lucide-react-native';
import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import JSZip from 'jszip';

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
  copyFileNode, createFolder, deleteFileNodes, getAllFileNodesAcrossAccounts,
  getFileNodeDownloadUrl, getMaxSizeUpload, isCrossAccountId, isFolder, moveFileNode,
  renameFileNode, supportsSharing, uploadFileNode,
} from '../api/files';
import { jmapClient } from '../api/jmap-client';
import { downloadAttachment, shareAttachment } from '../lib/email-export';
import { secureFetch } from '../lib/client-cert';
import { getUniqueName } from '../lib/filenode-name';
import { useBackWhileFocused } from '../lib/use-back-while-focused';
import { filesBackStep } from '../lib/files-back';
import type { FileNode } from '../api/types';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import {
  useSettingsStore, type FilesViewMode, type FilesSortKey, type FilesSortDir,
} from '../stores/settings-store';
import { useAuthStore } from '../stores/auth-store';
import { useLocaleStore, type TranslateFn } from '../stores/locale-store';
import Dialog from '../components/Dialog';
import ShareSheet from '../components/files/ShareSheet';
import { FilePreviewModal, canPreviewInApp } from '../components/files/FilePreviewModal';

// A file row carries the display name alongside the rest of the node.
interface FileRow extends FileNode {
  displayName: string;
}

type Translate = TranslateFn;

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'];

function fileExt(name: string): string {
  return name.split('.').pop()?.toLowerCase() ?? '';
}

function isImageName(name: string): boolean {
  return IMAGE_EXTS.includes(fileExt(name));
}

function pickFileIcon(name: string) {
  const ext = fileExt(name);
  if ([...IMAGE_EXTS, 'svg'].includes(ext)) return FileImage;
  if (['mp4', 'mov', 'webm', 'avi', 'mkv'].includes(ext)) return FileVideo;
  if (['mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus'].includes(ext)) return FileAudio;
  if (['zip', 'rar', 'tar', 'gz', '7z', 'bz2'].includes(ext)) return FileArchive;
  if (['xlsx', 'xls', 'csv', 'numbers'].includes(ext)) return FileSpreadsheet;
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'json', 'xml', 'yaml', 'yml', 'sh'].includes(ext)) return FileCode2;
  return FileText;
}

function fileIconColor(name: string, c: ThemePalette): string {
  const ext = fileExt(name);
  if ([...IMAGE_EXTS, 'svg'].includes(ext)) return c.calendar.green;
  if (['mp4', 'mov', 'webm', 'avi', 'mkv'].includes(ext)) return c.calendar.purple;
  if (['mp3', 'wav', 'flac', 'm4a', 'ogg', 'opus'].includes(ext)) return c.calendar.pink;
  if (['zip', 'rar', 'tar', 'gz', '7z', 'bz2'].includes(ext)) return c.calendar.orange;
  if (['xlsx', 'xls', 'csv', 'numbers'].includes(ext)) return c.calendar.teal;
  if (['pdf'].includes(ext)) return c.error;
  if (['ts', 'tsx', 'js', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'json', 'xml', 'yaml', 'yml', 'sh'].includes(ext)) return c.calendar.indigo;
  return c.textMuted;
}

export function formatFileSize(bytes?: number): string {
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

// Last-modified with the creation time as fallback (webmail file-store
// `lastModified: node.modified || node.created`).
function modifiedOf(node: FileNode): string | undefined {
  return node.modified || node.created;
}

// Authenticated thumbnail URL/headers for image nodes. The download endpoint
// needs the bearer/basic header; RN's Image passes `headers` through.
function thumbnailSource(node: FileNode): { uri: string; headers: Record<string, string> } | null {
  if (!node.blobId || !isImageName(node.name)) return null;
  try {
    return {
      uri: getFileNodeDownloadUrl(node),
      headers: { Authorization: jmapClient.authHeader },
    };
  } catch {
    return null;
  }
}

interface UploadProgress {
  current: number;
  total: number;
  name: string;
  percent: number; // 0..1
}

export default function FilesScreen() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);

  // Folder navigation stack. Hierarchy is real parentId nesting (#379) — each
  // entry is the folder's node id (namespaced "accountId:nodeId" inside a
  // shared-with-me subtree) plus its name for the breadcrumb.
  const [path, setPath] = useState<{ id: string; name: string }[]>([]);
  const [allNodes, setAllNodes] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [busyId, setBusyId] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);
  const [batchBusy, setBatchBusy] = useState<string | null>(null);

  const [confirmDelete, setConfirmDelete] = useState<{ rows: FileRow[] } | null>(null);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [renameTarget, setRenameTarget] = useState<FileRow | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [actionsTarget, setActionsTarget] = useState<FileRow | null>(null);
  const [shareTarget, setShareTarget] = useState<FileRow | null>(null);
  const [moveTarget, setMoveTarget] = useState<FileRow | null>(null);
  const [previewTarget, setPreviewTarget] = useState<FileRow | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortSheetOpen, setSortSheetOpen] = useState(false);

  const showIcons = useSettingsStore((s) => s.filesShowIcons);
  const coloredIcons = useSettingsStore((s) => s.filesColoredIcons);
  const showThumbnails = useSettingsStore((s) => s.filesShowThumbnails);
  const showHiddenFiles = useSettingsStore((s) => s.filesShowHiddenFiles);
  const sortKey = useSettingsStore((s) => s.filesDefaultSortKey);
  const sortDir = useSettingsStore((s) => s.filesDefaultSortDir);
  const defaultViewMode = useSettingsStore((s) => s.filesDefaultViewMode);
  const setSetting = useSettingsStore((s) => s.updateSetting);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);

  const [viewOverride, setViewOverride] = useState<FilesViewMode | null>(null);
  const viewMode: FilesViewMode = viewOverride ?? defaultViewMode;

  const uploading = uploadProgress != null;
  const selectionMode = selection.size > 0;
  const currentParentId = path.length === 0 ? null : path[path.length - 1].id;
  // True while browsing inside a folder another principal shared with us.
  // Creates/uploads would have to route to the owner's account, which this
  // screen doesn't do (matches the webmail's Files app); writes are hidden.
  const inSharedSubtree = isCrossAccountId(currentParentId);
  const rootLabel = t('files.title', 'Files');
  const headerName = path.length === 0 ? rootLabel : path[path.length - 1].name;
  const sharingEnabled = supportsSharing();

  const loadFiles = useCallback(
    async (mode: 'initial' | 'refresh' = 'initial') => {
      if (mode === 'refresh') setRefreshing(true);
      else setLoading(true);
      setError(null);
      try {
        // One fetch across all accessible accounts: own files plus nodes other
        // principals shared with us (tagged isShared, ids namespaced).
        const nodes = await getAllFileNodesAcrossAccounts();
        setAllNodes(nodes);
      } catch (e) {
        setError(e instanceof Error ? e.message : t('files.download_error', 'Failed to load files'));
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [t],
  );

  // Load on mount and reset the whole drive whenever the active account
  // changes: the node cache, folder stack and selection all belong to the
  // previous account (webmail 1.9.0 "reset the account-scoped Files drive").
  const loadedForAccountRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (loadedForAccountRef.current !== undefined && loadedForAccountRef.current !== activeAccountId) {
      uploadAbortRef.current?.abort();
      setAllNodes([]);
      setPath([]);
      setSelection(new Set());
      setActionsTarget(null);
      setShareTarget(null);
      setMoveTarget(null);
      setPreviewTarget(null);
      setSearchQuery('');
    }
    loadedForAccountRef.current = activeAccountId;
    void loadFiles();
  }, [activeAccountId, loadFiles]);

  // If we navigated into a folder that no longer exists (deleted, or its
  // share was revoked), cut the stack back to the deepest ancestor that does.
  useEffect(() => {
    if (allNodes.length === 0) return;
    setPath((prev) => {
      const byId = new Map(allNodes.map((n) => [n.id, n]));
      let cut = prev.length;
      for (let i = 0; i < prev.length; i++) {
        const node = byId.get(prev[i].id);
        if (!node || !isFolder(node)) {
          cut = i;
          break;
        }
      }
      return cut === prev.length ? prev : prev.slice(0, cut);
    });
  }, [allNodes]);

  const folderNodes = useMemo(() => {
    if (currentParentId === null) {
      // Root: our own top-level nodes, plus the roots of every shared-with-me
      // subtree (a shared node whose parent isn't visible to us).
      const idSet = new Set(allNodes.map((n) => n.id));
      return allNodes.filter((n) =>
        n.isShared
          ? n.parentId == null || !idSet.has(n.parentId)
          : (n.parentId ?? null) === null,
      );
    }
    return allNodes.filter((n) => (n.parentId ?? null) === currentParentId);
  }, [allNodes, currentParentId]);

  const visibleFiles = useMemo<FileRow[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    const rows = folderNodes
      .map<FileRow>((n) => ({ ...n, displayName: n.name }))
      .filter((r) => showHiddenFiles || !r.displayName.startsWith('.'))
      .filter((r) => !q || r.displayName.toLowerCase().includes(q));
    const dir = sortDir === 'desc' ? -1 : 1;
    return rows.sort((a, b) => {
      // Own content first, shared-with-me entries after (root only).
      const aShared = a.isShared ? 1 : 0;
      const bShared = b.isShared ? 1 : 0;
      if (aShared !== bShared) return aShared - bShared;
      const aDir = isFolder(a) ? 0 : 1;
      const bDir = isFolder(b) ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      switch (sortKey) {
        case 'size':
          return ((a.size ?? 0) - (b.size ?? 0)) * dir;
        case 'modified': {
          const am = modifiedOf(a) ? new Date(modifiedOf(a)!).getTime() : 0;
          const bm = modifiedOf(b) ? new Date(modifiedOf(b)!).getTime() : 0;
          return (am - bm) * dir;
        }
        case 'name':
        default:
          return a.displayName.localeCompare(b.displayName) * dir;
      }
    });
  }, [folderNodes, searchQuery, showHiddenFiles, sortKey, sortDir]);

  const clearSelection = useCallback(() => setSelection(new Set()), []);

  // Shared-with-me rows stay out of multi-select: batch delete routes to our
  // own account and would fail (or worse, mismatch) on namespaced ids.
  const toggleSelect = useCallback((row: FileRow) => {
    if (row.isShared) return;
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(row.id)) next.delete(row.id);
      else next.add(row.id);
      return next;
    });
  }, []);

  // Hand the file to another app: the viewer for its type on Android, the
  // share sheet otherwise.
  const openFileWith = useCallback(async (row: FileRow) => {
    if (!row.blobId) return;
    setBusyId(row.id);
    try {
      await shareAttachment(row.blobId, row.displayName, row.type, undefined, row.accountId);
    } catch (e) {
      Alert.alert(t('files.preview_error', 'Failed to load preview'), e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, [t]);

  // Tap on a file: the in-app preview for the types it shows (images, text
  // and code, .eml, PDFs on iOS), the other app for the rest.
  const openFile = useCallback((row: FileRow) => {
    if (canPreviewInApp(row)) setPreviewTarget(row);
    else void openFileWith(row);
  }, [openFileWith]);

  const downloadFile = useCallback(async (row: FileRow) => {
    if (!row.blobId) return;
    setBusyId(row.id);
    try {
      await downloadAttachment(row.blobId, row.displayName, row.type, undefined, row.accountId);
    } catch (e) {
      Alert.alert(t('files.download_error', 'Failed to download'), e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, [t]);

  // Batch download: one selected file goes straight to the share sheet; more
  // than one (or any folder) is bundled into a zip that mirrors the folder
  // structure, then handed to the share sheet (webmail "Download (N)").
  const downloadSelection = useCallback(async (rows: FileRow[]) => {
    if (rows.length === 0) return;
    if (rows.length === 1 && !isFolder(rows[0])) {
      clearSelection();
      await downloadFile(rows[0]);
      return;
    }
    // Collect every file below the selection with its relative path.
    const children = new Map<string, FileNode[]>();
    for (const n of allNodes) {
      const key = n.parentId ?? '';
      if (!children.has(key)) children.set(key, []);
      children.get(key)!.push(n);
    }
    const entries: { node: FileNode; path: string }[] = [];
    const walk = (node: FileNode, prefix: string) => {
      if (isFolder(node)) {
        for (const child of children.get(node.id) ?? []) walk(child, `${prefix}${node.name}/`);
      } else {
        entries.push({ node, path: `${prefix}${node.name}` });
      }
    };
    for (const row of rows) walk(row, '');
    if (entries.length === 0) {
      Alert.alert(t('files.download_error', 'Failed to download'), t('files.empty_state_title', 'No files yet'));
      return;
    }
    clearSelection();
    setBatchBusy(`0/${entries.length}`);
    try {
      const zip = new JSZip();
      const header = { Authorization: jmapClient.authHeader };
      for (let i = 0; i < entries.length; i++) {
        const { node, path: rel } = entries[i];
        setBatchBusy(`${i + 1}/${entries.length}`);
        const res = await secureFetch(getFileNodeDownloadUrl(node), { headers: header });
        if (!res.ok) throw new Error(`${node.name}: ${res.status}`);
        zip.file(rel, await res.arrayBuffer());
      }
      const bytes = await zip.generateAsync({ type: 'uint8array' });
      const baseName = rows.length === 1 ? rows[0].name : (path[path.length - 1]?.name ?? rootLabel);
      const dest = new File(Paths.cache, `${baseName.replace(/[\\/:*?"<>|]/g, '_')}.zip`);
      if (dest.exists) dest.delete();
      dest.create();
      dest.write(bytes);
      if (!(await Sharing.isAvailableAsync())) {
        throw new Error(t('files.share_unavailable', 'Sharing is not available on this device'));
      }
      await Sharing.shareAsync(dest.uri, { mimeType: 'application/zip', dialogTitle: dest.name });
    } catch (e) {
      Alert.alert(t('files.download_error', 'Failed to download'), e instanceof Error ? e.message : String(e));
    } finally {
      setBatchBusy(null);
    }
  }, [allNodes, clearSelection, downloadFile, path, rootLabel, t]);

  const handleRowPress = useCallback(
    (row: FileRow) => {
      if (selectionMode) {
        toggleSelect(row);
        return;
      }
      if (isFolder(row)) {
        setPath((p) => [...p, { id: row.id, name: row.displayName }]);
        setSearchQuery('');
        return;
      }
      openFile(row);
    },
    [selectionMode, toggleSelect, openFile],
  );

  const handleRowLongPress = useCallback((row: FileRow) => {
    toggleSelect(row);
  }, [toggleSelect]);

  const goBack = useCallback(() => {
    setPath((p) => (p.length > 0 ? p.slice(0, -1) : p));
    setSearchQuery('');
    clearSelection();
  }, [clearSelection]);

  // Android back closes the preview, then leaves selection mode, then goes
  // up one folder; only at the root does it switch to the Mail tab.
  const backStep = filesBackStep({
    previewOpen: previewTarget != null,
    selecting: selectionMode,
    folderDepth: path.length,
  });
  const handleBack = useCallback(() => {
    if (backStep === 'close-preview') setPreviewTarget(null);
    else if (backStep === 'clear-selection') clearSelection();
    else if (backStep === 'folder-up') goBack();
  }, [backStep, clearSelection, goBack]);
  useBackWhileFocused(backStep !== 'leave', handleBack);

  const toggleView = useCallback(() => {
    const next: FilesViewMode = viewMode === 'list' ? 'grid' : 'list';
    setViewOverride(next);
    setSetting('filesDefaultViewMode', next);
  }, [viewMode, setSetting]);

  const onRefresh = useCallback(() => {
    void loadFiles('refresh');
  }, [loadFiles]);

  const invalidNameAlert = useCallback(() => {
    Alert.alert(t('files.invalid_name', 'Invalid name'), t('files.invalid_name_slash', 'Names cannot contain "/".'));
  }, [t]);

  const submitNewFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name) return;
    if (name.includes('/')) {
      invalidNameAlert();
      return;
    }
    setNewFolderOpen(false);
    setNewFolderName('');
    try {
      await createFolder(name, currentParentId);
      await loadFiles('refresh');
    } catch (e) {
      Alert.alert(t('files.create_folder_error', 'Failed to create folder'), e instanceof Error ? e.message : String(e));
    }
  }, [newFolderName, currentParentId, loadFiles, invalidNameAlert, t]);

  const submitRename = useCallback(async () => {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name || name === renameTarget.displayName) {
      setRenameTarget(null);
      return;
    }
    if (name.includes('/')) {
      invalidNameAlert();
      return;
    }
    const target = renameTarget;
    setRenameTarget(null);
    setRenameValue('');
    try {
      await renameFileNode(target.id, name);
      await loadFiles('refresh');
    } catch (e) {
      Alert.alert(t('files.rename_error', 'Failed to rename'), e instanceof Error ? e.message : String(e));
    }
  }, [renameTarget, renameValue, loadFiles, invalidNameAlert, t]);

  const duplicateFile = useCallback(async (row: FileRow) => {
    if (isFolder(row) || row.isShared) return;
    setBusyId(row.id);
    try {
      const siblings = new Set(
        allNodes.filter((n) => (n.parentId ?? null) === (row.parentId ?? null)).map((n) => n.name),
      );
      await copyFileNode(row, row.parentId ?? null, getUniqueName(row.name, siblings));
      await loadFiles('refresh');
    } catch (e) {
      Alert.alert(t('files.duplicate_error', 'Failed to duplicate'), e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, [allNodes, loadFiles, t]);

  const performMove = useCallback(async (row: FileRow, destinationId: string | null) => {
    setMoveTarget(null);
    if ((row.parentId ?? null) === destinationId) return;
    setBusyId(row.id);
    try {
      await moveFileNode(row.id, destinationId);
      await loadFiles('refresh');
    } catch (e) {
      Alert.alert(t('files.move_error', 'Failed to move'), e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  }, [loadFiles, t]);

  const cancelUpload = useCallback(() => {
    uploadAbortRef.current?.abort();
  }, []);

  const startUpload = useCallback(async () => {
    if (uploading) return;
    const picker = loadDocumentPicker();
    if (!picker) {
      Alert.alert(
        t('files.upload_error', 'Failed to upload file'),
        t('files.upload_unavailable', 'The file picker is not installed in this build. Rebuild the app to enable uploads.'),
      );
      return;
    }
    let result;
    try {
      result = await picker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: true,
      });
    } catch (e) {
      Alert.alert(t('files.upload_error', 'Failed to upload file'), e instanceof Error ? e.message : String(e));
      return;
    }
    if (result.canceled || result.assets.length === 0) return;

    // Skip anything over the server's advertised ceiling up front instead of
    // letting the upload endpoint answer with an opaque 4xx.
    const maxSize = getMaxSizeUpload();
    const accepted: typeof result.assets = [];
    for (const asset of result.assets) {
      let size = asset.size;
      if (size == null) {
        try { size = new File(asset.uri).size ?? undefined; } catch { /* unknown size */ }
      }
      if (maxSize > 0 && size != null && size > maxSize) {
        Alert.alert(
          t('files.upload_error', 'Failed to upload file'),
          t('files.file_too_large', '"{name}" exceeds the maximum file size ({max})', {
            name: asset.name,
            max: formatFileSize(maxSize),
          }),
        );
        continue;
      }
      accepted.push(asset);
    }
    if (accepted.length === 0) return;

    const controller = new AbortController();
    uploadAbortRef.current = controller;
    const parentId = currentParentId;
    // Duplicate names get " (1)", " (2)", ... so two nodes never share a name.
    const existing = new Set(
      allNodes.filter((n) => (n.parentId ?? null) === parentId).map((n) => n.name),
    );
    let failed: string | null = null;
    try {
      for (let i = 0; i < accepted.length; i++) {
        if (controller.signal.aborted) break;
        const asset = accepted[i];
        const name = getUniqueName(asset.name, existing);
        existing.add(name);
        setUploadProgress({ current: i + 1, total: accepted.length, name, percent: 0 });
        try {
          await uploadFileNode(
            asset.uri,
            name,
            asset.mimeType || 'application/octet-stream',
            parentId,
            {
              signal: controller.signal,
              onProgress: (sent, total) =>
                setUploadProgress((p) => (p ? { ...p, percent: total > 0 ? sent / total : 0 } : p)),
            },
          );
        } catch (e) {
          if (controller.signal.aborted || (e instanceof Error && e.name === 'AbortError')) break;
          failed = `${asset.name}: ${e instanceof Error ? e.message : String(e)}`;
          break;
        }
      }
    } finally {
      uploadAbortRef.current = null;
      setUploadProgress(null);
    }
    await loadFiles('refresh');
    if (failed) Alert.alert(t('files.upload_error', 'Failed to upload file'), failed);
  }, [uploading, currentParentId, allNodes, loadFiles, t]);

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
      // The server removes folder descendants (onDestroyRemoveChildren).
      await deleteFileNodes(targets.map((t) => t.id));
      await loadFiles('refresh');
    } catch (e) {
      Alert.alert(t('files.delete_error', 'Failed to delete'), e instanceof Error ? e.message : String(e));
    }
  }, [confirmDelete, clearSelection, loadFiles, t]);

  const sortLabel = t(`files.${sortKey}`, sortKey);
  const SortDirIcon = sortDir === 'desc' ? ArrowDown : ArrowUp;

  const renderHeader = () => {
    const canBack = path.length > 0;
    const ToggleIcon = viewMode === 'list' ? LayoutGrid : ListIcon;
    if (selectionMode) {
      const selectedRows = visibleFiles.filter((r) => selection.has(r.id));
      return (
        <View style={styles.header}>
          <View style={styles.headerRow}>
            <Pressable
              onPress={clearSelection}
              hitSlop={8}
              style={styles.headerBtn}
              accessibilityRole="button"
              accessibilityLabel={t('email_list.batch_actions.clear_selection', 'Clear selection')}
            >
              <X size={22} color={c.text} />
            </Pressable>
            <Text style={styles.title}>
              {t('files.selected_count', '{count, plural, one {# selected} other {# selected}}', { count: selection.size })}
            </Text>
            <View style={styles.headerActions}>
              <Pressable
                onPress={() => void downloadSelection(selectedRows)}
                hitSlop={8}
                style={styles.headerBtn}
                accessibilityLabel={t('files.download', 'Download')}
                disabled={batchBusy != null}
              >
                {batchBusy != null ? (
                  <ActivityIndicator size="small" color={c.text} />
                ) : (
                  <Download size={20} color={c.text} />
                )}
              </Pressable>
              <Pressable
                onPress={() => requestDelete(selectedRows)}
                hitSlop={8}
                style={styles.headerBtn}
                accessibilityLabel={t('files.delete', 'Delete')}
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
              <Pressable
                onPress={goBack}
                hitSlop={8}
                style={styles.headerBtn}
                accessibilityRole="button"
                accessibilityLabel={t('common.back', 'Back')}
              >
                <ChevronLeft size={22} color={c.text} />
              </Pressable>
            ) : null}
            <Text style={styles.title} numberOfLines={1}>
              {headerName}
            </Text>
          </View>
          <View style={styles.headerActions}>
            <Pressable
              onPress={() => {
                setSearchOpen((v) => !v);
                if (searchOpen) setSearchQuery('');
              }}
              hitSlop={8}
              style={[styles.headerBtn, searchOpen && styles.headerBtnActive]}
              accessibilityLabel={t('files.search_placeholder', 'Search files...')}
            >
              <Search size={20} color={c.text} />
            </Pressable>
            {!inSharedSubtree ? (
              <Pressable
                onPress={() => setNewFolderOpen(true)}
                hitSlop={8}
                style={styles.headerBtn}
                accessibilityLabel={t('files.new_folder', 'New Folder')}
              >
                <FolderPlus size={20} color={c.text} />
              </Pressable>
            ) : null}
            {!inSharedSubtree ? (
              <Pressable
                onPress={() => void startUpload()}
                hitSlop={8}
                style={styles.headerBtn}
                accessibilityLabel={t('files.upload', 'Upload')}
                disabled={uploading}
              >
                {uploading ? (
                  <ActivityIndicator size="small" color={c.text} />
                ) : (
                  <Upload size={20} color={c.text} />
                )}
              </Pressable>
            ) : null}
            <Pressable
              onPress={toggleView}
              hitSlop={8}
              style={styles.headerBtn}
              accessibilityLabel={viewMode === 'list' ? t('files.grid_view', 'Grid view') : t('files.list_view', 'List view')}
            >
              <ToggleIcon size={20} color={c.text} />
            </Pressable>
          </View>
        </View>
        {canBack ? (
          <Text style={styles.breadcrumb} numberOfLines={1}>
            {[rootLabel, ...path.map((p) => p.name)].join(' / ')}
          </Text>
        ) : null}
        <View style={styles.toolbarRow}>
          {searchOpen ? (
            <TextInput
              value={searchQuery}
              onChangeText={setSearchQuery}
              placeholder={t('files.search_placeholder', 'Search files...')}
              placeholderTextColor={c.textMuted}
              style={styles.searchInput}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
            />
          ) : <View style={{ flex: 1 }} />}
          <Pressable
            onPress={() => setSortSheetOpen(true)}
            hitSlop={6}
            style={styles.sortChip}
            accessibilityLabel={t('files.settings_default_sort', 'Default Sort')}
          >
            <ArrowUpDown size={13} color={c.textMuted} />
            <Text style={styles.sortChipText}>{sortLabel}</Text>
            <SortDirIcon size={12} color={c.textMuted} />
          </Pressable>
        </View>
        {uploadProgress ? (
          <View style={styles.progressRow}>
            <View style={{ flex: 1 }}>
              <Text style={styles.progressText} numberOfLines={1}>
                {t('files.uploading_progress', 'Uploading {current}/{total} · {name}', {
                  current: uploadProgress.current,
                  total: uploadProgress.total,
                  name: uploadProgress.name,
                })}
              </Text>
              <View style={styles.progressTrack}>
                <View style={[styles.progressBar, { width: `${Math.round(uploadProgress.percent * 100)}%` }]} />
              </View>
            </View>
            <Text style={styles.progressPercent}>{Math.round(uploadProgress.percent * 100)}%</Text>
            <Pressable onPress={cancelUpload} hitSlop={8} accessibilityLabel={t('files.cancel', 'Cancel')}>
              <X size={18} color={c.text} />
            </Pressable>
          </View>
        ) : null}
      </View>
    );
  };

  const renderIcon = (item: FileRow, size: number) => {
    const isDir = isFolder(item);
    const thumb = !isDir && showThumbnails ? thumbnailSource(item) : null;
    if (thumb) {
      return (
        <Image
          source={thumb}
          style={{ width: size, height: size, borderRadius: radius.sm, backgroundColor: c.muted }}
          resizeMode="cover"
          accessibilityIgnoresInvertColors
        />
      );
    }
    if (!showIcons) return <View style={{ width: size, height: size }} />;
    const Icon = isDir ? Folder : pickFileIcon(item.displayName);
    const tint = isDir
      ? (coloredIcons ? c.calendar.blue : c.textMuted)
      : (coloredIcons ? fileIconColor(item.displayName, c) : c.textMuted);
    return <Icon size={size} color={tint} />;
  };

  const renderRow = (item: FileRow) => {
    const isDir = isFolder(item);
    const selected = selection.has(item.id);
    const busy = busyId === item.id;
    const sharedOut = !!item.shareWith && Object.keys(item.shareWith).length > 0;
    const modified = modifiedOf(item);
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
        {renderIcon(item, showThumbnails && !isDir && isImageName(item.displayName) ? 36 : 20)}
        <View style={styles.fileInfo}>
          <View style={styles.fileNameRow}>
            <Text style={styles.fileName} numberOfLines={1}>
              {item.displayName}
            </Text>
            {item.isShared ? (
              <Share2 size={13} color={c.primary} />
            ) : sharedOut ? (
              <Users size={13} color={c.primary} />
            ) : null}
          </View>
          <View style={styles.fileMetaRow}>
            {item.isShared && item.accountName ? (
              <Text style={styles.fileMeta} numberOfLines={1}>
                {t('files.shared_by', 'Shared by {name}', { name: item.accountName })}
              </Text>
            ) : null}
            {item.size != null && !isDir ? (
              <Text style={styles.fileMeta}>{formatFileSize(item.size)}</Text>
            ) : null}
            {modified ? (
              <Text style={styles.fileMeta}>{formatModified(modified)}</Text>
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
            accessibilityRole="button"
            accessibilityLabel={t('files.context_menu', 'Actions')}
          >
            <MoreVertical size={18} color={c.textMuted} />
          </Pressable>
        ) : null}
      </Pressable>
    );
  };

  const renderGridCell = (item: FileRow) => {
    const isDir = isFolder(item);
    const selected = selection.has(item.id);
    const sharedOut = !!item.shareWith && Object.keys(item.shareWith).length > 0;
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
        {renderIcon(item, showThumbnails && !isDir && isImageName(item.displayName) ? 64 : 36)}
        <View style={styles.gridNameRow}>
          <Text style={styles.gridName} numberOfLines={2}>
            {item.displayName}
          </Text>
          {item.isShared ? (
            <Share2 size={12} color={c.primary} />
          ) : sharedOut ? (
            <Users size={12} color={c.primary} />
          ) : null}
        </View>
        {item.isShared && item.accountName ? (
          <Text style={styles.gridMeta} numberOfLines={1}>
            {t('files.shared_by', 'Shared by {name}', { name: item.accountName })}
          </Text>
        ) : item.size != null && !isDir ? (
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
          <Text style={styles.retryText}>{t('files.retry', 'Retry')}</Text>
        </TouchableOpacity>
      </View>
    );
  } else if (visibleFiles.length === 0) {
    body = (
      <View style={styles.center}>
        <HardDrive size={48} color={c.textMuted} />
        <Text style={styles.emptyText}>
          {searchQuery.trim()
            ? t('files.no_results', 'No files match your search')
            : path.length > 0
              ? t('files.folder_empty', 'This folder is empty')
              : t('files.empty_state_title', 'No files yet')}
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
        keyboardShouldPersistTaps="handled"
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
        keyboardShouldPersistTaps="handled"
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
        title={t('files.new_folder', 'New Folder')}
        placeholder={t('files.new_folder_name', 'Folder name')}
        confirmText={t('files.create', 'Create')}
        cancelText={t('files.cancel', 'Cancel')}
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
        title={t('files.rename_title', 'Rename')}
        placeholder={t('files.new_name', 'New name')}
        confirmText={t('files.rename', 'Rename')}
        cancelText={t('files.cancel', 'Cancel')}
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
        sharingEnabled={sharingEnabled}
        t={t}
        onClose={() => setActionsTarget(null)}
        onPreview={(r) => {
          setActionsTarget(null);
          setPreviewTarget(r);
        }}
        onOpenWith={(r) => {
          setActionsTarget(null);
          void openFileWith(r);
        }}
        onDownload={(r) => {
          setActionsTarget(null);
          void downloadFile(r);
        }}
        onShare={(r) => {
          setActionsTarget(null);
          setShareTarget(r);
        }}
        onMove={(r) => {
          setActionsTarget(null);
          setMoveTarget(r);
        }}
        onDuplicate={(r) => {
          setActionsTarget(null);
          void duplicateFile(r);
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

      <FolderPickerSheet
        target={moveTarget}
        allNodes={allNodes}
        rootLabel={rootLabel}
        t={t}
        onClose={() => setMoveTarget(null)}
        onPick={(destinationId) => moveTarget && void performMove(moveTarget, destinationId)}
      />

      <SortSheet
        visible={sortSheetOpen}
        sortKey={sortKey}
        sortDir={sortDir}
        t={t}
        onClose={() => setSortSheetOpen(false)}
        onChangeKey={(k) => setSetting('filesDefaultSortKey', k)}
        onChangeDir={(d) => setSetting('filesDefaultSortDir', d)}
      />

      <FilePreviewModal file={previewTarget} onClose={() => setPreviewTarget(null)} />

      <ShareSheet
        node={shareTarget}
        onClose={() => setShareTarget(null)}
        onChanged={() => void loadFiles('refresh')}
      />

      <Dialog
        visible={confirmDelete != null}
        title={
          confirmDelete && confirmDelete.rows.length > 1
            ? t('files.delete_items_title', '{count, plural, one {Delete # item?} other {Delete # items?}}', { count: confirmDelete.rows.length })
            : t('files.delete_item_title', 'Delete this item?')
        }
        message={t('files.delete_cascade_hint', "Folders are deleted along with everything inside them. This can't be undone.")}
        variant="destructive"
        confirmText={t('files.delete', 'Delete')}
        cancelText={t('files.cancel', 'Cancel')}
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
  cancelText: string;
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
                  <Text style={styles.btnGhostText}>{props.cancelText}</Text>
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
  sharingEnabled: boolean;
  t: Translate;
  onClose: () => void;
  onPreview: (r: FileRow) => void;
  onOpenWith: (r: FileRow) => void;
  onDownload: (r: FileRow) => void;
  onShare: (r: FileRow) => void;
  onMove: (r: FileRow) => void;
  onDuplicate: (r: FileRow) => void;
  onRename: (r: FileRow) => void;
  onDelete: (r: FileRow) => void;
}

function ActionsSheet({
  target, sharingEnabled, t, onClose, onPreview, onOpenWith, onDownload, onShare, onMove, onDuplicate, onRename, onDelete,
}: ActionsSheetProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeSheetStyles(c), [c]);
  if (!target) return null;
  const isDir = isFolder(target);
  // Owned nodes report full rights (or no myRights at all); shared-with-me
  // nodes are managed by their owner, and write ops would have to route to
  // the owner's account — so they only get preview/download here.
  const canShare = sharingEnabled && !target.isShared && (target.myRights?.mayShare ?? true);
  const modified = modifiedOf(target);
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop}>
          <TouchableWithoutFeedback>
            <View style={styles.sheet}>
              <Text style={styles.sheetTitle} numberOfLines={1}>
                {target.displayName}
              </Text>
              <Text style={styles.sheetMeta} numberOfLines={1}>
                {[
                  isDir ? t('files.folder', 'Folder') : (target.type || t('files.file', 'File')),
                  !isDir && target.size != null ? formatFileSize(target.size) : null,
                  modified ? formatModified(modified) : null,
                ].filter(Boolean).join(' · ')}
              </Text>
              {!isDir && canPreviewInApp(target) ? (
                <Pressable style={styles.action} onPress={() => onPreview(target)}>
                  <Eye size={18} color={c.text} />
                  <Text style={styles.actionLabel}>{t('files.preview', 'Preview')}</Text>
                </Pressable>
              ) : null}
              {!isDir ? (
                <Pressable style={styles.action} onPress={() => onOpenWith(target)}>
                  <ExternalLink size={18} color={c.text} />
                  <Text style={styles.actionLabel}>{t('files.open_with', 'Open with…')}</Text>
                </Pressable>
              ) : null}
              {!isDir ? (
                <Pressable style={styles.action} onPress={() => onDownload(target)}>
                  <Download size={18} color={c.text} />
                  <Text style={styles.actionLabel}>{t('files.download', 'Download')}</Text>
                </Pressable>
              ) : null}
              {canShare ? (
                <Pressable style={styles.action} onPress={() => onShare(target)}>
                  <Users size={18} color={c.text} />
                  <Text style={styles.actionLabel}>{t('files.sharing_access', 'Sharing & access')}</Text>
                </Pressable>
              ) : null}
              {!target.isShared ? (
                <Pressable style={styles.action} onPress={() => onMove(target)}>
                  <FolderInput size={18} color={c.text} />
                  <Text style={styles.actionLabel}>{t('files.move_to', 'Move to…')}</Text>
                </Pressable>
              ) : null}
              {!target.isShared && !isDir ? (
                <Pressable style={styles.action} onPress={() => onDuplicate(target)}>
                  <Copy size={18} color={c.text} />
                  <Text style={styles.actionLabel}>{t('files.duplicate', 'Duplicate')}</Text>
                </Pressable>
              ) : null}
              {!target.isShared ? (
                <Pressable style={styles.action} onPress={() => onRename(target)}>
                  <Pencil size={18} color={c.text} />
                  <Text style={styles.actionLabel}>{t('files.rename', 'Rename')}</Text>
                </Pressable>
              ) : null}
              {!target.isShared ? (
                <Pressable style={styles.action} onPress={() => onDelete(target)}>
                  <Trash2 size={18} color={c.error} />
                  <Text style={[styles.actionLabel, { color: c.error }]}>{t('files.delete', 'Delete')}</Text>
                </Pressable>
              ) : null}
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

interface FolderPickerSheetProps {
  target: FileRow | null;
  allNodes: FileNode[];
  rootLabel: string;
  t: Translate;
  onClose: () => void;
  onPick: (destinationId: string | null) => void;
}

// "Move to…" destination picker: every own folder except the node itself and
// its descendants (a folder can't be moved into itself), flattened with
// indentation, plus the drive root.
function FolderPickerSheet({ target, allNodes, rootLabel, t, onClose, onPick }: FolderPickerSheetProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeSheetStyles(c), [c]);
  const options = useMemo(() => {
    if (!target) return [];
    const excluded = new Set<string>([target.id]);
    // Descendants of the moved node.
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of allNodes) {
        if (n.parentId && excluded.has(n.parentId) && !excluded.has(n.id)) {
          excluded.add(n.id);
          grew = true;
        }
      }
    }
    const folders = allNodes.filter((n) => isFolder(n) && !n.isShared && !excluded.has(n.id));
    const byParent = new Map<string | null, FileNode[]>();
    for (const f of folders) {
      const key = f.parentId ?? null;
      if (!byParent.has(key)) byParent.set(key, []);
      byParent.get(key)!.push(f);
    }
    const out: { id: string | null; name: string; depth: number }[] = [{ id: null, name: rootLabel, depth: 0 }];
    const walk = (parentId: string | null, depth: number) => {
      const kids = (byParent.get(parentId) ?? []).sort((a, b) => a.name.localeCompare(b.name));
      for (const k of kids) {
        out.push({ id: k.id, name: k.name, depth });
        walk(k.id, depth + 1);
      }
    };
    walk(null, 1);
    return out;
  }, [target, allNodes, rootLabel]);

  if (!target) return null;
  const currentParent = target.parentId ?? null;
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop}>
          <TouchableWithoutFeedback>
            <View style={styles.sheet}>
              <Text style={styles.sheetTitle} numberOfLines={1}>
                {t('files.move_to', 'Move to…')} · {target.displayName}
              </Text>
              <ScrollView style={{ maxHeight: 360 }}>
                {options.map((opt) => {
                  const isCurrent = opt.id === currentParent;
                  return (
                    <Pressable
                      key={opt.id ?? '__root__'}
                      style={[styles.action, { paddingLeft: spacing.md + opt.depth * spacing.lg }]}
                      onPress={() => onPick(opt.id)}
                      disabled={isCurrent}
                    >
                      {opt.id === null ? (
                        <HardDrive size={18} color={c.text} />
                      ) : (
                        <Folder size={18} color={c.calendar.blue} />
                      )}
                      <Text style={[styles.actionLabel, isCurrent && { color: c.textMuted }]} numberOfLines={1}>
                        {opt.name}
                      </Text>
                      {isCurrent ? <Check size={16} color={c.textMuted} /> : null}
                    </Pressable>
                  );
                })}
              </ScrollView>
            </View>
          </TouchableWithoutFeedback>
        </View>
      </TouchableWithoutFeedback>
    </Modal>
  );
}

interface SortSheetProps {
  visible: boolean;
  sortKey: FilesSortKey;
  sortDir: FilesSortDir;
  t: Translate;
  onClose: () => void;
  onChangeKey: (k: FilesSortKey) => void;
  onChangeDir: (d: FilesSortDir) => void;
}

function SortSheet({ visible, sortKey, sortDir, t, onClose, onChangeKey, onChangeDir }: SortSheetProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeSheetStyles(c), [c]);
  if (!visible) return null;
  const keys: FilesSortKey[] = ['name', 'size', 'modified'];
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableWithoutFeedback onPress={onClose}>
        <View style={styles.backdrop}>
          <TouchableWithoutFeedback>
            <View style={styles.sheet}>
              <Text style={styles.sheetTitle}>{t('files.settings_default_sort', 'Sort')}</Text>
              {keys.map((k) => (
                <Pressable key={k} style={styles.action} onPress={() => { onChangeKey(k); onClose(); }}>
                  <Text style={[styles.actionLabel, sortKey === k && { color: c.primary, fontWeight: '600' }]}>
                    {t(`files.${k}`, k)}
                  </Text>
                  {sortKey === k ? <Check size={16} color={c.primary} /> : null}
                </Pressable>
              ))}
              <View style={styles.sheetDivider} />
              {(['asc', 'desc'] as FilesSortDir[]).map((d) => (
                <Pressable key={d} style={styles.action} onPress={() => { onChangeDir(d); onClose(); }}>
                  {d === 'asc' ? <ArrowUp size={18} color={c.text} /> : <ArrowDown size={18} color={c.text} />}
                  <Text style={[styles.actionLabel, sortDir === d && { color: c.primary, fontWeight: '600' }]}>
                    {d === 'asc'
                      ? t('files.settings_ascending', 'Ascending')
                      : t('files.settings_descending', 'Descending')}
                  </Text>
                  {sortDir === d ? <Check size={16} color={c.primary} /> : null}
                </Pressable>
              ))}
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
    headerBtnActive: {
      backgroundColor: c.primaryBg,
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
    toolbarRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginTop: spacing.sm,
    },
    searchInput: {
      flex: 1,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.md,
      paddingHorizontal: spacing.md,
      paddingVertical: 6,
      color: c.text,
      fontSize: typography.body.fontSize,
      backgroundColor: c.surface,
    },
    sortChip: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      paddingHorizontal: spacing.sm,
      paddingVertical: 4,
      borderRadius: radius.full,
      borderWidth: 1,
      borderColor: c.border,
    },
    sortChipText: {
      fontSize: typography.caption.fontSize,
      color: c.textMuted,
    },
    progressRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginTop: spacing.sm,
    },
    progressText: {
      fontSize: typography.caption.fontSize,
      color: c.textMuted,
      marginBottom: 4,
    },
    progressTrack: {
      height: 4,
      borderRadius: 2,
      backgroundColor: c.muted,
      overflow: 'hidden',
    },
    progressBar: {
      height: 4,
      backgroundColor: c.primary,
    },
    progressPercent: {
      fontSize: typography.caption.fontSize,
      color: c.textMuted,
      minWidth: 36,
      textAlign: 'right',
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
    fileNameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.xs,
    },
    fileName: {
      fontSize: typography.body.fontSize,
      color: c.text,
      flexShrink: 1,
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
    gridNameRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      maxWidth: '100%',
    },
    gridName: {
      fontSize: typography.caption.fontSize,
      color: c.text,
      textAlign: 'center',
      flexShrink: 1,
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
      color: c.textMuted,
      fontWeight: '500' as const,
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
      paddingHorizontal: spacing.sm,
    },
    sheetTitle: {
      ...typography.h3,
      color: c.text,
      paddingHorizontal: spacing.md,
      marginBottom: 2,
    },
    sheetMeta: {
      fontSize: typography.caption.fontSize,
      color: c.textMuted,
      paddingHorizontal: spacing.md,
      marginBottom: spacing.sm,
    },
    sheetDivider: {
      height: 1,
      backgroundColor: c.border,
      marginVertical: spacing.xs,
    },
    action: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingVertical: spacing.md,
      paddingHorizontal: spacing.md,
      borderRadius: radius.md,
    },
    actionLabel: {
      fontSize: typography.body.fontSize,
      color: c.text,
      flex: 1,
    },
  });
}
