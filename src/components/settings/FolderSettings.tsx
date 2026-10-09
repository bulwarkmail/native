import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  Folder, Inbox, Send, FileText, Trash, ShieldAlert, Archive, Flag, Star, Mails,
  StickyNote, Clock, AlarmClock, Users, Plus, Pencil, Trash2, X, ChevronUp, ChevronDown, Share2,
} from 'lucide-react-native';
import { SettingsSection, Select } from './settings-section';
import Button from '../Button';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { ownMailboxes, mailboxSubtreeIds, buildMailboxTree, flattenAll, type MailboxNode } from '../../lib/mailbox-tree';
import { planFolderMove, siblingsOf, withSortOrders, withUnlistedFolders, type SortOrderUpdate } from '../../lib/folder-reorder';
import { isStaleLoad } from '../../lib/network-error';
import { localizeMailboxName } from '../../lib/mailbox-label';
import { useEmailStore, requireShownAccountScope, AccountNotServedError } from '../../stores/email-store';
import { useLocaleStore } from '../../stores/locale-store';
import { createMailbox, updateMailbox, deleteMailbox, setMailboxSortOrders } from '../../api/email';
import { inAccount } from '../../api/op-scope';
import { jmapClient } from '../../api/jmap-client';
import type { Mailbox } from '../../api/types';
import { useFolderIconsStore, folderIconOf } from '../../stores/folder-icons-store';
import { FOLDER_ICON_NAMES, folderIconLabel, type FolderIconName } from '../../lib/folder-icons';
import { folderIconComponent } from '../folder-icon';
import { folderIconPrunePlan } from '../../lib/folder-icon-prune';
import { useAuthStore } from '../../stores/auth-store';
import { MailboxShareSheet, canOfferMailboxShare } from '../MailboxShareSheet';
import { createAfterDismiss } from '../../lib/after-dismiss';

const ROLE_ICON: Record<string, any> = {
  inbox: Inbox, drafts: FileText, sent: Send, trash: Trash,
  junk: ShieldAlert, spam: ShieldAlert, archive: Archive, important: Flag, flagged: Star,
  all: Mails, memos: StickyNote, scheduled: Clock, snoozed: AlarmClock, shared: Users,
};

// Special-use roles a user folder can be given (RFC 8621 §2 + the common
// Stalwart extras). The server enforces uniqueness per account.
const ASSIGNABLE_ROLES = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash', 'important', 'all', 'flagged', 'memos', 'scheduled', 'snoozed'];

function getIcon(mb: Mailbox) {
  if (mb.role && ROLE_ICON[mb.role]) return ROLE_ICON[mb.role];
  return Folder;
}

const NO_PARENT = '__root__';
const OWN_ACCOUNT = '__own__';
const NO_ROLE = '__none__';

const NO_UPDATES: SortOrderUpdate[] = [];
const NO_EDGES = new Map<string, { first: boolean; last: boolean }>();

/** Whether each folder is first or last of its sibling group, to disable the edge buttons. */
function siblingEdges(tree: MailboxNode[]): Map<string, { first: boolean; last: boolean }> {
  const out = new Map<string, { first: boolean; last: boolean }>();
  const walk = (nodes: MailboxNode[]) => {
    const group = nodes.filter((n) => !n.isAccountNode);
    group.forEach((n, i) => out.set(n.id, { first: i === 0, last: i === group.length - 1 }));
    for (const n of nodes) walk(n.children);
  };
  walk(tree);
  return out;
}

// `owner`: the app account whose folders the editor was opened on. During an
// account switch the list shows one account while the client serves another,
// whose folders share ids, so a save runs only on a scope taken for `owner`.
type Editor =
  | { kind: 'create'; owner: string | null }
  | { kind: 'edit'; mailbox: Mailbox; owner: string | null };

/** "Parent / Child" path used to label folders in the pickers. */
function pathOf(all: Mailbox[], mb: Mailbox, t: (k: string, f?: string) => string): string {
  const byId = new Map(all.map((m) => [m.id, m]));
  const parts = [localizeMailboxName(mb.role, mb.name, t)];
  let node: Mailbox | undefined = mb;
  let guard = 0;
  while (node?.parentId && guard++ < 16) {
    node = byId.get(node.parentId);
    if (node) parts.unshift(localizeMailboxName(node.role, node.name, t));
  }
  return parts.join(' / ');
}

export function FolderSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const allMailboxes = useEmailStore((s) => s.mailboxes);
  const mailboxes = React.useMemo(() => ownMailboxes(allMailboxes), [allMailboxes]);
  const fetchMailboxes = useEmailStore((s) => s.fetchMailboxes);
  const shownAccountId = useEmailStore((s) => s.activeAccountId);

  const [editor, setEditor] = useState<Editor | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftParent, setDraftParent] = useState<string>(NO_PARENT);
  const [draftAccount, setDraftAccount] = useState<string>(OWN_ACCOUNT);
  const [draftRole, setDraftRole] = useState<string>(NO_ROLE);
  // null: the role's (or the plain folder) icon. Written on save only once
  // picked, so an editor opened before the stored icons were read cannot
  // clear one.
  const [draftIcon, setDraftIcon] = useState<FolderIconName | null>(null);
  const [iconPicked, setIconPicked] = useState(false);
  const pickIcon = (name: FolderIconName | null) => { setDraftIcon(name); setIconPicked(true); };
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [reorderMode, setReorderMode] = useState(false);
  // The planned positions, laid over the store's folders until the refetch
  // after the write brings the server's own numbers. Kept with the account
  // they were planned on: folder ids repeat across accounts.
  const [overlay, setOverlay] = useState<{ accountId: string | null; updates: SortOrderUpdate[] } | null>(null);
  const [reordering, setReordering] = useState(false);

  useEffect(() => {
    if (mailboxes.length === 0) void fetchMailboxes();
  }, [mailboxes.length, fetchMailboxes]);

  const folderIcons = useFolderIconsStore((s) => s.icons);
  const folderIconsHydrated = useFolderIconsStore((s) => s.hydrated);
  const hydrateFolderIcons = useFolderIconsStore((s) => s.hydrate);
  const pruneFolderIcons = useFolderIconsStore((s) => s.prune);
  useEffect(() => { if (!folderIconsHydrated) void hydrateFolderIcons(); }, [folderIconsHydrated, hydrateFolderIcons]);
  // An editor opened before the stored icons were read shows the folder's
  // icon once they are, unless one was picked meanwhile.
  const editingId = editor?.kind === 'edit' ? editor.mailbox.id : null;
  const editingOwner = editor?.owner ?? null;
  useEffect(() => {
    if (!folderIconsHydrated || !editingId || iconPicked) return;
    setDraftIcon(folderIconOf(useFolderIconsStore.getState(), editingOwner, editingId) ?? null);
  }, [folderIconsHydrated, editingId, editingOwner, iconPicked]);
  // Folders deleted elsewhere (webmail, another device) leave their icon
  // behind: drop icons for ids that are gone, but only from an own list the
  // server confirmed (see folderIconPrunePlan). Only the shown account's
  // entries are touched.
  const mailboxState = useEmailStore((s) => s.mailboxState);
  const listsSynced = useEmailStore((s) => !!shownAccountId && !!s.mailboxListsSynced[shownAccountId]);
  const lastPruneKey = React.useRef<string | null>(null);
  useEffect(() => {
    const plan = folderIconPrunePlan(lastPruneKey.current, {
      accountId: shownAccountId,
      mailboxState,
      synced: listsSynced,
      ownIds: mailboxes.map((m) => m.id),
    });
    if (!plan) return;
    lastPruneKey.current = plan.key;
    pruneFolderIcons(plan.accountId, plan.liveIds, plan.key);
  }, [shownAccountId, mailboxState, listsSynced, mailboxes, pruneFolderIcons]);

  // Shared/group accounts the user may create folders in (webmail: "New
  // folder" on a shared account header routes to the owner account).
  const sharedAccounts = React.useMemo(() => {
    const out: { id: string; name: string }[] = [];
    const seen = new Set<string>();
    for (const m of allMailboxes) {
      if (!m.isShared || !m.accountId || seen.has(m.accountId)) continue;
      if (m.myRights?.mayCreateChild === false) continue;
      seen.add(m.accountId);
      out.push({ id: m.accountId, name: m.accountName || jmapClient.getAccountName(m.accountId) || m.accountId });
    }
    return out;
  }, [allMailboxes]);

  // Folders of the account the editor targets, for the parent picker.
  const parentCandidates = React.useMemo(() => {
    const pool = draftAccount === OWN_ACCOUNT
      ? mailboxes
      : allMailboxes.filter((m) => m.isShared && m.accountId === draftAccount);
    // Moving a folder under itself or one of its descendants is impossible.
    const excluded = editor?.kind === 'edit' ? new Set(mailboxSubtreeIds(pool, editor.mailbox.id)) : new Set<string>();
    return pool
      .filter((m) => !excluded.has(m.id) && m.myRights?.mayCreateChild !== false)
      .map((m) => ({ value: m.id, label: pathOf(pool, m, t) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [draftAccount, mailboxes, allMailboxes, editor, t]);

  const pending = overlay && overlay.accountId === shownAccountId ? overlay.updates : NO_UPDATES;
  // The drawer's order, so a move here shows the same way there. Unlike the
  // drawer, Settings hides no folder (webmail's Settings neither): the
  // server's Scheduled folder is listed and moves with its siblings.
  const tree = React.useMemo(
    () => buildMailboxTree(withSortOrders(mailboxes, pending)),
    [mailboxes, pending],
  );
  const rows = React.useMemo(() => withUnlistedFolders(flattenAll(tree), mailboxes), [tree, mailboxes]);
  const edges = React.useMemo(() => (reorderMode ? siblingEdges(tree) : NO_EDGES), [reorderMode, tree]);

  const openCreate = () => {
    setEditor({ kind: 'create', owner: shownAccountId });
    setDraftName('');
    setDraftParent(NO_PARENT);
    setDraftAccount(OWN_ACCOUNT);
    setDraftRole(NO_ROLE);
    setDraftIcon(null);
    setIconPicked(false);
  };

  const openEdit = (mailbox: Mailbox) => {
    setEditor({ kind: 'edit', mailbox, owner: shownAccountId });
    setDraftName(mailbox.name);
    setDraftParent(mailbox.parentId ?? NO_PARENT);
    setDraftAccount(OWN_ACCOUNT);
    setDraftRole(mailbox.role ?? NO_ROLE);
    setDraftIcon(folderIconOf(useFolderIconsStore.getState(), shownAccountId, mailbox.id) ?? null);
    setIconPicked(false);
  };

  const closeEditor = () => setEditor(null);

  // "Share…" is offered by the account the editor was opened on, as the
  // drawer does: never by whichever account the connection serves now. The
  // session is read so a capability change redraws the editor.
  useAuthStore((s) => s.session);
  const canShare = editor?.kind === 'edit' && canOfferMailboxShare(editor.mailbox, editor.owner);
  const [sharing, setSharing] = useState<{ mailbox: Mailbox; owner: string | null } | null>(null);
  // An edit not yet saved would be lost by leaving for the share sheet, so
  // Share waits for Save.
  const draftDirty = editor?.kind === 'edit' && (
    (!editor.mailbox.role && draftName.trim() !== editor.mailbox.name)
    || (draftParent === NO_PARENT ? null : draftParent) !== (editor.mailbox.parentId ?? null)
    || (draftRole === NO_ROLE ? null : draftRole) !== (editor.mailbox.role ?? null)
    || iconPicked
  );
  // iOS can't present the share sheet while the editor is still sliding
  // away: it opens once the editor is gone (onDismiss is iOS only), or after
  // a timeout when onDismiss never comes.
  const [shareAfterEditor] = useState(() => createAfterDismiss<{ mailbox: Mailbox; owner: string | null }>(setSharing));
  useEffect(() => () => shareAfterEditor.cancel(), [shareAfterEditor]);
  const openShareFromEditor = (target: { mailbox: Mailbox; owner: string | null }) => {
    closeEditor();
    if (Platform.OS === 'ios') shareAfterEditor.arm(target);
    else setSharing(target);
  };
  const onEditorDismissed = () => shareAfterEditor.dismissed();

  // Settings lists only own folders, so the ids here are the raw JMAP ids the
  // shown account's scope writes to.
  const moveFolder = async (id: string, direction: 'up' | 'down') => {
    if (reordering) return;
    let at;
    try {
      at = requireShownAccountScope(shownAccountId);
    } catch (err) {
      // After a switch the list is about to show the other account; while
      // one is still loading, say so.
      if (err instanceof AccountNotServedError && err.reason === 'switched') return;
      Alert.alert(t('settings.folders.reorder_error', 'Failed to reorder folders'), err instanceof Error ? err.message : undefined);
      return;
    }
    const plan = planFolderMove(siblingsOf(tree, id) ?? [], id, direction);
    if (plan.length === 0) return;
    setOverlay({ accountId: shownAccountId, updates: plan });
    setReordering(true);
    let saved = false;
    try {
      await setMailboxSortOrders(plan, at);
      saved = true;
      await fetchMailboxes();
    } catch (err) {
      // A refetch that fails after the write landed is not a failed reorder
      // (the next sync brings the new order), nor is a write the connection
      // dropped for an account switch.
      if (!saved) {
        void fetchMailboxes();
        if (!isStaleLoad(err)) Alert.alert(t('settings.folders.reorder_error', 'Failed to reorder folders'));
      }
    } finally {
      setOverlay(null);
      setReordering(false);
    }
  };

  const saveDraft = async () => {
    const name = draftName.trim();
    if (!name) {
      Alert.alert(t('settings.folders.name_required', 'Name required'));
      return;
    }
    if (!editor) return;
    let at;
    try {
      at = requireShownAccountScope(editor.owner);
    } catch (err) {
      Alert.alert(t('settings.folders.save_failed', 'Save failed'), err instanceof Error ? err.message : String(err));
      return;
    }
    setSaving(true);
    try {
      if (editor.kind === 'create') {
        const accountId = draftAccount === OWN_ACCOUNT ? undefined : draftAccount;
        const parentId = draftParent === NO_PARENT ? null : draftParent;
        const raw = parentId
          ? allMailboxes.find((m) => m.id === parentId)?.originalId ?? parentId
          : null;
        const id = await createMailbox(
          { name, parentId: raw, ...(draftRole !== NO_ROLE ? { role: draftRole } : {}) },
          inAccount(at, accountId),
        );
        // Icons are kept for own folders only, under the account the editor
        // was opened on (never the live one, which a switch may have moved).
        if (!accountId && draftIcon && editor.owner) {
          useFolderIconsStore.getState().setIcon(editor.owner, id, draftIcon);
        }
      } else {
        const mb = editor.mailbox;
        const changes: { name?: string; parentId?: string | null; role?: string | null } = {};
        if (name !== mb.name && !mb.role) changes.name = name;
        const nextParent = draftParent === NO_PARENT ? null : draftParent;
        if ((mb.parentId ?? null) !== nextParent) changes.parentId = nextParent;
        const nextRole = draftRole === NO_ROLE ? null : draftRole;
        if ((mb.role ?? null) !== nextRole) changes.role = nextRole;
        if (Object.keys(changes).length > 0) await updateMailbox(mb.id, changes, at);
        if (iconPicked && editor.owner) useFolderIconsStore.getState().setIcon(editor.owner, mb.id, draftIcon);
      }
      closeEditor();
      // A reparent moves the whole subtree: re-read the tree rather than
      // patching one node (#855).
      await fetchMailboxes();
    } catch (err) {
      Alert.alert(t('settings.folders.save_failed', 'Save failed'), err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = (mailbox: Mailbox) => {
    const owner = shownAccountId;
    if (mailbox.role) {
      Alert.alert(t('settings.folders.cannot_delete', 'Cannot delete'), t('settings.folders.system_folder_delete', 'System folders cannot be removed.'));
      return;
    }
    const name = mailbox.name;
    if ((mailbox.totalEmails ?? 0) > 0) {
      Alert.alert(
        t('settings.folders.not_empty_title', 'Folder not empty'),
        t('settings.folders.not_empty_message', `"${name}" contains ${mailbox.totalEmails} emails. Delete anyway?`, { name, count: mailbox.totalEmails }),
        [
          { text: t('common.cancel', 'Cancel'), style: 'cancel' },
          { text: t('common.delete', 'Delete'), style: 'destructive', onPress: () => { void performDelete(mailbox, true, owner); } },
        ],
      );
      return;
    }
    Alert.alert(
      t('mailbox_context_menu.delete_confirm_title', 'Delete folder'),
      t('mailbox_context_menu.delete_confirm_message', `Permanently delete the folder "${name}"? This action cannot be undone.`, { name }),
      [
        { text: t('common.cancel', 'Cancel'), style: 'cancel' },
        { text: t('common.delete', 'Delete'), style: 'destructive', onPress: () => { void performDelete(mailbox, false, owner); } },
      ],
    );
  };

  const performDelete = async (mailbox: Mailbox, removeEmails: boolean, owner: string | null) => {
    let at;
    try {
      at = requireShownAccountScope(owner);
    } catch (err) {
      Alert.alert(t('mailbox_context_menu.toast_error_delete', 'Failed to delete folder'), err instanceof Error ? err.message : String(err));
      return;
    }
    setBusyId(mailbox.id);
    try {
      await deleteMailbox(mailbox.id, at, { onDestroyRemoveEmails: removeEmails });
      if (owner) useFolderIconsStore.getState().setIcon(owner, mailbox.id, null);
      await fetchMailboxes();
    } catch (err) {
      Alert.alert(t('mailbox_context_menu.toast_error_delete', 'Failed to delete folder'), err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const roleOptions = React.useMemo(() => {
    const takenByOthers = new Set(
      mailboxes
        .filter((m) => m.role && (editor?.kind !== 'edit' || m.id !== editor.mailbox.id))
        .map((m) => m.role as string),
    );
    return [
      { value: NO_ROLE, label: t('settings.folders.role_none', 'No special role') },
      ...ASSIGNABLE_ROLES
        .filter((r) => !takenByOthers.has(r))
        .map((r) => ({ value: r, label: localizeMailboxName(r, r.charAt(0).toUpperCase() + r.slice(1), t) })),
    ];
  }, [mailboxes, editor, t]);

  return (
    <View style={styles.container}>
      <SettingsSection
        title={t('settings.folders.title', 'Folders')}
        description={t(
          'settings.folders.description_mobile_reorder',
          'Create, rename, move and delete folders, or tap Reorder to change their order. Long-press a folder in the drawer for quick actions.',
        )}
      >
        <View style={styles.headerRow}>
          <Button
            variant="outline"
            size="sm"
            onPress={() => setReorderMode((on) => !on)}
            disabled={mailboxes.length === 0}
          >
            {reorderMode ? t('common.done', 'Done') : t('settings.folders.reorder_mode', 'Reorder')}
          </Button>
          <Button
            variant="default"
            size="sm"
            onPress={openCreate}
            icon={<Plus size={14} color={c.primaryForeground} />}
          >
            {t('settings.folders.new_folder', 'New folder')}
          </Button>
        </View>
        {mailboxes.length === 0 ? (
          <View style={styles.loading}>
            <ActivityIndicator size="small" color={c.primary} />
          </View>
        ) : (
          <View>
            {rows.map((mb) => {
              const custom = folderIconOf({ icons: folderIcons }, shownAccountId, mb.id);
              const Icon = custom ? folderIconComponent(custom) : getIcon(mb);
              const edge = edges.get(mb.id);
              const canMoveUp = !reordering && edge !== undefined && !edge.first;
              const canMoveDown = !reordering && edge !== undefined && !edge.last;
              return (
                <Pressable
                  key={mb.id}
                  // In reorder mode the row only holds the move buttons; as one
                  // accessible element it would hide them from screen readers.
                  accessible={!reorderMode}
                  onPress={reorderMode ? undefined : () => openEdit(mb)}
                  onLongPress={reorderMode ? undefined : () => !mb.role && confirmDelete(mb)}
                  style={({ pressed }) => [
                    styles.folderRow,
                    pressed && !reorderMode && styles.folderRowPressed,
                    { paddingLeft: spacing.md + mb.depth * 12 },
                  ]}
                >
                  <View style={styles.folderLeft}>
                    <Icon size={16} color={mb.role ? c.primary : c.mutedForeground} />
                    <Text style={styles.folderName} numberOfLines={1}>{localizeMailboxName(mb.role, mb.name, t)}</Text>
                    {mb.role && (
                      <View style={styles.rolePill}>
                        <Text style={styles.rolePillText}>{mb.role}</Text>
                      </View>
                    )}
                  </View>
                  <View style={styles.folderRight}>
                    {mb.unreadEmails > 0 && (
                      <View style={styles.unreadBadge}>
                        <Text style={styles.unreadText}>{mb.unreadEmails}</Text>
                      </View>
                    )}
                    <Text style={styles.total}>{mb.totalEmails}</Text>
                    {reorderMode ? (
                      <View style={styles.moveButtons}>
                        <Pressable
                          style={[styles.moveBtn, !canMoveUp && styles.moveBtnDisabled]}
                          onPress={() => { void moveFolder(mb.id, 'up'); }}
                          disabled={!canMoveUp}
                          hitSlop={4}
                          accessibilityRole="button"
                          accessibilityState={{ disabled: !canMoveUp }}
                          accessibilityLabel={t('settings.folders.move_folder_up', 'Move {name} up', { name: localizeMailboxName(mb.role, mb.name, t) })}
                        >
                          <ChevronUp size={16} color={c.mutedForeground} />
                        </Pressable>
                        <Pressable
                          style={[styles.moveBtn, !canMoveDown && styles.moveBtnDisabled]}
                          onPress={() => { void moveFolder(mb.id, 'down'); }}
                          disabled={!canMoveDown}
                          hitSlop={4}
                          accessibilityRole="button"
                          accessibilityState={{ disabled: !canMoveDown }}
                          accessibilityLabel={t('settings.folders.move_folder_down', 'Move {name} down', { name: localizeMailboxName(mb.role, mb.name, t) })}
                        >
                          <ChevronDown size={16} color={c.mutedForeground} />
                        </Pressable>
                      </View>
                    ) : busyId === mb.id ? (
                      <ActivityIndicator size="small" color={c.primary} />
                    ) : (
                      <Pencil size={14} color={c.textMuted} />
                    )}
                  </View>
                </Pressable>
              );
            })}
          </View>
        )}
      </SettingsSection>

      <Modal visible={!!editor} animationType="slide" transparent onRequestClose={closeEditor} onDismiss={onEditorDismissed}>
        <View style={styles.modalOverlay}>
          <View style={styles.modalSheet}>
            <View style={styles.modalHeader}>
              <Text style={styles.modalTitle}>
                {editor?.kind === 'edit'
                  ? t('settings.folders.edit_folder', `Edit "${editor.mailbox.name}"`, { name: editor.mailbox.name })
                  : t('settings.folders.new_folder', 'New folder')}
              </Text>
              <Pressable
                onPress={closeEditor}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('common.close', 'Close')}
              >
                <X size={20} color={c.text} />
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.modalBody} keyboardShouldPersistTaps="handled">
              <Text style={styles.fieldLabel}>{t('settings.folders.folder_name', 'Folder name')}</Text>
              <TextInput
                value={draftName}
                onChangeText={setDraftName}
                placeholder={t('settings.folders.name_placeholder', 'Receipts')}
                placeholderTextColor={c.textMuted}
                style={styles.input}
                editable={editor?.kind !== 'edit' || !editor.mailbox.role}
                autoFocus={editor?.kind === 'create'}
              />
              {editor?.kind === 'edit' && editor.mailbox.role ? (
                <Text style={styles.hint}>{t('settings.folders.system_folder_rename', 'System folders cannot be renamed.')}</Text>
              ) : null}

              {editor?.kind === 'create' && sharedAccounts.length > 0 && (
                <>
                  <Text style={styles.fieldLabel}>{t('settings.folders.account', 'Account')}</Text>
                  <Select
                    value={draftAccount}
                    onChange={(v) => { setDraftAccount(v); setDraftParent(NO_PARENT); }}
                    options={[
                      { value: OWN_ACCOUNT, label: t('settings.folders.own_account', 'My folders') },
                      ...sharedAccounts.map((a) => ({ value: a.id, label: a.name })),
                    ]}
                  />
                </>
              )}

              <Text style={styles.fieldLabel}>
                {editor?.kind === 'edit'
                  ? t('settings.folders.move_under', 'Move under')
                  : t('settings.folders.parent_folder', 'Parent folder')}
              </Text>
              <Select
                value={draftParent}
                onChange={setDraftParent}
                options={[
                  { value: NO_PARENT, label: t('settings.folders.top_level', 'Top level') },
                  ...parentCandidates,
                ]}
              />

              {draftAccount === OWN_ACCOUNT && (
                <>
                  <Text style={styles.fieldLabel}>{t('settings.folders.role', 'Special use')}</Text>
                  <Select value={draftRole} onChange={setDraftRole} options={roleOptions} />
                  <Text style={styles.hint}>
                    {t('settings.folders.role_hint', 'Assign a special-use role (Archive, Junk, …) to this folder. Each role can be held by one folder.')}
                  </Text>
                </>
              )}

              {draftAccount === OWN_ACCOUNT && (
                <>
                  <Text style={styles.fieldLabel}>{t('settings.folders.change_icon', 'Change icon')}</Text>
                  <View style={styles.iconGrid}>
                    <Pressable
                      onPress={() => pickIcon(null)}
                      style={[styles.iconDefault, draftIcon === null && styles.iconChoiceSelected]}
                      accessibilityRole="button"
                      accessibilityState={{ selected: draftIcon === null }}
                    >
                      <Text style={[styles.iconDefaultText, draftIcon === null && styles.iconDefaultTextSelected]}>
                        {t('settings.folders.default_icon', 'Default icon')}
                      </Text>
                    </Pressable>
                    {FOLDER_ICON_NAMES.map((name) => {
                      const Choice = folderIconComponent(name);
                      const selected = draftIcon === name;
                      return (
                        <Pressable
                          key={name}
                          onPress={() => pickIcon(name)}
                          style={[styles.iconChoice, selected && styles.iconChoiceSelected]}
                          hitSlop={2}
                          accessibilityRole="button"
                          accessibilityLabel={folderIconLabel(name)}
                          accessibilityState={{ selected }}
                        >
                          <Choice size={18} color={selected ? c.primaryForeground : c.mutedForeground} />
                        </Pressable>
                      );
                    })}
                  </View>
                </>
              )}

              {editor?.kind === 'edit' && canShare && (
                <>
                  <Pressable
                    onPress={() => openShareFromEditor({ mailbox: editor.mailbox, owner: editor.owner })}
                    disabled={draftDirty || saving}
                    style={[styles.shareRow, (draftDirty || saving) && { opacity: 0.5 }]}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: draftDirty || saving }}
                  >
                    <Share2 size={14} color={c.text} />
                    <Text style={styles.shareRowText}>{t('mailbox_context_menu.share', 'Share...')}</Text>
                  </Pressable>
                  {draftDirty ? (
                    <Text style={styles.hint}>{t('settings.folders.share_save_first', 'Save your changes to share this folder.')}</Text>
                  ) : null}
                </>
              )}

              {editor?.kind === 'edit' && !editor.mailbox.role && (
                <Pressable
                  onPress={() => {
                    closeEditor();
                    confirmDelete(editor.mailbox);
                  }}
                  style={styles.deleteRow}
                >
                  <Trash2 size={14} color={c.error} />
                  <Text style={styles.deleteRowText}>{t('mailbox_context_menu.delete_folder', 'Delete folder')}</Text>
                </Pressable>
              )}
            </ScrollView>
            <View style={styles.modalActions}>
              <Button variant="outline" size="sm" onPress={closeEditor} disabled={saving}>{t('common.cancel', 'Cancel')}</Button>
              <Button
                variant="default"
                size="sm"
                onPress={() => { void saveDraft(); }}
                loading={saving}
              >
                {t('common.save', 'Save')}
              </Button>
            </View>
          </View>
        </View>
      </Modal>
      <MailboxShareSheet
        mailbox={sharing?.mailbox ?? null}
        ownerAppAccountId={sharing?.owner ?? null}
        onClose={() => setSharing(null)}
      />
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { gap: spacing.xxxl },
    headerRow: { flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm, paddingVertical: spacing.sm },
    loading: { paddingVertical: 40, alignItems: 'center' },
    folderRow: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingVertical: spacing.sm, paddingHorizontal: spacing.md,
      borderRadius: radius.sm,
    },
    folderRowPressed: { backgroundColor: c.muted },
    folderLeft: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 },
    folderName: { ...typography.body, color: c.text, flexShrink: 1 },
    rolePill: {
      paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.full,
      backgroundColor: c.primaryBg,
    },
    rolePillText: { fontSize: 10, fontWeight: '500', color: c.primary },
    folderRight: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
    unreadBadge: {
      paddingHorizontal: 6, paddingVertical: 2, borderRadius: radius.full,
      backgroundColor: c.primary,
    },
    unreadText: { fontSize: 10, fontWeight: '500', color: c.primaryForeground },
    total: { ...typography.caption, color: c.mutedForeground, minWidth: 32, textAlign: 'right' },
    moveButtons: { flexDirection: 'row', gap: 2 },
    moveBtn: { padding: spacing.xs, borderRadius: radius.sm },
    moveBtnDisabled: { opacity: 0.3 },

    modalOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' },
    modalSheet: {
      backgroundColor: c.background,
      borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg,
      maxHeight: '85%',
    },
    modalHeader: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
      borderBottomWidth: 1, borderBottomColor: c.border,
    },
    modalTitle: { ...typography.h3, color: c.text, flexShrink: 1 },
    modalBody: { padding: spacing.lg, gap: spacing.md },
    fieldLabel: { ...typography.captionMedium, color: c.textSecondary },
    hint: { ...typography.caption, color: c.textMuted },
    input: {
      ...typography.body, color: c.text,
      backgroundColor: c.surface,
      borderWidth: 1, borderColor: c.border, borderRadius: radius.sm,
      paddingHorizontal: spacing.md, paddingVertical: 10,
    },
    iconGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
    iconChoice: {
      width: 40, height: 40, borderRadius: radius.sm,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: c.surface,
    },
    iconChoiceSelected: { backgroundColor: c.primary },
    iconDefault: {
      height: 40, paddingHorizontal: spacing.md, borderRadius: radius.sm,
      alignItems: 'center', justifyContent: 'center',
      backgroundColor: c.surface,
    },
    iconDefaultText: { ...typography.caption, color: c.text },
    iconDefaultTextSelected: { color: c.primaryForeground },
    deleteRow: {
      flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
      paddingVertical: spacing.md,
    },
    deleteRowText: { ...typography.body, color: c.error },
    shareRow: {
      flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
      paddingVertical: spacing.md,
    },
    shareRowText: { ...typography.body, color: c.text },
    modalActions: {
      flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm,
      padding: spacing.lg, borderTopWidth: 1, borderTopColor: c.border,
    },
  });
}
