import React from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, Modal, TextInput, Alert,
  Animated, Dimensions, Easing, ActivityIndicator,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { SafeAreaView } from 'react-native-safe-area-context';
import { isLayoutRTL } from '../i18n';
import { drawerClosedX, drawerSafeEdges } from '../lib/rtl-layout';
import {
  Inbox, Send, File as FileIcon, Trash2, Ban, Archive, Star,
  Folder, FolderOpen, ChevronDown, ChevronRight, X, Settings, LogOut, Check, Plus,
  Clock, Layers, Users, Tag, Mails, MailOpen, StickyNote, AlarmClock, Flag,
  CheckCheck, Eraser, FolderPlus, Pencil, AlertTriangle, UserMinus, Search, Globe,
  MoreHorizontal, Share2, type LucideIcon,
} from 'lucide-react-native';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { useAnimDuration } from '../theme/dynamic';
import { useEmailStore, spannedAccounts, requireShownAccountScope, emptyFolder } from '../stores/email-store';
import { useAuthStore } from '../stores/auth-store';
import { useAccountStore } from '../stores/account-store';
import { useSettingsStore } from '../stores/settings-store';
import { planEmptyFolder } from '../lib/empty-folder';
import { useKeywordsStore, keywordToken } from '../stores/keywords-store';
import { useFolderIconsStore, folderIconOf } from '../stores/folder-icons-store';
import { roleIconColor } from '../lib/sidebar-icon-color';
import { folderIconComponent } from './folder-icon';
import { useLocaleStore } from '../stores/locale-store';
import { useSendQueueStore } from '../stores/send-queue-store';
import { queuedSendCount } from '../lib/outbox-rows';
import { signOutWithGuard, signOutAllWithGuard, removeAccountWithGuard } from '../lib/sign-out-guard';
import { MAX_ACCOUNTS } from '../lib/account-utils';
import {
  buildMailboxTree, flattenVisible, mailboxSubtreeIds, ownMailboxes, type MailboxNode,
} from '../lib/mailbox-tree';
import { localizeMailboxName } from '../lib/mailbox-label';
import { useMobileSidebarApps, openSidebarApp } from '../lib/sidebar-apps';
import { showUnifiedSection } from '../lib/unified-section';
import { generateAvatarColor, getAccountInitials } from '../lib/avatar-utils';
import { jmapClient } from '../api/jmap-client';
import {
  markMailboxAsRead, createMailbox, updateMailbox, deleteMailbox,
} from '../api/email';
import { inAccount, type OpScope } from '../api/op-scope';
import { isStaleLoad } from '../lib/network-error';
import { useTagCountsStore, tagCountsFor } from '../stores/tag-counts-store';
import { tagRows } from '../lib/tag-rows';
import { trashAndJunkIds } from '../lib/search-scope';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import type { Mailbox } from '../api/types';
import { MailboxShareSheet, canOfferMailboxShare } from './MailboxShareSheet';

const CHEVRON_SLOT = 20;
const ROW_PX_BASE = 8;

const STORAGE_KEYS = {
  expanded: 'sidebar:expandedMailboxes',
  foldersExpanded: 'sidebar:foldersExpanded',
  tagsExpanded: 'sidebar:tagsExpanded',
  unifiedExpanded: 'sidebar:unifiedExpanded',
};

type UnifiedRole = 'inbox' | 'sent' | 'drafts' | 'junk' | 'archive' | 'trash';
const UNIFIED_ROLES: UnifiedRole[] = ['sent', 'drafts', 'archive', 'junk', 'trash'];
// Role folders that are kept out of the own tree while a virtual row stands
// in for them (#495).
const HIDDEN_WITH_VIRTUAL_ROW = new Set(['scheduled']);

// Distinct icons for the special-use roles (#288), then a name-based guess
// for servers that don't set roles, then a plain folder.
function iconFor(
  role: string | null | undefined,
  name: string | undefined,
  hasChildren: boolean,
  isExpanded: boolean,
): LucideIcon {
  switch (role) {
    case 'inbox': return Inbox;
    case 'sent': return Send;
    case 'drafts': return FileIcon;
    case 'trash': return Trash2;
    case 'junk':
    case 'spam': return Ban;
    case 'archive': return Archive;
    case 'important': return Flag;
    case 'flagged': return Star;
    case 'all': return Mails;
    case 'memos': return StickyNote;
    case 'scheduled': return Clock;
    case 'snoozed': return AlarmClock;
    case 'shared': return Users;
    default: break;
  }
  const lower = (name ?? '').toLowerCase();
  if (lower.includes('inbox')) return Inbox;
  if (lower.includes('sent')) return Send;
  if (lower.includes('draft')) return FileIcon;
  if (lower.includes('trash') || lower.includes('deleted')) return Trash2;
  if (lower.includes('junk') || lower.includes('spam')) return Ban;
  if (lower.includes('archive')) return Archive;
  if (lower.includes('star') || lower.includes('flag')) return Star;
  if (hasChildren) return isExpanded ? FolderOpen : Folder;
  return Folder;
}

function RowCounts({ unread, total, showTotal, onPressUnread }: {
  unread: number;
  total: number;
  showTotal: boolean;
  /** Tap the unread badge to open the folder filtered to unread. */
  onPressUnread?: () => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  if (unread === 0 && (total === 0 || !showTotal)) return null;
  return (
    <View style={styles.counts}>
      {unread > 0 && (
        <Pressable
          onPress={onPressUnread}
          disabled={!onPressUnread}
          hitSlop={8}
          accessibilityRole={onPressUnread ? 'button' : undefined}
          accessibilityLabel={onPressUnread ? t('sidebar.show_unread', 'Show unread') : undefined}
        >
          <Text style={styles.countUnread}>{unread}</Text>
        </Pressable>
      )}
      {showTotal && unread > 0 && total > 0 && <Text style={styles.countSep}>/</Text>}
      {showTotal && total > 0 && <Text style={styles.countTotal}>{total}</Text>}
    </View>
  );
}

interface SidebarRowProps {
  icon: React.ReactElement;
  label: string;
  depth: number;
  isSelected: boolean;
  /** Header for a shared/group account: styled as a section, never selected. */
  isAccountHeader?: boolean;
  unread: number;
  total: number;
  showTotal: boolean;
  hasChildren: boolean;
  isExpanded: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  onToggleExpand: () => void;
  onPressUnread?: () => void;
}

function SidebarRow({
  icon, label, depth, isSelected, isAccountHeader, unread, total, showTotal,
  hasChildren, isExpanded, onPress, onLongPress, onToggleExpand, onPressUnread,
}: SidebarRowProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const leftPad = ROW_PX_BASE + depth * componentSizes.treeIndent;
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [
        styles.row,
        isSelected && styles.rowSelected,
        pressed && !isSelected && styles.rowPressed,
      ]}
    >
      <View style={[styles.rowIndent, { paddingLeft: leftPad }]}>
        {hasChildren ? (
          <Pressable
            onPress={onToggleExpand}
            hitSlop={6}
            style={styles.chevron}
            accessibilityRole="button"
            accessibilityLabel={isExpanded ? t('sidebar.collapse', 'Collapse') : t('sidebar.expand', 'Expand')}
            accessibilityState={{ expanded: isExpanded }}
          >
            {isExpanded ? (
              <ChevronDown size={12} color={c.textMuted} />
            ) : (
              <ChevronRight size={12} color={c.textMuted} />
            )}
          </Pressable>
        ) : (
          <View style={styles.chevron} />
        )}
      </View>
      <View style={styles.rowIcon}>{icon}</View>
      <Text
        style={[
          styles.rowLabel,
          isSelected && styles.rowLabelSelected,
          isAccountHeader && styles.rowLabelAccount,
        ]}
        numberOfLines={1}
      >
        {label}
      </Text>
      <RowCounts unread={unread} total={total} showTotal={showTotal} onPressUnread={onPressUnread} />
    </Pressable>
  );
}

// A long-press action sheet for a folder (the webmail's folder context menu).
interface SheetAction {
  key: string;
  label: string;
  icon: LucideIcon;
  destructive?: boolean;
  onPress: () => void;
}

function ActionSheet({ title, actions, onClose }: { title: string; actions: SheetAction[]; onClose: () => void }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.sheetOverlay} onPress={onClose} />
      <View style={styles.sheet}>
        <Text style={styles.sheetTitle} numberOfLines={1}>{title}</Text>
        {actions.map((a) => {
          const Icon = a.icon;
          return (
            <Pressable
              key={a.key}
              onPress={() => { onClose(); a.onPress(); }}
              style={({ pressed }) => [styles.sheetRow, pressed && styles.rowPressed]}
            >
              <Icon size={16} color={a.destructive ? c.error : c.textSecondary} />
              <Text style={[styles.sheetRowText, a.destructive && { color: c.error }]}>{a.label}</Text>
            </Pressable>
          );
        })}
      </View>
    </Modal>
  );
}

// Cross-platform text prompt (Alert.prompt is iOS-only).
function NamePrompt({ title, message, initial, confirmLabel, onSubmit, onClose }: {
  title: string;
  message?: string;
  initial?: string;
  confirmLabel: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const [value, setValue] = React.useState(initial ?? '');
  const submit = () => {
    const name = value.trim();
    if (!name) return;
    onClose();
    onSubmit(name);
  };
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.sheetOverlay} onPress={onClose} />
      <View style={styles.promptCard}>
        <Text style={styles.sheetTitle}>{title}</Text>
        {message ? <Text style={styles.promptMessage}>{message}</Text> : null}
        <TextInput
          value={value}
          onChangeText={setValue}
          placeholder={t('mailbox_context_menu.placeholder_folder_name', 'Folder name')}
          placeholderTextColor={c.textMuted}
          style={styles.promptInput}
          autoFocus
          onSubmitEditing={submit}
          returnKeyType="done"
        />
        <View style={styles.promptActions}>
          <Pressable onPress={onClose} style={styles.promptButton} hitSlop={6}>
            <Text style={styles.promptButtonText}>{t('common.cancel', 'Cancel')}</Text>
          </Pressable>
          <Pressable onPress={submit} style={styles.promptButton} hitSlop={6} disabled={!value.trim()}>
            <Text style={[styles.promptButtonText, { color: c.primary }, !value.trim() && { opacity: 0.5 }]}>{confirmLabel}</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

interface SidebarDrawerProps {
  visible: boolean;
  onClose: () => void;
}

export default function SidebarDrawer({ visible, onClose }: SidebarDrawerProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const sidebarApps = useMobileSidebarApps();
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const accountSnapshots = useEmailStore((s) => s.accountSnapshots);
  const currentMailboxId = useEmailStore((s) => s.currentMailboxId);
  const filters = useEmailStore((s) => s.filters);
  const selectMailbox = useEmailStore((s) => s.selectMailbox);
  const setFilters = useEmailStore((s) => s.setFilters);
  const clearSearchAndFilters = useEmailStore((s) => s.clearSearchAndFilters);
  const fetchMailboxes = useEmailStore((s) => s.fetchMailboxes);
  const refreshEmails = useEmailStore((s) => s.refreshEmails);
  // The account whose folders the sidebar lists (the email store's view,
  // which an account switch swaps before the client serves the new account).
  const shownAccountId = useEmailStore((s) => s.activeAccountId);
  const username = useAuthStore((s) => s.username);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const switchAccount = useAuthStore((s) => s.switchAccount);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const accounts = useAccountStore((s) => s.accounts);
  const setDefaultAccount = useAccountStore((s) => s.setDefaultAccount);
  const showFolderTotalCount = useSettingsStore((s) => s.showFolderTotalCount);
  const colorfulSidebarIcons = useSettingsStore((s) => s.colorfulSidebarIcons);
  const folderIcons = useFolderIconsStore((s) => s.icons);
  const folderIconsHydrated = useFolderIconsStore((s) => s.hydrated);
  const hydrateFolderIcons = useFolderIconsStore((s) => s.hydrate);
  const includeGroupInUnified = useSettingsStore((s) => s.includeGroupInUnified);
  const unifiedCrossAccount = useSettingsStore((s) => s.unifiedCrossAccount);
  const keywordDefs = useKeywordsStore((s) => s.keywords);
  const keywordsHydrated = useKeywordsStore((s) => s.hydrated);
  const hydrateKeywords = useKeywordsStore((s) => s.hydrate);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const outboxCount = useSendQueueStore((st) => queuedSendCount(st.entries));

  const [foldersExpanded, setFoldersExpanded] = React.useState(true);
  const [tagsExpanded, setTagsExpanded] = React.useState(true);
  // The tags section's "Show all", which lists the tags set to hide too.
  const [showAllTags, setShowAllTags] = React.useState(false);
  const [unifiedExpanded, setUnifiedExpanded] = React.useState(false);
  const [expandedFolders, setExpandedFolders] = React.useState<Set<string>>(() => new Set());
  const [accountMenuOpen, setAccountMenuOpen] = React.useState(false);
  const [sheet, setSheet] = React.useState<{ title: string; actions: SheetAction[] } | null>(null);
  // The folder whose share sheet is open, and the app account it was listed under.
  const [sharing, setSharing] = React.useState<{ mailbox: Mailbox; owner: string | null } | null>(null);
  const [prompt, setPrompt] = React.useState<{
    title: string; message?: string; initial?: string; confirmLabel: string; onSubmit: (v: string) => void;
  } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const tagCounts = useTagCountsStore((s) => tagCountsFor(s, activeAccountId));
  const tagCountsGeneration = useTagCountsStore((s) => s.generation);
  const ensureTagCounts = useTagCountsStore((s) => s.ensure);

  React.useEffect(() => { if (!keywordsHydrated) void hydrateKeywords(); }, [keywordsHydrated, hydrateKeywords]);
  React.useEffect(() => { if (!folderIconsHydrated) void hydrateFolderIcons(); }, [folderIconsHydrated, hydrateFolderIcons]);

  React.useEffect(() => {
    void (async () => {
      try {
        const [rawExp, rawFld, rawTags, rawUnified] = await Promise.all([
          AsyncStorage.getItem(STORAGE_KEYS.expanded),
          AsyncStorage.getItem(STORAGE_KEYS.foldersExpanded),
          AsyncStorage.getItem(STORAGE_KEYS.tagsExpanded),
          AsyncStorage.getItem(STORAGE_KEYS.unifiedExpanded),
        ]);
        if (rawExp) {
          try {
            const ids = JSON.parse(rawExp) as string[];
            if (Array.isArray(ids)) setExpandedFolders(new Set(ids));
          } catch { /* ignore */ }
        } else {
          const tree = buildMailboxTree(mailboxes);
          const collect = (nodes: MailboxNode[]): string[] => {
            const ids: string[] = [];
            for (const n of nodes) {
              if (n.children.length > 0) { ids.push(n.id); ids.push(...collect(n.children)); }
            }
            return ids;
          };
          setExpandedFolders(new Set(collect(tree)));
        }
        if (rawFld != null) setFoldersExpanded(rawFld === 'true');
        if (rawTags != null) setTagsExpanded(rawTags === 'true');
        if (rawUnified != null) setUnifiedExpanded(rawUnified === 'true');
      } catch { /* ignore */ }
    })();
  }, [mailboxes]);

  // The server's Scheduled folder is hidden while the virtual row stands in
  // for it (#495) — only when the server can actually schedule sends.
  const hideOwnRoles = React.useMemo(
    () => (jmapClient.hasDelayedSend() ? HIDDEN_WITH_VIRTUAL_ROW : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mailboxes],
  );
  const tree = React.useMemo(() => buildMailboxTree(mailboxes, { hideOwnRoles }), [mailboxes, hideOwnRoles]);
  const visibleNodes = React.useMemo(
    () => flattenVisible(tree, expandedFolders),
    [tree, expandedFolders],
  );

  const persistExpanded = React.useCallback(async (next: Set<string>) => {
    try {
      await AsyncStorage.setItem(STORAGE_KEYS.expanded, JSON.stringify(Array.from(next)));
    } catch { /* ignore */ }
  }, []);

  const toggleExpand = React.useCallback((id: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      void persistExpanded(next);
      return next;
    });
  }, [persistExpanded]);

  const toggleSection = (key: keyof typeof STORAGE_KEYS, setter: React.Dispatch<React.SetStateAction<boolean>>) => {
    setter((prev) => {
      const next = !prev;
      void AsyncStorage.setItem(STORAGE_KEYS[key], String(next)).catch(() => {});
      return next;
    });
  };

  const handleSelect = React.useCallback((id: string) => {
    // A tag view was open: leave it so the folder shows its own mail.
    if (filters.keyword) clearSearchAndFilters();
    void selectMailbox(id);
    onClose();
  }, [selectMailbox, onClose, filters.keyword, clearSearchAndFilters]);

  // Tap the unread count → the folder filtered to unread (webmail sidebar).
  const handleSelectUnread = React.useCallback((id: string) => {
    void selectMailbox(id).then(() => setFilters({ isUnread: true }));
    onClose();
  }, [selectMailbox, setFilters, onClose]);

  // Tag view (#175): every folder, messages carrying the tag.
  const selectTag = React.useCallback((id: string) => {
    setFilters({ keyword: keywordToken(id) });
    onClose();
  }, [setFilters, onClose]);

  // Tag counts: one query pair per tag and account. A tag view lists the
  // tagged mail of the own and the shared accounts, so its badge counts all
  // of them (#1038). They are cached until an Email change is reported
  // (PF6): opening the drawer costs no request when nothing changed, and
  // while it is open a change refreshes them.
  const tagAccountsKey = React.useMemo(() => spannedAccounts(mailboxes).join('|'), [mailboxes]);
  React.useEffect(() => {
    if (!visible || !tagsExpanded || keywordDefs.length === 0 || !activeAccountId || !jmapClient.isConnected) return;
    const accounts = tagAccountsKey.split('|').map((id) => id || undefined);
    // Spam and Trash are left out, as the tag view leaves them out (#1156).
    const excludeByAccount: Record<string, string[]> = {};
    for (const id of accounts) {
      const accountId = id ?? jmapClient.accountId;
      excludeByAccount[accountId] = trashAndJunkIds(mailboxes, accountId);
    }
    void ensureTagCounts(activeAccountId, keywordDefs.map((k) => k.id), accounts, excludeByAccount);
  }, [visible, tagsExpanded, keywordDefs, tagAccountsKey, mailboxes, activeAccountId, tagCountsGeneration, ensureTagCounts]);

  // ── Folder actions (long-press) ───────────────────────────────────────
  const refFor = (mb: Mailbox) => ({
    id: mb.originalId ?? mb.id,
    accountId: mb.isShared ? mb.accountId : undefined,
  });
  // A folder action on app account `owner`'s folders (the ones listed when
  // its sheet or prompt opened). Its connection is taken at the tap and
  // passed to every request: during an account switch the list shows one
  // account while the client serves another, whose folders and messages
  // share ids (Stalwart numbers them per account), so an unscoped request
  // would empty, delete or rename the other account's folder. Refused
  // while `owner` is not the account shown and served.
  const runFolderAction = async (
    label: string,
    owner: string | null,
    work: (at: OpScope) => Promise<unknown>,
    affectsCurrent: boolean,
  ) => {
    let at: OpScope;
    try {
      at = requireShownAccountScope(owner);
    } catch (err) {
      Alert.alert(label, err instanceof Error ? err.message : String(err));
      return;
    }
    setBusy(true);
    try {
      await work(at);
      await fetchMailboxes();
      if (affectsCurrent) await refreshEmails();
    } catch (err) {
      // Stopped before sending because the client moved to another account.
      if (!isStaleLoad(err)) {
        Alert.alert(label, err instanceof Error ? err.message : String(err));
        // A run that stopped part-way (a bulk move) has still changed counts.
        Promise.all([fetchMailboxes(), affectsCurrent ? refreshEmails() : undefined]).catch((refreshErr: unknown) => {
          console.warn('[SidebarDrawer] refresh after a failed folder action failed:', refreshErr);
        });
      }
    } finally {
      setBusy(false);
    }
  };
  const markRead = (ids: string[], owner: string | null) => {
    const targets = ids
      .map((id) => mailboxes.find((m) => m.id === id))
      .filter((m): m is Mailbox => !!m && m.unreadEmails > 0);
    const affectsCurrent = !!currentMailboxId && ids.includes(currentMailboxId);
    void runFolderAction(
      t('mailbox_context_menu.toast_error_mark_read', 'Failed to mark as read'),
      owner,
      async (at) => {
        for (const mb of targets) {
          const ref = refFor(mb);
          await markMailboxAsRead(ref.id, inAccount(at, ref.accountId));
        }
      },
      affectsCurrent,
    );
  };
  const openFolderSheet = (node: MailboxNode) => {
    const mb = mailboxes.find((m) => m.id === node.id);
    if (!mb) return;
    const name = localizeMailboxName(mb.role, mb.name, t);
    const ref = refFor(mb);
    const subtree = mailboxSubtreeIds(mailboxes, mb.id);
    // The account these folders belong to, for every action of this sheet.
    const owner = shownAccountId;
    const actions: SheetAction[] = [
      { key: 'read', label: t('mailbox_context_menu.mark_folder_read', 'Mark folder as read'), icon: CheckCheck, onPress: () => markRead([mb.id], owner) },
    ];
    if (subtree.length > 1) {
      actions.push({ key: 'tree', label: t('mailbox_context_menu.mark_folder_tree_read', 'Mark folder & subfolders as read'), icon: CheckCheck, onPress: () => markRead(subtree, owner) });
    }
    if (!mb.isShared) {
      actions.push({
        key: 'all',
        label: t('mailbox_context_menu.mark_all_folders_read', 'Mark all folders as read'),
        icon: CheckCheck,
        onPress: () => Alert.alert(
          t('mailbox_context_menu.mark_all_confirm_title', 'Mark all folders as read'),
          t('mailbox_context_menu.mark_all_confirm_message', 'Mark every unread message in your personal account as read?'),
          [
            { text: t('common.cancel', 'Cancel'), style: 'cancel' },
            { text: t('mailbox_context_menu.mark_all_folders_read', 'Mark all folders as read'), onPress: () => markRead(ownMailboxes(mailboxes).map((m) => m.id), owner) },
          ],
        ),
      });
    }
    // What the tap will do, decided once so the text and the run agree.
    const plan = planEmptyFolder(mailboxes, mb, useSettingsStore.getState().deleteAction);
    // No Trash to move into: offering the action would only fail.
    if (mb.myRights?.mayRemoveItems !== false && plan.kind !== 'no-trash') {
      actions.push({
        key: 'empty',
        label: t('mailbox_context_menu.empty_folder', 'Empty folder'),
        icon: Eraser,
        destructive: true,
        onPress: () => Alert.alert(
          t('email_list.empty_folder.confirm_title', 'Empty folder'),
          plan.kind === 'destroy'
            ? t('email_list.empty_folder.confirm_message', 'All emails in this folder will be permanently deleted. This action cannot be undone.')
            : t('email_list.empty_folder.confirm_message_trash', 'All emails in this folder will be moved to the Trash.'),
          [
            { text: t('common.cancel', 'Cancel'), style: 'cancel' },
            {
              text: t('email_list.empty_folder.confirm_button', 'Empty folder'),
              style: 'destructive',
              onPress: () => void runFolderAction(
                t('mailbox_context_menu.toast_error_empty', 'Failed to empty folder'),
                owner,
                (at) => emptyFolder(plan, mb, at),
                currentMailboxId === mb.id,
              ),
            },
          ],
        ),
      });
    }
    if (mb.myRights?.mayCreateChild !== false) {
      actions.push({
        key: 'sub',
        label: t('mailbox_context_menu.new_subfolder', 'New subfolder...'),
        icon: FolderPlus,
        onPress: () => setPrompt({
          title: t('mailbox_context_menu.new_subfolder', 'New subfolder...'),
          message: t('mailbox_context_menu.prompt_new_subfolder', 'Enter a name for the new subfolder.'),
          confirmLabel: t('mailbox_context_menu.create', 'Create'),
          onSubmit: (value) => void runFolderAction(
            t('mailbox_context_menu.toast_error_create', 'Failed to create folder'),
            owner,
            async (at) => {
              await createMailbox({ name: value, parentId: ref.id }, inAccount(at, ref.accountId));
              setExpandedFolders((prev) => {
                const next = new Set(prev); next.add(mb.id); void persistExpanded(next); return next;
              });
            },
            false,
          ),
        }),
      });
    }
    if (!mb.role && mb.myRights?.mayRename !== false) {
      actions.push({
        key: 'rename',
        label: t('mailbox_context_menu.rename', 'Rename...'),
        icon: Pencil,
        onPress: () => setPrompt({
          title: t('mailbox_context_menu.rename', 'Rename...'),
          message: t('mailbox_context_menu.prompt_rename', 'Enter a new name for this folder.'),
          initial: mb.name,
          confirmLabel: t('mailbox_context_menu.rename_confirm', 'Rename'),
          onSubmit: (value) => void runFolderAction(
            t('mailbox_context_menu.toast_error_rename', 'Failed to rename folder'),
            owner,
            (at) => updateMailbox(ref.id, { name: value }, inAccount(at, ref.accountId)),
            false,
          ),
        }),
      });
    }
    // Shared out on its own account (the owner's for a folder shared with the
    // user, which only a grantee allowed to re-share may do), and only while
    // `owner` is the account shown and served.
    if (canOfferMailboxShare(mb, owner)) {
      actions.push({
        key: 'share',
        label: t('mailbox_context_menu.share', 'Share...'),
        icon: Share2,
        onPress: () => setSharing({ mailbox: mb, owner }),
      });
    }
    if (!mb.role && mb.myRights?.mayDelete !== false) {
      actions.push({
        key: 'delete',
        label: t('mailbox_context_menu.delete_folder', 'Delete folder'),
        icon: Trash2,
        destructive: true,
        onPress: () => Alert.alert(
          t('mailbox_context_menu.delete_confirm_title', 'Delete folder'),
          t('mailbox_context_menu.delete_confirm_message', `Permanently delete the folder "${mb.name}"? This action cannot be undone.`, { name: mb.name }),
          [
            { text: t('common.cancel', 'Cancel'), style: 'cancel' },
            {
              text: t('common.delete', 'Delete'),
              style: 'destructive',
              onPress: () => void runFolderAction(
                t('mailbox_context_menu.toast_error_delete', 'Failed to delete folder'),
                owner,
                async (at) => {
                  await deleteMailbox(ref.id, inAccount(at, ref.accountId), { onDestroyRemoveEmails: mb.totalEmails > 0 });
                  // Icons are set only on own folders, under the account that owns them.
                  if (!mb.isShared && owner) useFolderIconsStore.getState().setIcon(owner, mb.id, null);
                  if (currentMailboxId === mb.id) {
                    const inbox = ownMailboxes(mailboxes).find((m) => m.role === 'inbox');
                    if (inbox) void selectMailbox(inbox.id);
                  }
                },
                false,
              ),
            },
          ],
        ),
      });
    }
    setSheet({ title: name, actions });
  };
  const openSharedAccountSheet = (node: MailboxNode) => {
    const accountId = node.accountId;
    if (!accountId) return;
    const canCreate = node.children.some((n) => n.myRights?.mayCreateChild !== false);
    const owner = shownAccountId;
    const actions: SheetAction[] = [
      {
        key: 'read',
        label: t('mailbox_context_menu.mark_folder_tree_read', 'Mark folder & subfolders as read'),
        icon: CheckCheck,
        onPress: () => markRead(mailboxes.filter((m) => m.isShared && m.accountId === accountId).map((m) => m.id), owner),
      },
    ];
    if (canCreate) {
      actions.push({
        key: 'new',
        label: t('mailbox_context_menu.new_folder', 'New folder...'),
        icon: FolderPlus,
        onPress: () => setPrompt({
          title: t('mailbox_context_menu.new_folder', 'New folder...'),
          message: t('mailbox_context_menu.prompt_new_folder', 'Enter a name for the new folder.'),
          confirmLabel: t('mailbox_context_menu.create', 'Create'),
          onSubmit: (value) => void runFolderAction(
            t('mailbox_context_menu.toast_error_create', 'Failed to create folder'),
            owner,
            (at) => createMailbox({ name: value }, inAccount(at, accountId)),
            false,
          ),
        }),
      });
    }
    setSheet({ title: node.name, actions });
  };

  // ── Unified rows ──────────────────────────────────────────────────────
  // Shown only when the views hold more than this account's own folders:
  // cross-account with several accounts, or group inboxes to merge (#843).
  // Counts are projected from the mailbox lists we hold: the active
  // account's (own + shared) plus, cross-account, the tucked-away snapshots
  // of the other accounts.
  const hasSharedInbox = mailboxes.some((m) => m.isShared && m.role === 'inbox');
  const showUnified = showUnifiedSection({
    accountCount: accounts.length, unifiedCrossAccount, includeGroupInUnified, hasSharedInbox,
  });
  const unifiedCounts = React.useMemo(() => {
    const pools: Mailbox[][] = [mailboxes];
    if (unifiedCrossAccount) {
      for (const [id, snap] of Object.entries(accountSnapshots)) {
        if (id !== activeAccountId) pools.push(snap.mailboxes);
      }
    }
    const roleCount = (role: string): { unread: number; total: number; present: boolean } => {
      let unread = 0; let total = 0; let present = false;
      for (const pool of pools) {
        for (const m of pool) {
          if (m.isShared && !includeGroupInUnified) continue;
          if (m.role === role || (role === 'junk' && m.role === 'spam')) {
            present = true; unread += m.unreadEmails ?? 0; total += m.totalEmails ?? 0;
          }
        }
      }
      return { unread, total, present };
    };
    let crossUnread = 0;
    for (const pool of pools) {
      for (const m of pool) {
        if (m.isShared && !includeGroupInUnified) continue;
        if (!['junk', 'spam', 'sent', 'archive', 'trash', 'drafts'].includes(m.role ?? '')) crossUnread += m.unreadEmails ?? 0;
      }
    }
    return {
      inbox: roleCount('inbox'),
      roles: UNIFIED_ROLES.map((role) => ({ role, ...roleCount(role) })).filter((r) => r.present),
      crossUnread,
    };
  }, [mailboxes, accountSnapshots, activeAccountId, unifiedCrossAccount, includeGroupInUnified]);

  const unifiedIcon = (role: UnifiedRole): LucideIcon => iconFor(role, undefined, false, false);

  const slideX = React.useRef(new Animated.Value(drawerClosedX(Dimensions.get('window').width, isLayoutRTL()))).current;
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;
  const openDuration = useAnimDuration(240);
  const closeDuration = useAnimDuration(200);

  // Runs the slide-in. Kicked from both the visible effect and the Modal's
  // onShow: on the very first open the modal's native view is not attached yet
  // when the effect fires, so that first animation is dropped and the drawer
  // stays parked off-screen. Re-running it once the modal is on screen commits
  // the final offset (a no-op on every subsequent open).
  const runOpen = React.useCallback(() => {
    Animated.parallel([
      Animated.timing(slideX, { toValue: 0, duration: openDuration, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(overlayOpacity, { toValue: 1, duration: openDuration, useNativeDriver: true }),
    ]).start();
  }, [slideX, overlayOpacity, openDuration]);

  React.useEffect(() => {
    if (visible) {
      runOpen();
    } else {
      Animated.parallel([
        Animated.timing(slideX, { toValue: drawerClosedX(Dimensions.get('window').width, isLayoutRTL()), duration: closeDuration, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 0, duration: closeDuration, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, runOpen, slideX, overlayOpacity, closeDuration]);

  const accountEmail = username || '';
  const initials = React.useMemo(
    () => getAccountInitials('', accountEmail),
    [accountEmail],
  );
  const avatarBg = React.useMemo(
    () => (accountEmail ? generateAvatarColor(accountEmail) : c.primary),
    [accountEmail],
  );
  const hostname = React.useMemo(() => {
    if (!serverUrl) return '';
    try { return new URL(serverUrl).hostname; } catch { return serverUrl; }
  }, [serverUrl]);
  const accountEmailFull = React.useMemo(() => {
    if (!username) return hostname;
    if (username.includes('@')) return username;
    return hostname ? `${username}@${hostname}` : username;
  }, [username, hostname]);

  const confirmRemoveAccount = (acc: { id: string; email: string; username: string }) => {
    const label = acc.email || acc.username;
    void removeAccountWithGuard(acc.id, () => { onClose(); navigation.navigate('Outbox'); }, {
      title: t('sidebar.remove_account', 'Remove account'),
      message: t('sidebar.remove_account_confirm', `Remove ${label} from this device? You can add it back later.`, { account: label }),
      confirmLabel: t('sidebar.remove_account', 'Remove account'),
    });
  };

  const tagViewActive = !!filters.keyword;
  const nestedTags = useSettingsStore((s) => s.nestedTags);
  const selectedTagId = filters.keyword
    ? keywordDefs.find((kw) => keywordToken(kw.id) === filters.keyword)?.id ?? null
    : null;
  const tagList = React.useMemo(
    () => tagRows(keywordDefs, {
      nested: nestedTags, counts: tagCounts, selectedId: selectedTagId, showAll: showAllTags, applyVisibility: true,
    }),
    [keywordDefs, nestedTags, tagCounts, selectedTagId, showAllTags],
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      statusBarTranslucent
      onRequestClose={onClose}
      onShow={runOpen}
    >
      <Animated.View style={[styles.overlay, { opacity: overlayOpacity }]}>
        <Pressable style={styles.overlayPress} onPress={onClose} />
      </Animated.View>

      <Animated.View style={[styles.drawer, { transform: [{ translateX: slideX }] }]}>
        <SafeAreaView style={styles.drawerSafe} edges={drawerSafeEdges(isLayoutRTL())}>
          {/* Header: close + account switcher */}
          <View style={styles.header}>
            <Pressable
              onPress={onClose}
              style={styles.headerClose}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('common.close', 'Close')}
            >
              <X size={20} color={c.text} />
            </Pressable>
            <Pressable
              onPress={() => setAccountMenuOpen((v) => !v)}
              style={({ pressed }) => [styles.account, pressed && styles.accountPressed]}
            >
              <View style={[styles.accountAvatar, { backgroundColor: avatarBg }]}>
                <Text style={styles.accountAvatarText}>{initials}</Text>
              </View>
              <View style={styles.accountInfo}>
                <Text style={styles.accountName} numberOfLines={1}>{username || t('settings.account.title', 'Account')}</Text>
                {hostname ? (
                  <Text style={styles.accountEmail} numberOfLines={1}>{hostname}</Text>
                ) : null}
              </View>
              {busy ? (
                <ActivityIndicator size="small" color={c.textMuted} />
              ) : (
                <ChevronDown
                  size={16}
                  color={c.textMuted}
                  style={accountMenuOpen ? styles.accountChevronOpen : undefined}
                />
              )}
            </Pressable>
          </View>

          {accountMenuOpen && (
            <View style={styles.accountMenu}>
              <ScrollView style={styles.accountMenuList}>
                {accounts.map((acc) => {
                  const isActive = acc.id === activeAccountId;
                  let accHost = '';
                  try { accHost = new URL(acc.serverUrl).hostname; } catch { accHost = acc.serverUrl; }
                  const accEmail = acc.email || (acc.username.includes('@')
                    ? acc.username
                    : accHost ? `${acc.username}@${accHost}` : acc.username);
                  return (
                    <Pressable
                      key={acc.id}
                      onPress={() => {
                        if (isActive) return;
                        setAccountMenuOpen(false);
                        onClose();
                        void switchAccount(acc.id);
                      }}
                      onLongPress={isActive ? undefined : () => confirmRemoveAccount(acc)}
                      delayLongPress={350}
                      accessibilityHint={isActive ? undefined : t('sidebar.remove_account_hint', 'Long-press to remove this account')}
                      style={({ pressed }) => [
                        styles.accountMenuRow,
                        isActive && styles.accountMenuRowActive,
                        pressed && !isActive && styles.accountMenuActionPressed,
                      ]}
                    >
                      <View style={styles.accountMenuAvatarWrap}>
                        <View style={[styles.accountMenuAvatar, { backgroundColor: acc.avatarColor }]}>
                          <Text style={styles.accountMenuAvatarText}>
                            {getAccountInitials(acc.displayName, acc.email || acc.username)}
                          </Text>
                        </View>
                        {isActive && (
                          <View style={styles.accountMenuCheckBadge}>
                            <Check size={10} color={c.primaryForeground} strokeWidth={3} />
                          </View>
                        )}
                      </View>
                      <View style={styles.accountMenuInfo}>
                        <View style={styles.accountMenuNameRow}>
                          <Text style={styles.accountMenuName} numberOfLines={1}>
                            {acc.displayName || acc.username}
                          </Text>
                          {acc.isDefault && (
                            <Star size={12} color="#f59e0b" fill="#f59e0b" />
                          )}
                        </View>
                        <Text style={styles.accountMenuHost} numberOfLines={1}>{accEmail}</Text>
                        <View style={styles.accountMenuStatusRow}>
                          {acc.hasError ? (
                            <>
                              <AlertTriangle size={10} color={c.error} />
                              <Text style={[styles.accountMenuStatusText, { color: c.error }]} numberOfLines={1}>
                                {acc.errorMessage || t('sidebar.account_error', 'Needs attention')}
                              </Text>
                            </>
                          ) : (
                            <>
                              {/* The connection dot only means something for the
                                  account the live session serves. */}
                              {isActive && (
                                <View style={[
                                  styles.accountMenuStatusDot,
                                  !acc.isConnected && styles.accountMenuStatusDotOffline,
                                ]} />
                              )}
                              <Text style={styles.accountMenuStatusText} numberOfLines={1}>{accHost}</Text>
                            </>
                          )}
                        </View>
                      </View>
                      {!isActive && (
                        <Pressable
                          onPress={() => confirmRemoveAccount(acc)}
                          hitSlop={8}
                          style={styles.accountMenuRemove}
                          accessibilityRole="button"
                          accessibilityLabel={t('sidebar.remove_account', 'Remove account')}
                        >
                          <UserMinus size={14} color={c.textMuted} />
                        </Pressable>
                      )}
                    </Pressable>
                  );
                })}
              </ScrollView>

              {accounts.length < MAX_ACCOUNTS && (
                <>
                  <View style={styles.accountMenuDivider} />
                  <Pressable
                    style={({ pressed }) => [
                      styles.accountMenuAction,
                      pressed && styles.accountMenuActionPressed,
                    ]}
                    onPress={() => {
                      setAccountMenuOpen(false);
                      onClose();
                      navigation.navigate('AddAccount');
                    }}
                  >
                    <Plus size={16} color={c.textSecondary} />
                    <Text style={styles.accountMenuActionText}>{t('sidebar.add_account', 'Add account')}</Text>
                  </Pressable>
                </>
              )}

              <View style={styles.accountMenuDivider} />
              {accounts.length > 1 && activeAccountId && (() => {
                const active = accounts.find((a) => a.id === activeAccountId);
                if (!active || active.isDefault) return null;
                return (
                  <Pressable
                    style={({ pressed }) => [
                      styles.accountMenuAction,
                      pressed && styles.accountMenuActionPressed,
                    ]}
                    onPress={() => setDefaultAccount(active.id)}
                  >
                    <Star size={16} color={c.textSecondary} />
                    <Text style={styles.accountMenuActionText}>{t('sidebar.set_as_default', 'Set as default')}</Text>
                  </Pressable>
                );
              })()}
              <Pressable
                style={({ pressed }) => [
                  styles.accountMenuAction,
                  pressed && styles.accountMenuActionPressed,
                ]}
                onPress={() => {
                  setAccountMenuOpen(false);
                  onClose();
                  void signOutWithGuard(useAuthStore.getState().activeAccountId, () => navigation.navigate('Outbox'));
                }}
              >
                <LogOut size={16} color={c.textSecondary} />
                <Text style={styles.accountMenuActionText} numberOfLines={1}>
                  {t('sidebar.sign_out_of', `Sign out of ${accountEmailFull || 'account'}`, { account: accountEmailFull || 'account' })}
                </Text>
              </Pressable>
              {accounts.length > 1 && (
                <Pressable
                  style={({ pressed }) => [
                    styles.accountMenuAction,
                    pressed && styles.accountMenuActionPressed,
                  ]}
                  onPress={() => {
                    setAccountMenuOpen(false);
                    onClose();
                    void signOutAllWithGuard(() => navigation.navigate('Outbox'));
                  }}
                >
                  <LogOut size={16} color={c.error} />
                  <Text style={[styles.accountMenuActionText, { color: c.error }]}>
                    {t('sidebar.sign_out_all', 'Sign out of all accounts')}
                  </Text>
                </Pressable>
              )}
            </View>
          )}

          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            {/* Quick views */}
            {showUnified && (
              <Pressable
                style={({ pressed }) => [styles.quickRow, pressed && styles.rowPressed]}
                onPress={() => { onClose(); navigation.navigate('UnifiedInbox', { role: 'inbox' }); }}
              >
                <Layers size={16} color={c.textSecondary} />
                <Text style={styles.quickRowLabel}>
                  {unifiedCrossAccount && accounts.length > 1
                    ? t('sidebar.all_accounts', 'All accounts')
                    : t('sidebar.unified_inbox', 'All inboxes')}
                </Text>
                <View style={{ flex: 1 }} />
                <RowCounts unread={unifiedCounts.inbox.unread} total={unifiedCounts.inbox.total} showTotal={showFolderTotalCount} />
              </Pressable>
            )}
            <Pressable
              style={({ pressed }) => [styles.quickRow, pressed && styles.rowPressed]}
              onPress={() => { onClose(); navigation.navigate('GlobalSearch'); }}
            >
              <Search size={16} color={c.textSecondary} />
              <Text style={styles.quickRowLabel}>{t('global_search.title', 'Search everything')}</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.quickRow, pressed && styles.rowPressed]}
              onPress={() => { onClose(); navigation.navigate('Scheduled'); }}
            >
              <Clock size={16} color={c.textSecondary} />
              <Text style={styles.quickRowLabel}>{t('sidebar.scheduled', 'Scheduled')}</Text>
            </Pressable>
            {outboxCount > 0 && (
              <Pressable
                style={({ pressed }) => [styles.quickRow, pressed && styles.rowPressed]}
                onPress={() => { onClose(); navigation.navigate('Outbox'); }}
              >
                <Send size={16} color={c.textSecondary} />
                <Text style={styles.quickRowLabel}>{t('outbox.title_count', 'Outbox ({count})', { count: outboxCount })}</Text>
              </Pressable>
            )}

            {/* Unified per-role and cross views */}
            {showUnified && (
              <>
                <Pressable style={styles.sectionHeader} onPress={() => toggleSection('unifiedExpanded', setUnifiedExpanded)}>
                  {unifiedExpanded ? (
                    <ChevronDown size={14} color={c.textMuted} />
                  ) : (
                    <ChevronRight size={14} color={c.textMuted} />
                  )}
                  <Text style={styles.sectionHeaderText}>{t('sidebar.unified_mailbox', 'Unified mailbox')}</Text>
                </Pressable>
                {unifiedExpanded && (
                  <>
                    {([
                      { view: 'unread' as const, Icon: MailOpen, label: t('sidebar.unified_all_unread', 'All unread'), unread: unifiedCounts.crossUnread },
                      { view: 'starred' as const, Icon: Star, label: t('sidebar.unified_all_starred', 'All starred'), unread: 0 },
                      { view: 'all' as const, Icon: Mails, label: t('sidebar.unified_all_mail', 'All mail'), unread: unifiedCounts.crossUnread },
                    ]).map((row) => (
                      <SidebarRow
                        key={row.view}
                        icon={<row.Icon size={16} color={c.textSecondary} />}
                        label={row.label}
                        depth={0}
                        isSelected={false}
                        unread={row.unread}
                        total={0}
                        showTotal={false}
                        hasChildren={false}
                        isExpanded={false}
                        onPress={() => { onClose(); navigation.navigate('UnifiedInbox', { view: row.view }); }}
                        onToggleExpand={() => {}}
                      />
                    ))}
                    {unifiedCounts.roles.map((r) => {
                      const Icon = unifiedIcon(r.role);
                      return (
                        <SidebarRow
                          key={r.role}
                          icon={<Icon size={16} color={roleIconColor(r.role, false, colorfulSidebarIcons, c)} />}
                          label={t(`sidebar.unified_${r.role}`, `All ${r.role}`)}
                          depth={0}
                          isSelected={false}
                          unread={r.unread}
                          total={r.total}
                          showTotal={showFolderTotalCount}
                          hasChildren={false}
                          isExpanded={false}
                          onPress={() => { onClose(); navigation.navigate('UnifiedInbox', { role: r.role }); }}
                          onToggleExpand={() => {}}
                        />
                      );
                    })}
                  </>
                )}
              </>
            )}

            {/* Folders section */}
            <Pressable style={styles.sectionHeader} onPress={() => toggleSection('foldersExpanded', setFoldersExpanded)}>
              {foldersExpanded ? (
                <ChevronDown size={14} color={c.textMuted} />
              ) : (
                <ChevronRight size={14} color={c.textMuted} />
              )}
              <Text style={styles.sectionHeaderText}>{t('sidebar.folders', 'Folders')}</Text>
              <View style={{ flex: 1 }} />
              <Pressable
                style={styles.sectionSettings}
                hitSlop={8}
                onPress={() => { onClose(); navigation.navigate('MainTabs'); }}
                accessibilityLabel={t('sidebar.settings', 'Settings')}
              >
                <Settings size={14} color={c.textMuted} />
              </Pressable>
            </Pressable>

            {foldersExpanded && (
              mailboxes.length === 0 ? (
                <Text style={styles.empty}>{t('sidebar.loading_mailboxes', 'Loading mailboxes...')}</Text>
              ) : (
                visibleNodes.map((node) => {
                  const hasChildren = node.children.length > 0;
                  const isExpanded = expandedFolders.has(node.id);
                  // A custom icon (Settings → Folders) is set only on own
                  // folders, under the account whose folders are listed.
                  const customIcon = node.isAccountNode || node.isShared
                    ? undefined
                    : folderIconOf({ icons: folderIcons }, shownAccountId, node.id);
                  // A shared/group account's header has no mailbox behind it —
                  // tapping it only opens or closes that account's folders.
                  const Icon = node.isAccountNode
                    ? Users
                    : customIcon
                      ? folderIconComponent(customIcon)
                      : iconFor(node.role, node.name, hasChildren, isExpanded);
                  const isSelected = !node.isAccountNode && !tagViewActive && node.id === currentMailboxId;
                  return (
                    <SidebarRow
                      key={node.id}
                      icon={
                        <Icon
                          size={16}
                          color={node.isAccountNode ? c.textMuted : roleIconColor(node.role, isSelected, colorfulSidebarIcons, c)}
                        />
                      }
                      label={node.isAccountNode ? node.name : localizeMailboxName(node.role, node.name, t)}
                      depth={node.depth}
                      isSelected={isSelected}
                      isAccountHeader={node.isAccountNode}
                      unread={node.unreadEmails}
                      total={node.totalEmails}
                      showTotal={showFolderTotalCount && !node.isAccountNode}
                      hasChildren={hasChildren}
                      isExpanded={isExpanded}
                      onPress={
                        node.isAccountNode
                          ? () => toggleExpand(node.id)
                          : () => handleSelect(node.id)
                      }
                      onLongPress={
                        node.isAccountNode
                          ? () => openSharedAccountSheet(node)
                          : () => openFolderSheet(node)
                      }
                      onToggleExpand={() => toggleExpand(node.id)}
                      onPressUnread={node.isAccountNode ? undefined : () => handleSelectUnread(node.id)}
                    />
                  );
                })
              )
            )}

            {/* Tags section (#175) */}
            {keywordDefs.length > 0 && (
              <>
                <Pressable style={styles.sectionHeader} onPress={() => toggleSection('tagsExpanded', setTagsExpanded)}>
                  {tagsExpanded ? (
                    <ChevronDown size={14} color={c.textMuted} />
                  ) : (
                    <ChevronRight size={14} color={c.textMuted} />
                  )}
                  <Text style={styles.sectionHeaderText}>{t('sidebar.tags', 'Tags')}</Text>
                </Pressable>
                {tagsExpanded && tagList.rows.map(({ def: kw, depth }) => {
                  const counts = tagCounts[kw.id];
                  const isSelected = kw.id === selectedTagId;
                  const dot = c.tags[kw.color]?.dot ?? c.textMuted;
                  return (
                    <SidebarRow
                      key={kw.id}
                      // With colourful icons off a tag keeps its colour as a
                      // small dot, as in the webmail.
                      icon={colorfulSidebarIcons
                        ? <Tag size={16} color={dot} fill={dot} />
                        : <View style={[styles.tagDot, { backgroundColor: dot }]} />}
                      label={kw.label}
                      depth={depth}
                      isSelected={isSelected}
                      unread={counts?.unread ?? 0}
                      total={counts?.total ?? 0}
                      showTotal={showFolderTotalCount}
                      hasChildren={false}
                      isExpanded={false}
                      onPress={() => selectTag(kw.id)}
                      onToggleExpand={() => {}}
                    />
                  );
                })}
                {tagsExpanded && (tagList.hiddenCount > 0 || showAllTags) && (
                  <SidebarRow
                    icon={<MoreHorizontal size={16} color={c.textMuted} />}
                    label={showAllTags
                      ? t('sidebar.show_fewer_tags', 'Show less')
                      : t('sidebar.show_all_tags', 'Show all ({count})', { count: tagList.hiddenCount })}
                    depth={0}
                    isSelected={false}
                    unread={0}
                    total={0}
                    showTotal={false}
                    hasChildren={false}
                    isExpanded={false}
                    onPress={() => setShowAllTags((prev) => !prev)}
                    onToggleExpand={() => {}}
                  />
                )}
              </>
            )}
            {/* Sidebar apps: web links only, opened in a Custom Tab */}
            {sidebarApps.length > 0 && (
              <>
                <View style={styles.sectionHeader}>
                  <Text style={styles.sectionHeaderText}>{t('sidebar.apps', 'Apps')}</Text>
                </View>
                {sidebarApps.map((app) => (
                  <Pressable
                    key={app.id}
                    style={styles.quickRow}
                    onPress={() => { onClose(); void openSidebarApp(app); }}
                    accessibilityRole="link"
                    accessibilityLabel={app.name}
                  >
                    <Globe size={16} color={c.textMuted} />
                    <Text style={styles.quickRowLabel} numberOfLines={1}>{app.name}</Text>
                  </Pressable>
                ))}
              </>
            )}
          </ScrollView>
        </SafeAreaView>
      </Animated.View>

      {sheet && <ActionSheet title={sheet.title} actions={sheet.actions} onClose={() => setSheet(null)} />}
      <MailboxShareSheet
        mailbox={sharing?.mailbox ?? null}
        ownerAppAccountId={sharing?.owner ?? null}
        onClose={() => setSharing(null)}
      />
      {prompt && (
        <NamePrompt
          title={prompt.title}
          message={prompt.message}
          initial={prompt.initial}
          confirmLabel={prompt.confirmLabel}
          onSubmit={prompt.onSubmit}
          onClose={() => setPrompt(null)}
        />
      )}
    </Modal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  tagDot: { width: 10, height: 10, borderRadius: 5, margin: 3 },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  overlayPress: { flex: 1 },
  drawer: {
    position: 'absolute',
    top: 0, bottom: 0, left: 0,
    width: '85%',
    maxWidth: 340,
    // Mirror webmail's bg-secondary in both palettes - was hardcoded to the
    // dark-mode value, which left light mode unreadable (dark bg + dark text).
    backgroundColor: c.secondary,
    borderRightWidth: 1,
    borderRightColor: c.border,
  },
  drawerSafe: { flex: 1 },

  // Header
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: c.border,
  },
  headerClose: {
    width: 36, height: 36,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.sm,
  },
  account: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 6,
    borderRadius: radius.sm,
  },
  accountPressed: { backgroundColor: c.surfaceHover },
  accountChevronOpen: { transform: [{ rotate: '180deg' }] },
  accountAvatar: {
    width: 36, height: 36,
    borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  accountAvatarText: {
    ...typography.bodySemibold,
    color: c.primaryForeground,
  },
  accountInfo: { flex: 1, minWidth: 0 },
  accountName: { ...typography.bodyMedium, color: c.text },
  accountEmail: { ...typography.caption, color: c.textMuted, marginTop: 1 },

  // Account menu - floating popover card under the header
  accountMenu: {
    marginHorizontal: spacing.sm,
    marginTop: spacing.xs,
    marginBottom: spacing.sm,
    backgroundColor: c.popover,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    overflow: 'hidden',
    // Elevation / shadow
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.35,
    shadowRadius: 12,
    elevation: 8,
  },
  accountMenuList: {
    maxHeight: 260,
  },
  accountMenuRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
  },
  accountMenuRowActive: {
    backgroundColor: 'rgba(59,130,246,0.08)',
  },
  accountMenuAvatarWrap: {
    position: 'relative',
    width: 36, height: 36,
  },
  accountMenuAvatar: {
    width: 36, height: 36,
    borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  accountMenuAvatarText: {
    ...typography.caption,
    fontWeight: '600',
    color: c.primaryForeground,
  },
  accountMenuCheckBadge: {
    position: 'absolute',
    right: -3, bottom: -3,
    width: 16, height: 16,
    borderRadius: 8,
    backgroundColor: c.primary,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2,
    borderColor: '#1f1f1f',
  },
  accountMenuInfo: { flex: 1, minWidth: 0, paddingTop: 1 },
  accountMenuNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  accountMenuName: {
    ...typography.bodyMedium,
    color: c.text,
    flexShrink: 1,
    fontWeight: '600',
  },
  accountMenuHost: {
    ...typography.caption,
    color: c.textMuted,
    marginTop: 2,
  },
  accountMenuStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    marginTop: 4,
  },
  accountMenuStatusDot: {
    width: 6, height: 6,
    borderRadius: 3,
    backgroundColor: '#22c55e',
  },
  accountMenuStatusDotOffline: {
    backgroundColor: c.textMuted,
  },
  accountMenuStatusText: {
    fontSize: 10,
    lineHeight: 12,
    color: c.textMuted,
    flexShrink: 1,
  },
  accountMenuRemove: {
    width: 28, height: 28,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.sm,
  },
  accountMenuDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: c.border,
  },
  accountMenuAction: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: spacing.md,
    paddingVertical: 10,
    minHeight: 40,
  },
  accountMenuActionPressed: { backgroundColor: c.surfaceHover },
  accountMenuActionText: {
    ...typography.body,
    color: c.text,
    flexShrink: 1,
    fontSize: 13,
  },

  // Scroll
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: spacing.md },

  // Section header
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: 4,
  },
  sectionHeaderText: {
    ...typography.bodySemibold,
    color: c.text,
  },
  sectionSettings: { padding: 4 },

  quickRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
  },
  quickRowLabel: { ...typography.body, color: c.text },

  empty: {
    ...typography.body,
    color: c.textMuted,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },

  // Row
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingRight: spacing.sm,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
  },
  rowPressed: { backgroundColor: c.surfaceHover },
  rowSelected: {
    backgroundColor: c.accent,
    borderLeftColor: c.primary,
  },
  rowIndent: {
    flexDirection: 'row',
    alignItems: 'center',
    flexShrink: 0,
  },
  chevron: {
    width: CHEVRON_SLOT, height: CHEVRON_SLOT,
    alignItems: 'center', justifyContent: 'center',
  },
  rowIcon: {
    width: 16, height: 16,
    alignItems: 'center', justifyContent: 'center',
    marginRight: spacing.sm,
  },
  rowLabel: {
    flex: 1,
    ...typography.body,
    color: c.text,
  },
  rowLabelSelected: {
    ...typography.bodySemibold,
    color: c.text,
  },
  rowLabelAccount: {
    ...typography.caption,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    color: c.textSecondary,
  },
  counts: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 4,
    marginLeft: spacing.sm,
  },
  countUnread: {
    ...typography.caption,
    fontWeight: '600',
    color: c.text,
  },
  countSep: {
    ...typography.caption,
    color: c.textMuted,
    opacity: 0.6,
  },
  countTotal: {
    ...typography.caption,
    color: c.textMuted,
  },

  // Long-press action sheet / name prompt
  sheetOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  sheet: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    backgroundColor: c.popover,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    borderTopWidth: 1,
    borderColor: c.border,
    paddingTop: spacing.sm,
    paddingBottom: spacing.xl,
  },
  sheetTitle: {
    ...typography.bodySemibold,
    color: c.text,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
  },
  sheetRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    minHeight: 44,
  },
  sheetRowText: { ...typography.body, color: c.text },
  promptCard: {
    position: 'absolute',
    left: spacing.lg, right: spacing.lg,
    top: '30%',
    backgroundColor: c.popover,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.border,
    paddingVertical: spacing.sm,
  },
  promptMessage: { ...typography.caption, color: c.textSecondary, paddingHorizontal: spacing.lg },
  promptInput: {
    ...typography.body,
    color: c.text,
    marginHorizontal: spacing.lg,
    marginTop: spacing.sm,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
  },
  promptActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  promptButton: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  promptButtonText: { ...typography.bodyMedium, color: c.text },
  });
}
