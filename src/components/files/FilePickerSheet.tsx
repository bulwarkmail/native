import React from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Modal, Animated, Easing, TextInput, ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlertCircle, Check, ChevronRight, File, Folder, Search, Users, X } from 'lucide-react-native';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSheetDrag } from '../../lib/use-sheet-drag';
import { useLocaleStore } from '../../stores/locale-store';
import { useSettingsStore } from '../../stores/settings-store';
import { getFileListing, isFolder, isOwnFileNode } from '../../api/files';
import { jmapClient } from '../../api/jmap-client';
import { opScope } from '../../api/op-scope';
import { formatBytes } from '../../lib/format-bytes';
import type { FileNode } from '../../api/types';
import type { ComposerAccount } from '../../lib/composer-account';

// The level that holds what other people share with the user. JMAP ids are
// base64url (shared ones add an "accountId:" prefix), so "#" never collides.
const SHARED_WITH_ME = '#shared';

const MAX_SEARCH_RESULTS = 200;

interface Props {
  visible: boolean;
  /** The composer's owner: only its own files can be picked. */
  owner: ComposerAccount;
  /** Whether the owner is still the account the client serves, read live. */
  ownerActiveNow: () => boolean;
  onClose: () => void;
  /** Called with the chosen files of the owner's account, never folders. */
  onPick: (files: FileNode[]) => void;
}

function byFolderThenName(a: FileNode, b: FileNode): number {
  if (isFolder(a) !== isFolder(b)) return isFolder(a) ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * Picks files from the Files app to attach to a message (webmail #1179).
 * Lists the owner's tree once and browses it locally, leaving the Files
 * screen's own location and selection alone. Files shared from other
 * accounts are shown but can't be picked: their blob ids name blobs in
 * those accounts, not in the one the message is sent from.
 */
export default function FilePickerSheet({ visible, owner, ownerActiveNow, onClose, onPick }: Props) {
  const c = useColors();
  const t = useLocaleStore((s) => s.t);
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const insets = useSafeAreaInsets();
  const showHidden = useSettingsStore((s) => s.filesShowHiddenFiles);

  const [nodes, setNodes] = React.useState<FileNode[] | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const [trail, setTrail] = React.useState<{ id: string; name: string }[]>([]);
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState<Map<string, FileNode>>(() => new Map());

  const slideY = React.useRef(new Animated.Value(600)).current;
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;
  const dragHandlers = useSheetDrag({ slideY, closedY: 600, onClose });

  React.useEffect(() => {
    if (visible) {
      setTrail([]);
      setQuery('');
      setSelected(new Map());
      Animated.parallel([
        Animated.timing(slideY, { toValue: 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    } else {
      // A reopen reads the listing again; the old tree must not flash first.
      setNodes(null);
      setFailed(false);
      Animated.parallel([
        Animated.timing(slideY, { toValue: 600, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, slideY, overlayOpacity]);

  // The listing is read on the owner's connection, taken when the sheet
  // opens. One that lands after a switch is the wrong account's tree (its
  // ids and blob ids collide with the owner's), so it is dropped.
  React.useEffect(() => {
    if (!visible) return;
    setNodes(null);
    setFailed(false);
    if (!ownerActiveNow() || !owner.jmapAccountId) {
      setFailed(true);
      return;
    }
    const at = opScope(owner.jmapAccountId);
    const stillOwner = () => ownerActiveNow() && jmapClient.connectionGen === at.gen;
    let cancelled = false;
    getFileListing(owner.appAccountId, at).then(
      (list) => {
        if (cancelled) return;
        if (stillOwner()) setNodes(list);
        else setFailed(true);
      },
      (error) => {
        console.warn('[files-picker] listing failed', error);
        if (!cancelled) setFailed(true);
      },
    );
    return () => { cancelled = true; };
  }, [visible, attempt, owner, ownerActiveNow]);

  const byId = React.useMemo(() => new Map((nodes ?? []).map((n) => [n.id, n])), [nodes]);

  // Shared nodes whose parent the user can't see, as in the Files screen's
  // "Shared with me".
  const sharedRoots = React.useMemo(
    () => (nodes ?? []).filter((n) => n.isShared && (n.parentId == null || !byId.has(n.parentId))),
    [nodes, byId],
  );

  const here = trail.length > 0 ? trail[trail.length - 1].id : null;
  const needle = query.trim().toLowerCase();

  const entries = React.useMemo(() => {
    if (!nodes) return [];
    const visibleName = (n: FileNode) => showHidden || !n.name.startsWith('.');
    if (needle) {
      return nodes
        .filter((n) => !isFolder(n) && n.name.toLowerCase().includes(needle) && visibleName(n))
        .sort(byFolderThenName)
        .slice(0, MAX_SEARCH_RESULTS);
    }
    const level = here === SHARED_WITH_ME
      ? sharedRoots
      : nodes.filter((n) => (n.parentId ?? null) === here && (here !== null || !n.isShared));
    return level.filter(visibleName).sort(byFolderThenName);
  }, [nodes, needle, here, sharedRoots, showHidden]);

  // Where a search hit lives, e.g. "userb@example.org / Projects".
  const folderPath = (node: FileNode): string => {
    const names: string[] = [];
    const seen = new Set<string>();
    let parent = node.parentId ? byId.get(node.parentId) : undefined;
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id);
      names.unshift(parent.name);
      parent = parent.parentId ? byId.get(parent.parentId) : undefined;
    }
    if (node.isShared && node.accountName) names.unshift(node.accountName);
    return names.join(' / ');
  };

  const sharedBy = (node: FileNode): string | undefined =>
    node.isShared && node.accountName
      ? t('files.shared_by', 'Shared by {name}', { name: node.accountName })
      : undefined;

  const openFolder = (id: string, name: string) => {
    setTrail((prev) => [...prev, { id, name }]);
    setQuery('');
  };

  const toggle = (node: FileNode) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(node.id)) next.delete(node.id);
      else next.set(node.id, node);
      return next;
    });
  };

  const retry = () => setAttempt((n) => n + 1);

  const folderRow = (key: string, name: string, icon: React.ReactNode, onOpen: () => void, detail?: string) => (
    <Pressable
      key={key}
      onPress={onOpen}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      {icon}
      <View style={styles.rowText}>
        <Text style={styles.rowLabel} numberOfLines={1}>{name}</Text>
        {detail ? <Text style={styles.rowDetail} numberOfLines={1}>{detail}</Text> : null}
      </View>
      <ChevronRight size={16} color={c.textMuted} />
    </Pressable>
  );

  const fileRow = (node: FileNode, detail?: string) => {
    const pickable = isOwnFileNode(node, owner.jmapAccountId);
    const checked = pickable && selected.has(node.id);
    return (
      <Pressable
        key={node.id}
        onPress={pickable ? () => toggle(node) : undefined}
        disabled={!pickable}
        accessibilityRole="checkbox"
        accessibilityState={{ checked, disabled: !pickable }}
        style={({ pressed }) => [styles.row, checked && styles.rowChecked, pressed && pickable && styles.rowPressed]}
      >
        <View style={[styles.checkbox, checked && styles.checkboxChecked, !pickable && styles.disabled]}>
          {checked && <Check size={12} color={c.primaryForeground} />}
        </View>
        <File size={18} color={pickable ? c.textSecondary : c.textMuted} />
        <View style={styles.rowText}>
          <Text style={[styles.rowLabel, !pickable && styles.rowLabelDisabled]} numberOfLines={1}>{node.name}</Text>
          {detail ? <Text style={styles.rowDetail} numberOfLines={1}>{detail}</Text> : null}
        </View>
        <Text style={styles.size}>{formatBytes(node.size ?? 0)}</Text>
      </Pressable>
    );
  };

  const showSharedEntry = here === null && !needle && sharedRoots.length > 0;

  let body: React.ReactNode;
  if (failed) {
    body = (
      <View style={styles.status}>
        <AlertCircle size={22} color={c.textMuted} />
        <Text style={styles.statusText}>
          {t('email_composer.files_picker.load_failed', 'Your files could not be loaded')}
        </Text>
        <Pressable onPress={retry} style={styles.secondaryBtn} accessibilityRole="button">
          <Text style={styles.secondaryBtnText}>{t('files.retry', 'Retry')}</Text>
        </Pressable>
      </View>
    );
  } else if (!nodes) {
    body = (
      <View style={styles.status}>
        <ActivityIndicator color={c.textMuted} />
      </View>
    );
  } else if (entries.length === 0 && !showSharedEntry) {
    body = (
      <View style={styles.status}>
        <Text style={styles.statusText}>
          {needle
            ? t('files.no_results', 'No files match your search')
            : here === null
              ? t('files.empty_state_title', 'No files yet')
              : t('email_composer.files_picker.empty_folder', 'This folder is empty')}
        </Text>
      </View>
    );
  } else {
    body = (
      <>
        {showSharedEntry && folderRow(
          SHARED_WITH_ME,
          t('files.shared_with_me', 'Shared with me'),
          <Users size={18} color={c.primary} />,
          () => openFolder(SHARED_WITH_ME, t('files.shared_with_me', 'Shared with me')),
        )}
        {entries.map((node) => (isFolder(node)
          ? folderRow(
            node.id,
            node.name,
            <Folder size={18} color={c.primary} />,
            () => openFolder(node.id, node.name),
            here === SHARED_WITH_ME ? sharedBy(node) : undefined,
          )
          : fileRow(node, needle ? folderPath(node) : sharedBy(node))))}
      </>
    );
  }

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[styles.overlay, { opacity: overlayOpacity }]}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
      </Animated.View>
      <Animated.View
        style={[
          styles.sheet,
          { paddingBottom: Math.max(insets.bottom, spacing.md), transform: [{ translateY: slideY }] },
        ]}
      >
        <View {...dragHandlers}>
          <View style={styles.handleHit}>
            <View style={styles.handle} />
          </View>
          <View style={styles.header}>
            <Text style={styles.title}>{t('email_composer.attach_from_files', 'Attach from Files')}</Text>
            <Pressable
              onPress={onClose}
              hitSlop={8}
              style={styles.close}
              accessibilityRole="button"
              accessibilityLabel={t('files.cancel', 'Cancel')}
            >
              <X size={18} color={c.textSecondary} />
            </Pressable>
          </View>
        </View>

        <View style={styles.toolbar}>
          <View style={styles.searchBox}>
            <Search size={16} color={c.textMuted} />
            <TextInput
              style={styles.searchInput}
              value={query}
              onChangeText={setQuery}
              placeholder={t('files.search_placeholder', 'Search files...')}
              accessibilityLabel={t('files.search_placeholder', 'Search files...')}
              placeholderTextColor={c.textMuted}
              autoCorrect={false}
              autoCapitalize="none"
            />
          </View>
          {!needle && (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.crumbs}>
              <Pressable onPress={() => setTrail([])} accessibilityRole="button" hitSlop={4}>
                <Text style={[styles.crumb, trail.length === 0 && styles.crumbCurrent]}>
                  {t('files.breadcrumb_root', 'Home')}
                </Text>
              </Pressable>
              {trail.map((crumb, i) => (
                <View key={crumb.id} style={styles.crumbItem}>
                  <ChevronRight size={14} color={c.textMuted} />
                  <Pressable onPress={() => setTrail(trail.slice(0, i + 1))} accessibilityRole="button" hitSlop={4}>
                    <Text
                      style={[styles.crumb, i === trail.length - 1 && styles.crumbCurrent]}
                      numberOfLines={1}
                    >
                      {crumb.name}
                    </Text>
                  </Pressable>
                </View>
              ))}
            </ScrollView>
          )}
        </View>

        <ScrollView style={styles.list} keyboardShouldPersistTaps="handled">{body}</ScrollView>

        <View style={styles.footer}>
          <Pressable onPress={onClose} style={styles.secondaryBtn} accessibilityRole="button">
            <Text style={styles.secondaryBtnText}>{t('files.cancel', 'Cancel')}</Text>
          </Pressable>
          <Pressable
            onPress={() => onPick([...selected.values()])}
            disabled={selected.size === 0}
            accessibilityRole="button"
            accessibilityState={{ disabled: selected.size === 0 }}
            style={[styles.primaryBtn, selected.size === 0 && styles.disabled]}
          >
            <Text style={styles.primaryBtnText}>
              {t('email_composer.files_picker.attach', '{count, plural, =0 {Attach} one {Attach 1 file} other {Attach # files}}', {
                count: selected.size,
              })}
            </Text>
          </Pressable>
        </View>
      </Animated.View>
    </Modal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
    sheet: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      height: '80%',
      backgroundColor: c.popover,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      borderTopWidth: 1,
      borderColor: c.border,
      paddingTop: spacing.sm,
    },
    handleHit: { alignItems: 'center', paddingTop: spacing.xs, paddingBottom: spacing.sm },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: c.border },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    title: { ...typography.bodySemibold, color: c.text },
    close: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: radius.xs },
    toolbar: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      gap: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    searchBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      height: componentSizes.inputHeight,
      paddingHorizontal: spacing.md,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      backgroundColor: c.background,
    },
    searchInput: { flex: 1, ...typography.body, color: c.text, paddingVertical: 0 },
    crumbs: { alignItems: 'center', gap: spacing.xs },
    crumbItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
    crumb: { ...typography.body, color: c.textSecondary, maxWidth: 160 },
    crumbCurrent: { ...typography.bodySemibold, color: c.text },
    list: { flex: 1 },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      minHeight: 48,
    },
    rowPressed: { backgroundColor: c.surfaceHover },
    rowChecked: { backgroundColor: c.surfaceHover },
    rowText: { flex: 1, minWidth: 0 },
    rowLabel: { ...typography.body, color: c.text },
    rowLabelDisabled: { color: c.textMuted },
    rowDetail: { ...typography.caption, color: c.textMuted },
    size: { ...typography.caption, color: c.textMuted },
    checkbox: {
      width: 18,
      height: 18,
      borderRadius: radius.xs,
      borderWidth: 1,
      borderColor: c.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    checkboxChecked: { backgroundColor: c.primary, borderColor: c.primary },
    disabled: { opacity: 0.4 },
    status: { alignItems: 'center', gap: spacing.md, paddingVertical: spacing.xl * 2 },
    statusText: { ...typography.body, color: c.textMuted, textAlign: 'center', paddingHorizontal: spacing.lg },
    footer: {
      flexDirection: 'row',
      justifyContent: 'flex-end',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      borderTopWidth: 1,
      borderTopColor: c.border,
    },
    secondaryBtn: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.border,
    },
    secondaryBtnText: { ...typography.body, color: c.text },
    primaryBtn: {
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
      borderRadius: radius.sm,
      backgroundColor: c.primary,
    },
    primaryBtnText: { ...typography.bodySemibold, color: c.primaryForeground },
  });
}
