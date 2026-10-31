import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
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
  useWindowDimensions,
} from 'react-native';
import {
  ChevronLeft, FileText, Folder, FolderPlus, HardDrive, FileImage, FileVideo,
  FileAudio, FileArchive, FileSpreadsheet, FileCode2, LayoutGrid, List as ListIcon,
  MoreVertical, Pencil, Share2, Trash2, Upload, Users, X, Download, Search,
  ArrowUpDown, ArrowUp, ArrowDown, FolderInput, Copy, Check, Eye, ExternalLink, FileSymlink, RotateCcw,
} from '../components/icons';
import { useFocusEffect } from '@react-navigation/native';
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
  copyFileTree, createFolder, deleteFileNodes, getAllFileNodesAcrossAccounts,
  getFileNameRules, getFileNodeDownloadUrl, getMaxSizeUpload, isFolder,
  isSymlink, listFolder, moveFileNode, renameFileNode, supportsSharing, uploadFileBatch,
} from '../api/files';
import {
  TrashUnavailableError, emptyTrash, moveToTrash, purgeFromTrash, restoreFromTrash, undoMoveToTrash,
  type TrashMoveResult,
} from '../api/files-trash';
import {
  TRASH_FOLDER_NAME, takesTrashName, trashOriginPath, trashPlaces, trashedItems, withoutTrash, type TrashedItem,
} from '../lib/files-trash';
import { toast } from '../stores/toast-store';
import { jmapClient } from '../api/jmap-client';
import { downloadAttachment, shareAttachment } from '../lib/email-export';
import { secureFetch } from '../lib/client-cert';
import { getUniqueName } from '../lib/filenode-name';
import { fileNameProblem, type FileNameProblem } from '../lib/file-name-rules';
import { fileErrorMessage } from '../lib/file-errors';
import { filesGridLayout } from '../lib/files-grid';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { formatListDate } from '../lib/date-format';
import { useLayout, useSheetInsets } from '../lib/use-layout';
import { useBackWhileFocused } from '../lib/use-back-while-focused';
import { filesBackStep } from '../lib/files-back';
import { driveChange, type DriveScope } from '../lib/files-drive';
import { fileNodeAccess, mayCreateIn, type FileNodeAccess } from '../lib/files-access';
import type { FileNode } from '../api/types';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import {
  useSettingsStore, type FilesViewMode, type FilesSortKey, type FilesSortDir,
} from '../stores/settings-store';
import { useAuthStore } from '../stores/auth-store';
import { useLocaleStore, type TranslateFn } from '../stores/locale-store';
import Dialog from '../components/Dialog';
import ShareSheet from '../components/files/ShareSheet';
import { FilePreviewModal, canPreviewInApp } from '../components/files/FilePreviewModal';
import { MODAL_ORIENTATIONS } from '../lib/modal-orientations';

// A file row carries the display name alongside the rest of the node.
interface FileRow extends FileNode {
  displayName: string;
  /** Set for a row of the trash: when it was deleted and where from. */
  trash?: TrashedItem;
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

/**
 * Formats a file's modified time like the mail list does: in the app's
 * language and with the 12/24 h and date settings, instead of the device
 * defaults ("10:47 PM" next to 24 h times everywhere else).
 */
function useFormatModified(): (iso?: string) => string {
  const dateFormat = useSettingsStore((s) => s.dateFormat);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const locale = useLocaleStore((s) => s.locale);
  const t = useLocaleStore((s) => s.t);
  return React.useCallback(
    (iso?: string) => (iso ? formatListDate(iso, { dateFormat, timeFormat, locale, t }) : ''),
    [dateFormat, timeFormat, locale, t],
  );
}

// Last-modified with the creation time as fallback (webmail file-store
// `lastModified: node.modified || node.created`).
function modifiedOf(node: FileNode): string | undefined {
  return node.modified || node.created;
}

// The date a row shows and sorts by: in the trash, when it was deleted
// (like the webmail's trash).
function rowDateOf(row: FileRow): string | undefined {
  if (row.trash) return row.trash.deletedAt != null ? new Date(row.trash.deletedAt).toISOString() : undefined;
  return modifiedOf(row);
}

function fileNameProblemText(problem: FileNameProblem, t: Translate): string {
  switch (problem.kind) {
    case 'chars':
      return t('files.name_forbidden_chars', 'The server does not allow these characters in names: {chars}', {
        chars: problem.chars,
      });
    case 'control':
      return t('files.name_control_chars', 'Names cannot contain control characters.');
    case 'tooLong':
      return t('files.name_too_long', 'This name is too long for the server.');
    case 'reserved':
      return t('files.name_reserved', 'This name is reserved on the server.');
  }
}

// Why ".Trash" can't go to the root (see takesTrashName).
function trashNameText(t: Translate): string {
  return t('files.name_trash', '".Trash" is the name of the trash folder at the top of your files. Choose another name.');
}

// The files an upload could not store, the first three by name, and what the
// server said about the first one.
function uploadFailureDetail(failed: Array<{ name: string; error: unknown }>, t: Translate): string {
  const names = failed.slice(0, 3).map((f) => f.name).join(', ') + (failed.length > 3 ? ', …' : '');
  return `${names}: ${fileErrorMessage(failed[0].error, t)}`;
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
  const formatModified = useFormatModified();
  // Clear of the status bar (the header used a fixed 60 px top padding); the
  // whole screen keeps clear of the side insets in landscape.
  const insets = useSafeAreaInsets();
  const headerInsets = { paddingTop: insets.top + spacing.sm, paddingHorizontal: spacing.md };

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

  // The trash (lib/files-trash) is a place of its own, entered from the root.
  const [inTrash, setInTrash] = useState(false);
  // `noTrash`: the rows were meant for the trash, which could not be made.
  const [confirmDelete, setConfirmDelete] = useState<{ rows: FileRow[]; noTrash?: boolean } | null>(null);
  const [confirmEmptyTrash, setConfirmEmptyTrash] = useState(false);
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
  const session = useAuthStore((s) => s.session);

  const [viewOverride, setViewOverride] = useState<FilesViewMode | null>(null);
  const viewMode: FilesViewMode = viewOverride ?? defaultViewMode;
  const { isSplit } = useLayout();
  // The grid's columns follow its measured width (rotation, tablet panes).
  const { width: windowWidth } = useWindowDimensions();
  const [gridWidth, setGridWidth] = React.useState(0);
  const grid = filesGridLayout(gridWidth || windowWidth);

  const uploading = uploadProgress != null;
  const selectionMode = selection.size > 0;
  const currentParentId = path.length === 0 ? null : path[path.length - 1].id;
  // The webmail's `/.Trash` and everything in it stay out of every listing
  // but the trash's own, hidden files shown or not.
  const driveNodes = useMemo(() => withoutTrash(allNodes), [allNodes]);
  const trashItems = useMemo(() => trashedItems(allNodes), [allNodes]);
  // Looked up by every row of the trash; worked out once per listing.
  const trashPlacesNow = useMemo(() => trashPlaces(allNodes), [allNodes]);
  // Inside a folder another account shared with us, new folders and uploads
  // go to that account, and only where its rights allow them. Nothing is
  // added to the trash other than by deleting.
  const canCreateHere = !inTrash && mayCreateIn(currentParentId, driveNodes);
  const rootLabel = t('files.title', 'Files');
  const trashLabel = t('files.trash', 'Trash');
  const headerName = inTrash ? trashLabel : path.length === 0 ? rootLabel : path[path.length - 1].name;
  const sharingEnabled = supportsSharing();

  // Only the latest read is shown: one started before an account switch or a
  // write may finish after the next one.
  const loadSeqRef = useRef(0);
  const loadFiles = useCallback(
    async (mode: 'initial' | 'refresh' | 'quiet' = 'initial') => {
      const seq = ++loadSeqRef.current;
      if (mode === 'refresh') setRefreshing(true);
      else if (mode === 'initial') setLoading(true);
      if (mode !== 'quiet') setError(null);
      try {
        // One fetch across all accessible accounts: own files plus nodes other
        // principals shared with us (tagged isShared, ids namespaced).
        const nodes = await getAllFileNodesAcrossAccounts();
        if (seq === loadSeqRef.current) setAllNodes(nodes);
      } catch (e) {
        // A quiet read keeps what is on screen.
        if (mode !== 'quiet' && seq === loadSeqRef.current) {
          setError(e instanceof Error ? e.message : t('files.download_error', 'Failed to load files'));
        }
      } finally {
        if (seq === loadSeqRef.current) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [t],
  );
  const loadFilesRef = useRef(loadFiles);
  loadFilesRef.current = loadFiles;

  // Load on mount and reset the whole drive whenever the active account, or
  // the server behind it, changes: the node cache, folder stack and
  // selection all belong to the previous one (webmail 1.9.0 "reset the
  // account-scoped Files drive"). The same address can front another server
  // (another port, or Stalwart reinstalled there), which the account id does
  // not tell. Every new session reads the drive again.
  const driveRef = useRef<DriveScope | undefined>(undefined);
  const undoToastRef = useRef<string | null>(null);
  useEffect(() => {
    const { action, scope } = driveChange(driveRef.current, activeAccountId, session);
    driveRef.current = scope;
    if (action === 'keep') return;
    if (action === 'reset') {
      uploadAbortRef.current?.abort();
      // The last delete's Undo belongs to the previous drive.
      if (undoToastRef.current) toast.dismiss(undoToastRef.current);
      undoToastRef.current = null;
      setAllNodes([]);
      setPath([]);
      setInTrash(false);
      setSelection(new Set());
      setActionsTarget(null);
      setShareTarget(null);
      setMoveTarget(null);
      setPreviewTarget(null);
      setSearchQuery('');
    }
    // Signed out: nothing to read.
    if (action !== 'load' && !activeAccountId) return;
    void loadFiles(action === 'reload' ? 'refresh' : 'initial');
  }, [activeAccountId, session, loadFiles]);

  // Read the drive again when the tab comes back into view or the app to the
  // foreground: another device may have restored, moved or emptied what the
  // rows on screen show. The first focus is the mount, which reads already.
  const focusedRef = useRef(false);
  const seenFocusRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      focusedRef.current = true;
      if (seenFocusRef.current && driveRef.current?.account) void loadFilesRef.current('quiet');
      seenFocusRef.current = true;
      return () => {
        focusedRef.current = false;
      };
    }, []),
  );
  useEffect(() => {
    let last = AppState.currentState;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' && last !== 'active' && focusedRef.current && driveRef.current?.account) {
        void loadFilesRef.current('quiet');
      }
      last = next;
    });
    return () => subscription.remove();
  }, []);

  // If we navigated into a folder that no longer exists (deleted, moved to
  // the trash on another device, or its share was revoked), cut the stack
  // back to the deepest ancestor that does.
  useEffect(() => {
    if (allNodes.length === 0) return;
    setPath((prev) => {
      const byId = new Map(driveNodes.map((n) => [n.id, n]));
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
  }, [allNodes, driveNodes]);

  // Root: our own top-level nodes, plus the roots of every shared-with-me
  // subtree; Stalwart 1.0's placeholder folders above them are left out.
  const folderNodes = useMemo(() => listFolder(driveNodes, currentParentId), [driveNodes, currentParentId]);

  const visibleFiles = useMemo<FileRow[]>(() => {
    const q = searchQuery.trim().toLowerCase();
    const source: FileRow[] = inTrash
      ? trashItems.map((item) => ({ ...item.node, displayName: item.node.name, trash: item }))
      : folderNodes.map((n) => ({ ...n, displayName: n.name }));
    const rows = source
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
          const am = rowDateOf(a) ? new Date(rowDateOf(a)!).getTime() : 0;
          const bm = rowDateOf(b) ? new Date(rowDateOf(b)!).getTime() : 0;
          return (am - bm) * dir;
        }
        case 'name':
        default:
          return a.displayName.localeCompare(b.displayName) * dir;
      }
    });
  }, [inTrash, trashItems, folderNodes, searchQuery, showHiddenFiles, sortKey, sortDir]);

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

  // Tap on a file: the in-app preview for the types it shows (lib/file-preview),
  // the other app for the rest.
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
    if (rows.length === 1 && !isFolder(rows[0]) && !isSymlink(rows[0])) {
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
      } else if (!isSymlink(node)) {
        // A symlink (Stalwart 1.0) has no content to put in the zip.
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
      // In the trash a file can be looked at; a folder is restored before
      // it is opened. Everything else is in the row's actions.
      if (row.trash) {
        if (!isFolder(row) && !isSymlink(row) && canPreviewInApp(row)) setPreviewTarget(row);
        else setActionsTarget(row);
        return;
      }
      if (isFolder(row)) {
        setPath((p) => [...p, { id: row.id, name: row.displayName }]);
        setSearchQuery('');
        return;
      }
      // A symlink (Stalwart 1.0) has no content and holds nothing: it can be
      // renamed, moved and deleted from its actions, but not opened.
      if (isSymlink(row)) return;
      openFile(row);
    },
    [selectionMode, toggleSelect, openFile],
  );

  const handleRowLongPress = useCallback((row: FileRow) => {
    toggleSelect(row);
  }, [toggleSelect]);

  const goBack = useCallback(() => {
    if (inTrash) setInTrash(false);
    else setPath((p) => (p.length > 0 ? p.slice(0, -1) : p));
    setSearchQuery('');
    clearSelection();
  }, [inTrash, clearSelection]);

  const openTrash = useCallback(() => {
    setInTrash(true);
    setSearchQuery('');
    clearSelection();
  }, [clearSelection]);

  // Android back closes the preview, then leaves selection mode, then goes
  // up one folder (out of the trash, which opens from the root); only at the
  // root does it switch to the Mail tab.
  const backStep = filesBackStep({
    previewOpen: previewTarget != null,
    selecting: selectionMode,
    folderDepth: inTrash ? 1 : path.length,
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

  // Explains a name the server would refuse before anything is sent: the
  // naming rules it publishes (Stalwart 0.16.6+) with 1.0's stricter ones on
  // top, or at least the "/" every server refuses. `.Trash` is refused at the
  // root, where it would become the trash (lib/files-trash). True when the
  // name can go.
  const checkName = useCallback((name: string, parentId: string | null, nodeId?: string): boolean => {
    const problem = fileNameProblem(name, getFileNameRules());
    const message = problem
      ? fileNameProblemText(problem, t)
      : name.includes('/') ? t('files.invalid_name_slash', 'Names cannot contain "/".')
      : takesTrashName(name, parentId, nodeId) ? trashNameText(t)
      : null;
    if (message) Alert.alert(t('files.invalid_name', 'Invalid name'), message);
    return !message;
  }, [t]);

  const submitNewFolder = useCallback(async () => {
    const name = newFolderName.trim();
    if (!name) return;
    if (!checkName(name, currentParentId)) return;
    setNewFolderOpen(false);
    setNewFolderName('');
    try {
      await createFolder(name, currentParentId);
      await loadFiles('refresh');
    } catch (e) {
      Alert.alert(t('files.create_folder_error', 'Failed to create folder'), fileErrorMessage(e, t));
    }
  }, [newFolderName, currentParentId, loadFiles, checkName, t]);

  const submitRename = useCallback(async () => {
    if (!renameTarget) return;
    const name = renameValue.trim();
    if (!name || name === renameTarget.displayName) {
      setRenameTarget(null);
      return;
    }
    if (!checkName(name, renameTarget.parentId ?? null, renameTarget.id)) return;
    const target = renameTarget;
    setRenameTarget(null);
    setRenameValue('');
    try {
      await renameFileNode(target.id, name);
      await loadFiles('refresh');
    } catch (e) {
      Alert.alert(t('files.rename_error', 'Failed to rename'), fileErrorMessage(e, t));
    }
  }, [renameTarget, renameValue, loadFiles, checkName, t]);

  const duplicateFile = useCallback(async (row: FileRow) => {
    // A folder is copied with everything in it (webmail copyFileNode).
    if (isSymlink(row) || !fileNodeAccess(row, allNodes).duplicate) return;
    setBusyId(row.id);
    try {
      const siblings = new Set(
        allNodes.filter((n) => (n.parentId ?? null) === (row.parentId ?? null)).map((n) => n.name),
      );
      await copyFileTree(row, allNodes, row.parentId ?? null, getUniqueName(row.name, siblings));
      await loadFiles('refresh');
    } catch (e) {
      Alert.alert(t('files.duplicate_error', 'Failed to duplicate'), fileErrorMessage(e, t));
    } finally {
      setBusyId(null);
    }
  }, [allNodes, loadFiles, t]);

  const performMove = useCallback(async (row: FileRow, destinationId: string | null) => {
    setMoveTarget(null);
    if ((row.parentId ?? null) === destinationId) return;
    if (takesTrashName(row.name, destinationId, row.id)) {
      Alert.alert(t('files.move_error', 'Failed to move'), trashNameText(t));
      return;
    }
    setBusyId(row.id);
    try {
      await moveFileNode(row.id, destinationId);
      await loadFiles('refresh');
    } catch (e) {
      Alert.alert(t('files.move_error', 'Failed to move'), fileErrorMessage(e, t));
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
    const siblings = allNodes.filter((n) => (n.parentId ?? null) === parentId).map((n) => n.name);
    // A file picked as ".Trash" gets a number at the root, where the name is the trash's.
    if (takesTrashName(TRASH_FOLDER_NAME, parentId)) siblings.push(TRASH_FOLDER_NAME);
    // A refused file no longer stops the rest; the ones that failed are
    // reported once the batch is done.
    const { failed } = await uploadFileBatch(accepted, parentId, siblings, {
      signal: controller.signal,
      onFile: (index, name) => setUploadProgress({ current: index + 1, total: accepted.length, name, percent: 0 }),
      onProgress: (sent, total) =>
        setUploadProgress((p) => (p ? { ...p, percent: total > 0 ? sent / total : 0 } : p)),
    }).finally(() => {
      uploadAbortRef.current = null;
      setUploadProgress(null);
    });
    await loadFiles('refresh');
    if (failed.length > 0) {
      Alert.alert(
        t('files.upload_failed', '{count, plural, one {1 file could not be uploaded} other {# files could not be uploaded}}', {
          count: failed.length,
        }),
        uploadFailureDetail(failed, t),
      );
    }
  }, [uploading, currentParentId, allNodes, loadFiles, t]);

  // Undo of a delete: the items go back from the trash the way Restore puts
  // them back, judged against the drive as it is by then. Nothing happens
  // once another account is signed in (see undoMoveToTrash).
  const undoTrash = useCallback(async (moved: TrashMoveResult) => {
    undoToastRef.current = null;
    try {
      const result = await undoMoveToTrash(moved);
      if (!result) return;
      if (result.done.length > 0) toast.success(t('files.undo_success', 'Action undone'));
    } catch (e) {
      toast.error(t('files.undo_error', 'Failed to undo'), fileErrorMessage(e, t));
    }
    await loadFiles('refresh');
  }, [loadFiles, t]);

  // Delete in the user's own drive moves into the trash, with Undo and no
  // question, like the webmail. A drive someone shared has no trash of the
  // user's, and in the trash a delete is for good: those ask first.
  const trashRows = useCallback(async (rows: FileRow[]) => {
    clearSelection();
    const listing = allNodes;
    try {
      const moved = await moveToTrash(listing, rows);
      const { done, refused } = moved;
      await loadFiles('refresh');
      if (refused.length > 0) {
        Alert.alert(t('files.delete_error', 'Failed to delete'), fileErrorMessage(refused[0], t));
      }
      undoToastRef.current = toast.success(
        t('files.moved_to_trash', '{count, plural, one {Moved to trash} other {# items moved to trash}}', { count: done.length }),
        { action: { label: t('files.undo', 'Undo'), onPress: () => void undoTrash(moved) } },
      );
    } catch (e) {
      // No trash to be had here (a file named .Trash at the root, no right
      // to create folders there, a full quota): offer to delete for good.
      if (e instanceof TrashUnavailableError) setConfirmDelete({ rows, noTrash: true });
      else Alert.alert(t('files.delete_error', 'Failed to delete'), fileErrorMessage(e, t));
      await loadFiles('refresh');
    }
  }, [allNodes, clearSelection, loadFiles, undoTrash, t]);

  const requestDelete = useCallback((rows: FileRow[]) => {
    if (rows.length === 0) return;
    if (inTrash || rows.some((r) => r.isShared)) setConfirmDelete({ rows });
    else void trashRows(rows);
  }, [inTrash, trashRows]);

  const performDelete = useCallback(async () => {
    if (!confirmDelete) return;
    const targets = confirmDelete.rows;
    setConfirmDelete(null);
    clearSelection();
    try {
      const fromTrash = targets.flatMap((r) => (r.trash ? [r.trash] : []));
      // The server removes folder descendants (onDestroyRemoveChildren). In
      // the trash only what is still there goes (see purgeFromTrash).
      let count = targets.length;
      if (fromTrash.length > 0) count = await purgeFromTrash(fromTrash);
      else await deleteFileNodes(targets.map((r) => r.id));
      if (count > 0) {
        toast.success(t('files.deleted_forever', '{count, plural, one {Deleted permanently} other {# items deleted permanently}}', {
          count,
        }));
      }
    } catch (e) {
      Alert.alert(t('files.delete_error', 'Failed to delete'), fileErrorMessage(e, t));
    }
    await loadFiles('refresh');
  }, [confirmDelete, clearSelection, loadFiles, t]);

  const restoreRows = useCallback(async (rows: FileRow[]) => {
    const items = rows.flatMap((r) => (r.trash ? [r.trash] : []));
    if (items.length === 0) return;
    clearSelection();
    try {
      const { done, refused } = await restoreFromTrash(items);
      if (refused.length > 0) {
        Alert.alert(t('files.restore_error', "Couldn't restore"), fileErrorMessage(refused[0], t));
      }
      if (done.length > 0) {
        toast.success(t('files.restored', '{count, plural, one {Item restored} other {# items restored}}', { count: done.length }));
      }
    } catch (e) {
      Alert.alert(t('files.restore_error', "Couldn't restore"), fileErrorMessage(e, t));
    }
    await loadFiles('refresh');
  }, [clearSelection, loadFiles, t]);

  const performEmptyTrash = useCallback(async () => {
    setConfirmEmptyTrash(false);
    clearSelection();
    try {
      await emptyTrash();
      toast.success(t('files.trash_emptied', 'Trash emptied'));
    } catch (e) {
      Alert.alert(t('files.empty_trash_error', "Couldn't empty the trash"), fileErrorMessage(e, t));
    }
    await loadFiles('refresh');
  }, [clearSelection, loadFiles, t]);

  const sortLabel = t(`files.${sortKey}`, sortKey);
  const SortDirIcon = sortDir === 'desc' ? ArrowDown : ArrowUp;

  const renderHeader = () => {
    const canBack = path.length > 0 || inTrash;
    const ToggleIcon = viewMode === 'list' ? LayoutGrid : ListIcon;
    if (selectionMode) {
      const selectedRows = visibleFiles.filter((r) => selection.has(r.id));
      return (
        <View style={[styles.header, headerInsets]}>
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
              {inTrash ? (
                <Pressable
                  onPress={() => void restoreRows(selectedRows)}
                  hitSlop={8}
                  style={styles.headerBtn}
                  accessibilityLabel={t('files.restore', 'Restore')}
                >
                  <RotateCcw size={20} color={c.text} />
                </Pressable>
              ) : (
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
              )}
              <Pressable
                onPress={() => requestDelete(selectedRows)}
                hitSlop={8}
                style={styles.headerBtn}
                accessibilityLabel={inTrash ? t('files.delete_forever', 'Delete permanently') : t('files.delete', 'Delete')}
              >
                <Trash2 size={20} color={c.error} />
              </Pressable>
            </View>
          </View>
        </View>
      );
    }
    return (
      <View style={[styles.header, headerInsets]}>
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
            {canCreateHere ? (
              <Pressable
                onPress={() => setNewFolderOpen(true)}
                hitSlop={8}
                style={styles.headerBtn}
                accessibilityLabel={t('files.new_folder', 'New Folder')}
              >
                <FolderPlus size={20} color={c.text} />
              </Pressable>
            ) : null}
            {canCreateHere ? (
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
            {path.length === 0 && !inTrash ? (
              <Pressable
                onPress={openTrash}
                hitSlop={8}
                style={styles.headerBtn}
                accessibilityRole="button"
                accessibilityLabel={trashLabel}
              >
                <Trash2 size={20} color={c.text} />
              </Pressable>
            ) : null}
          </View>
        </View>
        {canBack ? (
          <Text style={styles.breadcrumb} numberOfLines={1}>
            {[rootLabel, ...(inTrash ? [trashLabel] : path.map((p) => p.name))].join(' / ')}
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
          {inTrash ? (
            <Pressable
              onPress={() => setConfirmEmptyTrash(true)}
              hitSlop={6}
              style={[styles.sortChip, trashItems.length === 0 && { opacity: 0.5 }]}
              disabled={trashItems.length === 0}
              accessibilityRole="button"
              accessibilityState={{ disabled: trashItems.length === 0 }}
            >
              <Trash2 size={13} color={c.error} />
              <Text style={[styles.sortChipText, { color: c.error }]}>{t('files.empty_trash', 'Empty trash')}</Text>
            </Pressable>
          ) : null}
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

  // Where a deleted item came from, on its row in the trash.
  const trashOrigin = (item: TrashedItem): string | null => {
    const from = trashOriginPath(item, trashPlacesNow);
    if (from === null) return null;
    return t('files.deleted_from', 'Deleted from {folder}', {
      folder: from === '/' ? t('files.my_files', 'My files') : from,
    });
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
    if (isSymlink(item)) return <FileSymlink size={size} color={c.textMuted} />;
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
    const modified = rowDateOf(item);
    const origin = item.trash ? trashOrigin(item.trash) : null;
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
            {origin ? (
              <Text style={[styles.fileMeta, styles.fileMetaShrink]} numberOfLines={1}>{origin}</Text>
            ) : null}
            {item.isShared && item.accountName ? (
              <Text style={styles.fileMeta} numberOfLines={1}>
                {t('files.shared_by', 'Shared by {name}', { name: item.accountName })}
              </Text>
            ) : null}
            {isSymlink(item) ? (
              <Text style={styles.fileMeta}>{t('files.symlink', 'Symbolic link')}</Text>
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
        ) : isSymlink(item) ? (
          <Text style={styles.gridMeta} numberOfLines={1}>
            {t('files.symlink', 'Symbolic link')}
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
  } else if (visibleFiles.length === 0 && inTrash && !searchQuery.trim()) {
    body = (
      <View style={styles.center}>
        <Trash2 size={48} color={c.textMuted} />
        <Text style={styles.emptyText}>{t('files.trash_empty_title', 'Trash is empty')}</Text>
        <Text style={styles.emptyHint}>
          {t('files.trash_empty_hint', 'Deleted files stay here until you empty the trash.')}
        </Text>
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
        // A new column count needs a fresh list.
        key={`grid-${grid.columns}`}
        numColumns={grid.columns}
        keyExtractor={(item) => item.id}
        columnWrapperStyle={styles.gridRow}
        contentContainerStyle={styles.gridContent}
        onLayout={(e) => setGridWidth(Math.round(e.nativeEvent.layout.width))}
        renderItem={({ item }) => <View style={{ width: grid.cellWidth }}>{renderGridCell(item)}</View>}
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

  // On a wide window an open file shows beside the list instead of covering it.
  const previewDocked = isSplit && previewTarget != null;
  return (
    <View style={[styles.container, previewDocked && styles.splitRow, { paddingLeft: insets.left, paddingRight: insets.right }]}>
      <View style={styles.listColumn}>
        {renderHeader()}
        {body}
      </View>
      {previewDocked && (
        <View style={styles.previewPane}>
          <FilePreviewModal docked file={previewTarget} onClose={() => setPreviewTarget(null)} />
        </View>
      )}

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
        access={actionsTarget ? fileNodeAccess(actionsTarget, allNodes) : null}
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
        onRestore={(r) => {
          setActionsTarget(null);
          void restoreRows([r]);
        }}
      />

      <FolderPickerSheet
        target={moveTarget}
        allNodes={driveNodes}
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

      {!isSplit && <FilePreviewModal file={previewTarget} onClose={() => setPreviewTarget(null)} />}

      <ShareSheet
        node={shareTarget}
        onClose={() => setShareTarget(null)}
        onChanged={() => void loadFiles('refresh')}
      />

      <Dialog
        visible={confirmDelete != null}
        title={t('files.delete_forever_title', '{count, plural, one {Delete permanently?} other {Delete # items permanently?}}', {
          count: confirmDelete?.rows.length ?? 1,
        })}
        message={
          confirmDelete?.noTrash
            ? t('files.trash_unavailable_message', "{count, plural, one {This item} other {These # items}} can't be moved to the trash. Delete permanently instead? You can't undo this.", {
              count: confirmDelete.rows.length,
            })
            : confirmDelete && confirmDelete.rows.length > 1
            ? t('files.delete_forever_message_count', "{count, plural, one {1 item} other {# items}} will be deleted. You can't undo this.", {
              count: confirmDelete.rows.length,
            })
            : t('files.delete_forever_message', "\"{name}\" will be deleted. You can't undo this.", {
              name: confirmDelete?.rows[0]?.displayName ?? '',
            })
        }
        variant="destructive"
        confirmText={t('files.delete_forever', 'Delete permanently')}
        cancelText={t('files.cancel', 'Cancel')}
        onConfirm={() => void performDelete()}
        onCancel={() => setConfirmDelete(null)}
      />

      <Dialog
        visible={confirmEmptyTrash}
        title={t('files.empty_trash_title', 'Empty trash?')}
        message={t('files.empty_trash_message', "{count, plural, one {The item in the trash} other {All # items in the trash}} will be deleted permanently. You can't undo this.", {
          count: trashItems.length,
        })}
        variant="destructive"
        confirmText={t('files.empty_trash', 'Empty trash')}
        cancelText={t('files.cancel', 'Cancel')}
        onConfirm={() => void performEmptyTrash()}
        onCancel={() => setConfirmEmptyTrash(false)}
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
    <Modal supportedOrientations={MODAL_ORIENTATIONS}
      visible={props.visible}
      transparent
      animationType="fade"
      onRequestClose={props.onCancel}
    >
      <TouchableWithoutFeedback accessible={false} onPress={props.onCancel}>
        <View style={styles.backdrop}>
          <TouchableWithoutFeedback accessible={false}>
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
  /** The writes the target allows (lib/files-access). */
  access: FileNodeAccess | null;
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
  /** For a row of the trash: put it back where it came from. */
  onRestore: (r: FileRow) => void;
}

function ActionsSheet({
  target, access, sharingEnabled, t, onClose, onPreview, onOpenWith, onDownload, onShare, onMove, onDuplicate, onRename, onDelete,
  onRestore,
}: ActionsSheetProps) {
  // Centred on a wide window, clear of side insets in landscape.
  const sheetInsets = useSheetInsets();
  const formatModified = useFormatModified();
  const c = useColors();
  const styles = React.useMemo(() => makeSheetStyles(c), [c]);
  if (!target || !access) return null;
  const isDir = isFolder(target);
  // A symlink (Stalwart 1.0) has no content: it can be renamed, moved and
  // deleted, but not previewed, opened, downloaded, duplicated or shared.
  const link = isSymlink(target);
  const isFile = !isDir && !link;
  // Owned nodes report full rights (or no myRights at all); shared-with-me
  // nodes are shared on by their owner, and get the writes their rights
  // allow (`access`).
  const canShare = sharingEnabled && !link && !target.isShared && (target.myRights?.mayShare ?? true);
  const modified = rowDateOf(target);
  // A deleted item can be restored, looked at or deleted for good, nothing else.
  if (target.trash) {
    return (
      <Modal supportedOrientations={MODAL_ORIENTATIONS} visible transparent animationType="slide" onRequestClose={onClose}>
        <TouchableWithoutFeedback accessible={false} onPress={onClose}>
          <View style={[styles.backdrop, { paddingLeft: sheetInsets.left, paddingRight: sheetInsets.right }]}>
            <TouchableWithoutFeedback accessible={false}>
              <View style={styles.sheet}>
                <Text style={styles.sheetTitle} numberOfLines={1}>
                  {target.displayName}
                </Text>
                <Text style={styles.sheetMeta} numberOfLines={1}>
                  {[
                    isDir ? t('files.folder', 'Folder') : link ? t('files.symlink', 'Symbolic link') : (target.type || t('files.file', 'File')),
                    isFile && target.size != null ? formatFileSize(target.size) : null,
                    modified ? `${t('files.deleted', 'Deleted')} ${formatModified(modified)}` : null,
                  ].filter(Boolean).join(' · ')}
                </Text>
                <Pressable style={styles.action} onPress={() => onRestore(target)}>
                  <RotateCcw size={18} color={c.text} />
                  <Text style={styles.actionLabel}>{t('files.restore', 'Restore')}</Text>
                </Pressable>
                {isFile && canPreviewInApp(target) ? (
                  <Pressable style={styles.action} onPress={() => onPreview(target)}>
                    <Eye size={18} color={c.text} />
                    <Text style={styles.actionLabel}>{t('files.preview', 'Preview')}</Text>
                  </Pressable>
                ) : null}
                {isFile ? (
                  <Pressable style={styles.action} onPress={() => onDownload(target)}>
                    <Download size={18} color={c.text} />
                    <Text style={styles.actionLabel}>{t('files.download', 'Download')}</Text>
                  </Pressable>
                ) : null}
                <Pressable style={styles.action} onPress={() => onDelete(target)}>
                  <Trash2 size={18} color={c.error} />
                  <Text style={[styles.actionLabel, { color: c.error }]}>{t('files.delete_forever', 'Delete permanently')}</Text>
                </Pressable>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    );
  }
  return (
    <Modal supportedOrientations={MODAL_ORIENTATIONS} visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableWithoutFeedback accessible={false} onPress={onClose}>
        <View style={[styles.backdrop, { paddingLeft: sheetInsets.left, paddingRight: sheetInsets.right }]}>
          <TouchableWithoutFeedback accessible={false}>
            <View style={styles.sheet}>
              <Text style={styles.sheetTitle} numberOfLines={1}>
                {target.displayName}
              </Text>
              <Text style={styles.sheetMeta} numberOfLines={1}>
                {[
                  isDir ? t('files.folder', 'Folder')
                    : link ? t('files.symlink', 'Symbolic link')
                      : (target.type || t('files.file', 'File')),
                  isFile && target.size != null ? formatFileSize(target.size) : null,
                  modified ? formatModified(modified) : null,
                ].filter(Boolean).join(' · ')}
              </Text>
              {isFile && canPreviewInApp(target) ? (
                <Pressable style={styles.action} onPress={() => onPreview(target)}>
                  <Eye size={18} color={c.text} />
                  <Text style={styles.actionLabel}>{t('files.preview', 'Preview')}</Text>
                </Pressable>
              ) : null}
              {isFile ? (
                <Pressable style={styles.action} onPress={() => onOpenWith(target)}>
                  <ExternalLink size={18} color={c.text} />
                  <Text style={styles.actionLabel}>{t('files.open_with', 'Open with…')}</Text>
                </Pressable>
              ) : null}
              {isFile ? (
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
              {access.move ? (
                <Pressable style={styles.action} onPress={() => onMove(target)}>
                  <FolderInput size={18} color={c.text} />
                  <Text style={styles.actionLabel}>{t('files.move_to', 'Move to…')}</Text>
                </Pressable>
              ) : null}
              {access.duplicate && !isSymlink(target) ? (
                <Pressable style={styles.action} onPress={() => onDuplicate(target)}>
                  <Copy size={18} color={c.text} />
                  <Text style={styles.actionLabel}>{t('files.duplicate', 'Duplicate')}</Text>
                </Pressable>
              ) : null}
              {access.rename ? (
                <Pressable style={styles.action} onPress={() => onRename(target)}>
                  <Pencil size={18} color={c.text} />
                  <Text style={styles.actionLabel}>{t('files.rename', 'Rename')}</Text>
                </Pressable>
              ) : null}
              {access.delete ? (
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
  // Centred on a wide window, clear of side insets in landscape.
  const sheetInsets = useSheetInsets();
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
    <Modal supportedOrientations={MODAL_ORIENTATIONS} visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableWithoutFeedback accessible={false} onPress={onClose}>
        <View style={[styles.backdrop, { paddingLeft: sheetInsets.left, paddingRight: sheetInsets.right }]}>
          <TouchableWithoutFeedback accessible={false}>
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
  // Centred on a wide window, clear of side insets in landscape.
  const sheetInsets = useSheetInsets();
  const c = useColors();
  const styles = React.useMemo(() => makeSheetStyles(c), [c]);
  if (!visible) return null;
  const keys: FilesSortKey[] = ['name', 'size', 'modified'];
  return (
    <Modal supportedOrientations={MODAL_ORIENTATIONS} visible transparent animationType="slide" onRequestClose={onClose}>
      <TouchableWithoutFeedback accessible={false} onPress={onClose}>
        <View style={[styles.backdrop, { paddingLeft: sheetInsets.left, paddingRight: sheetInsets.right }]}>
          <TouchableWithoutFeedback accessible={false}>
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
    splitRow: { flexDirection: 'row' },
    listColumn: { flex: 1 },
    previewPane: { width: '45%', borderLeftWidth: 1, borderLeftColor: c.border },
    header: {
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
      minWidth: componentSizes.buttonLg,
      minHeight: componentSizes.buttonLg,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm,
    },
    headerBtnActive: {
      backgroundColor: c.primaryBg,
    },
    // Same header title as Mail and Contacts (text-lg font-semibold).
    title: {
      ...typography.h3,
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
    emptyHint: {
      color: c.textMuted,
      fontSize: typography.caption.fontSize,
      textAlign: 'center',
      paddingHorizontal: spacing.lg,
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
    fileMetaShrink: {
      flexShrink: 1,
    },
    rowMore: {
      width: componentSizes.buttonLg,
      height: componentSizes.buttonLg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    gridContent: {
      padding: spacing.sm,
    },
    gridRow: {
      gap: spacing.sm,
    },
    gridItem: {
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
