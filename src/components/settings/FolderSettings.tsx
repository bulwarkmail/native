import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  Folder, Inbox, Send, FileText, Trash, ShieldAlert, Archive, Flag, Star, Mails,
  StickyNote, Clock, AlarmClock, Users, Plus, Pencil, Trash2, X,
} from 'lucide-react-native';
import { SettingsSection, Select } from './settings-section';
import Button from '../Button';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { ownMailboxes, mailboxSubtreeIds } from '../../lib/mailbox-tree';
import { localizeMailboxName } from '../../lib/mailbox-label';
import { useEmailStore } from '../../stores/email-store';
import { useLocaleStore } from '../../stores/locale-store';
import { createMailbox, updateMailbox, deleteMailbox } from '../../api/email';
import { jmapClient } from '../../api/jmap-client';
import type { Mailbox } from '../../api/types';

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

type Editor =
  | { kind: 'create' }
  | { kind: 'edit'; mailbox: Mailbox };

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

  const [editor, setEditor] = useState<Editor | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftParent, setDraftParent] = useState<string>(NO_PARENT);
  const [draftAccount, setDraftAccount] = useState<string>(OWN_ACCOUNT);
  const [draftRole, setDraftRole] = useState<string>(NO_ROLE);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (mailboxes.length === 0) void fetchMailboxes();
  }, [mailboxes.length, fetchMailboxes]);

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

  const sorted = [...mailboxes].sort((a, b) => {
    const ar = a.role ? 0 : 1;
    const br = b.role ? 0 : 1;
    if (ar !== br) return ar - br;
    return pathOf(mailboxes, a, t).localeCompare(pathOf(mailboxes, b, t));
  });

  const totalUnread = mailboxes.reduce((sum, m) => sum + (m.unreadEmails ?? 0), 0);

  const openCreate = () => {
    setEditor({ kind: 'create' });
    setDraftName('');
    setDraftParent(NO_PARENT);
    setDraftAccount(OWN_ACCOUNT);
    setDraftRole(NO_ROLE);
  };

  const openEdit = (mailbox: Mailbox) => {
    setEditor({ kind: 'edit', mailbox });
    setDraftName(mailbox.name);
    setDraftParent(mailbox.parentId ?? NO_PARENT);
    setDraftAccount(OWN_ACCOUNT);
    setDraftRole(mailbox.role ?? NO_ROLE);
  };

  const closeEditor = () => setEditor(null);

  const saveDraft = async () => {
    const name = draftName.trim();
    if (!name) {
      Alert.alert(t('settings.folders.name_required', 'Name required'));
      return;
    }
    setSaving(true);
    try {
      if (editor?.kind === 'create') {
        const accountId = draftAccount === OWN_ACCOUNT ? undefined : draftAccount;
        const parentId = draftParent === NO_PARENT ? null : draftParent;
        const raw = parentId
          ? allMailboxes.find((m) => m.id === parentId)?.originalId ?? parentId
          : null;
        await createMailbox(
          { name, parentId: raw, ...(draftRole !== NO_ROLE ? { role: draftRole } : {}) },
          accountId,
        );
      } else if (editor?.kind === 'edit') {
        const mb = editor.mailbox;
        const changes: { name?: string; parentId?: string | null; role?: string | null } = {};
        if (name !== mb.name && !mb.role) changes.name = name;
        const nextParent = draftParent === NO_PARENT ? null : draftParent;
        if ((mb.parentId ?? null) !== nextParent) changes.parentId = nextParent;
        const nextRole = draftRole === NO_ROLE ? null : draftRole;
        if ((mb.role ?? null) !== nextRole) changes.role = nextRole;
        if (Object.keys(changes).length > 0) await updateMailbox(mb.id, changes);
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
          { text: t('common.delete', 'Delete'), style: 'destructive', onPress: () => { void performDelete(mailbox, true); } },
        ],
      );
      return;
    }
    Alert.alert(
      t('mailbox_context_menu.delete_confirm_title', 'Delete folder'),
      t('mailbox_context_menu.delete_confirm_message', `Permanently delete the folder "${name}"? This action cannot be undone.`, { name }),
      [
        { text: t('common.cancel', 'Cancel'), style: 'cancel' },
        { text: t('common.delete', 'Delete'), style: 'destructive', onPress: () => { void performDelete(mailbox, false); } },
      ],
    );
  };

  const performDelete = async (mailbox: Mailbox, removeEmails: boolean) => {
    setBusyId(mailbox.id);
    try {
      await deleteMailbox(mailbox.id, undefined, { onDestroyRemoveEmails: removeEmails });
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
          'settings.folders.description_mobile',
          `${mailboxes.length} folders, ${totalUnread} unread. Tap a folder to edit, long-press to delete.`,
          { count: mailboxes.length, unread: totalUnread },
        )}
      >
        <View style={styles.headerRow}>
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
            {sorted.map((mb) => {
              const Icon = getIcon(mb);
              const depth = pathOf(mailboxes, mb, t).split(' / ').length - 1;
              return (
                <Pressable
                  key={mb.id}
                  onPress={() => openEdit(mb)}
                  onLongPress={() => !mb.role && confirmDelete(mb)}
                  style={({ pressed }) => [
                    styles.folderRow,
                    pressed && styles.folderRowPressed,
                    { paddingLeft: spacing.md + depth * 12 },
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
                    {busyId === mb.id ? (
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

      <Modal visible={!!editor} animationType="slide" transparent onRequestClose={closeEditor}>
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
                  : t('settings.folders.subfolder_of', 'Parent folder')}
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
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { gap: spacing.xxxl },
    headerRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingVertical: spacing.sm },
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
    deleteRow: {
      flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
      paddingVertical: spacing.md,
    },
    deleteRowText: { ...typography.body, color: c.error },
    modalActions: {
      flexDirection: 'row', justifyContent: 'flex-end', gap: spacing.sm,
      padding: spacing.lg, borderTopWidth: 1, borderTopColor: c.border,
    },
  });
}
