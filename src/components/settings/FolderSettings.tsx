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
  Folder, Inbox, Send, FileText, Trash, ShieldAlert, Archive,
  Plus, Pencil, Trash2, X,
} from 'lucide-react-native';
import { SettingsSection } from './settings-section';
import Button from '../Button';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useEmailStore } from '../../stores/email-store';
import { createMailbox, updateMailbox, deleteMailbox } from '../../api/email';
import type { Mailbox } from '../../api/types';

const ROLE_LABEL: Record<string, string> = {
  inbox: 'Inbox', drafts: 'Drafts', sent: 'Sent', trash: 'Trash',
  junk: 'Junk', archive: 'Archive', important: 'Important', all: 'All',
};
const ROLE_ICON: Record<string, any> = {
  inbox: Inbox, drafts: FileText, sent: Send, trash: Trash,
  junk: ShieldAlert, archive: Archive,
};

function getIcon(mb: Mailbox) {
  if (mb.role && ROLE_ICON[mb.role]) return ROLE_ICON[mb.role];
  return Folder;
}

type Editor =
  | { kind: 'create' }
  | { kind: 'rename'; mailbox: Mailbox };

export function FolderSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const mailboxes = useEmailStore((s) => s.mailboxes);
  const fetchMailboxes = useEmailStore((s) => s.fetchMailboxes);

  const [editor, setEditor] = useState<Editor | null>(null);
  const [draftName, setDraftName] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (mailboxes.length === 0) void fetchMailboxes();
  }, [mailboxes.length, fetchMailboxes]);

  const sorted = [...mailboxes].sort((a, b) => {
    const ar = a.role ? 0 : 1;
    const br = b.role ? 0 : 1;
    if (ar !== br) return ar - br;
    return a.name.localeCompare(b.name);
  });

  const totalUnread = mailboxes.reduce((sum, m) => sum + (m.unreadEmails ?? 0), 0);

  const openCreate = () => {
    setEditor({ kind: 'create' });
    setDraftName('');
  };

  const openRename = (mailbox: Mailbox) => {
    if (mailbox.role) {
      Alert.alert('Cannot rename', 'System folders cannot be renamed.');
      return;
    }
    setEditor({ kind: 'rename', mailbox });
    setDraftName(mailbox.name);
  };

  const closeEditor = () => setEditor(null);

  const saveDraft = async () => {
    const name = draftName.trim();
    if (!name) {
      Alert.alert('Name required');
      return;
    }
    setSaving(true);
    try {
      if (editor?.kind === 'create') {
        await createMailbox({ name });
      } else if (editor?.kind === 'rename') {
        await updateMailbox(editor.mailbox.id, { name });
      }
      closeEditor();
      await fetchMailboxes();
    } catch (err) {
      Alert.alert('Save failed', err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const confirmDelete = (mailbox: Mailbox) => {
    if (mailbox.role) {
      Alert.alert('Cannot delete', 'System folders cannot be removed.');
      return;
    }
    if ((mailbox.totalEmails ?? 0) > 0) {
      Alert.alert(
        'Folder not empty',
        `"${mailbox.name}" contains ${mailbox.totalEmails} email${mailbox.totalEmails === 1 ? '' : 's'}. Delete anyway?`,
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: () => { void performDelete(mailbox); } },
        ],
      );
      return;
    }
    Alert.alert(
      'Delete folder',
      `Permanently delete "${mailbox.name}"?`,
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Delete', style: 'destructive', onPress: () => { void performDelete(mailbox); } },
      ],
    );
  };

  const performDelete = async (mailbox: Mailbox) => {
    setBusyId(mailbox.id);
    try {
      await deleteMailbox(mailbox.id);
      await fetchMailboxes();
    } catch (err) {
      Alert.alert('Delete failed', err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <View style={styles.container}>
      <SettingsSection
        title="Folders"
        description={`${mailboxes.length} folder${mailboxes.length === 1 ? '' : 's'}, ${totalUnread} unread. Tap a folder to rename, long-press to delete.`}
      >
        <View style={styles.headerRow}>
          <Button
            variant="default"
            size="sm"
            onPress={openCreate}
            icon={<Plus size={14} color={c.primaryForeground} />}
          >
            New folder
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
              const editable = !mb.role;
              return (
                <Pressable
                  key={mb.id}
                  onPress={() => editable && openRename(mb)}
                  onLongPress={() => editable && confirmDelete(mb)}
                  disabled={!editable && busyId !== mb.id}
                  style={({ pressed }) => [
                    styles.folderRow,
                    editable && pressed && styles.folderRowPressed,
                  ]}
                >
                  <View style={styles.folderLeft}>
                    <Icon size={16} color={mb.role ? c.primary : c.mutedForeground} />
                    <Text style={styles.folderName} numberOfLines={1}>{mb.name}</Text>
                    {mb.role && ROLE_LABEL[mb.role] && (
                      <View style={styles.rolePill}>
                        <Text style={styles.rolePillText}>{ROLE_LABEL[mb.role]}</Text>
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
                    {editable && (
                      busyId === mb.id ? (
                        <ActivityIndicator size="small" color={c.primary} />
                      ) : (
                        <Pencil size={14} color={c.textMuted} />
                      )
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
                {editor?.kind === 'rename' ? `Rename "${editor.mailbox.name}"` : 'New folder'}
              </Text>
              <Pressable onPress={closeEditor} hitSlop={8}>
                <X size={20} color={c.text} />
              </Pressable>
            </View>
            <ScrollView contentContainerStyle={styles.modalBody}>
              <Text style={styles.fieldLabel}>Folder name</Text>
              <TextInput
                value={draftName}
                onChangeText={setDraftName}
                placeholder="Receipts"
                placeholderTextColor={c.textMuted}
                style={styles.input}
                autoFocus
              />
              {editor?.kind === 'rename' && (
                <Pressable
                  onPress={() => {
                    closeEditor();
                    confirmDelete(editor.mailbox);
                  }}
                  style={styles.deleteRow}
                >
                  <Trash2 size={14} color={c.error} />
                  <Text style={styles.deleteRowText}>Delete folder</Text>
                </Pressable>
              )}
            </ScrollView>
            <View style={styles.modalActions}>
              <Button variant="outline" size="sm" onPress={closeEditor} disabled={saving}>Cancel</Button>
              <Button
                variant="default"
                size="sm"
                onPress={() => { void saveDraft(); }}
                loading={saving}
              >
                Save
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
      maxHeight: '80%',
    },
    modalHeader: {
      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
      paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
      borderBottomWidth: 1, borderBottomColor: c.border,
    },
    modalTitle: { ...typography.h3, color: c.text, flexShrink: 1 },
    modalBody: { padding: spacing.lg, gap: spacing.md },
    fieldLabel: { ...typography.captionMedium, color: c.textSecondary },
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
