import React from 'react';
import { Alert, Share, Text, View, StyleSheet, Pressable, TextInput } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import {
  Download, Upload, Plus, Pencil, Trash2, Check, X, BookUser,
} from 'lucide-react-native';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import Button from '../Button';
import Dialog from '../Dialog';
import { ContactImportSheet } from '../contacts';
import { useSettingsStore } from '../../stores/settings-store';
import { useContactsStore, selectAddressBooksWithCount } from '../../stores/contacts-store';
import { contactsToVCard } from '../../lib/vcard';
import { isGroup } from '../../lib/contact-utils';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';

export function ContactsSettings() {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const groupByLetter = useSettingsStore((s) => s.groupContactsByLetter);
  const setGroupByLetter = useSettingsStore((s) => s.setGroupContactsByLetter);
  const contacts = useContactsStore((s) => s.contacts);
  const addressBooks = useContactsStore((s) => s.addressBooks);
  // Derive in a memo from stable store fields. Subscribing with
  // `selectAddressBooksWithCount` directly returns a new array each call and
  // sends useSyncExternalStore into an infinite render loop.
  const books = React.useMemo(
    () => selectAddressBooksWithCount(addressBooks, contacts),
    [addressBooks, contacts],
  );
  const fetchAddressBooks = useContactsStore((s) => s.fetchAddressBooks);
  const fetchContacts = useContactsStore((s) => s.fetchContacts);
  const createAddressBook = useContactsStore((s) => s.createAddressBook);
  const renameAddressBook = useContactsStore((s) => s.renameAddressBook);
  const deleteAddressBook = useContactsStore((s) => s.deleteAddressBook);

  const [exporting, setExporting] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);

  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editName, setEditName] = React.useState('');
  const [adding, setAdding] = React.useState(false);
  const [newName, setNewName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<{ id: string; name: string; count: number } | null>(null);

  const exportable = React.useMemo(() => contacts.filter((cc) => !isGroup(cc)), [contacts]);
  const exportLabel =
    exportable.length === 0
      ? 'No contacts to export'
      : `Export ${exportable.length} contact${exportable.length === 1 ? '' : 's'} as a single vCard file.`;
  const importTargetBookId = books[0]?.id ?? null;

  const handleExport = async () => {
    if (exportable.length === 0 || exporting) return;
    setExporting(true);
    try {
      const vcf = contactsToVCard(exportable);
      const filename = `contacts-${new Date().toISOString().slice(0, 10)}.vcf`;
      const path = `${FileSystem.cacheDirectory}${filename}`;
      await FileSystem.writeAsStringAsync(path, vcf);
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(path, {
          mimeType: 'text/vcard',
          UTI: 'public.vcard',
          dialogTitle: 'Export contacts',
        });
      } else {
        await Share.share({ message: vcf });
      }
    } catch (err) {
      Alert.alert('Export failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setExporting(false);
    }
  };

  const startRename = (id: string, name: string) => {
    setAdding(false);
    setEditingId(id);
    setEditName(name);
  };

  const commitRename = async () => {
    const name = editName.trim();
    if (!editingId || !name || busy) { setEditingId(null); return; }
    setBusy(true);
    try {
      await renameAddressBook(editingId, name);
      setEditingId(null);
    } catch (err) {
      Alert.alert('Rename failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  const commitCreate = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await createAddressBook(name);
      setAdding(false);
      setNewName('');
    } catch (err) {
      Alert.alert('Could not create address book', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    const { id } = deleteTarget;
    setDeleteTarget(null);
    try {
      await deleteAddressBook(id);
    } catch (err) {
      Alert.alert('Delete failed', err instanceof Error ? err.message : 'Unknown error');
    }
  };

  return (
    <>
      <SettingsSection
        title="Contacts"
        description="Display preferences and address-book tools."
      >
        <SettingItem
          label="Group by first letter"
          description="Show alphabetical section headers in the contacts list."
        >
          <ToggleSwitch checked={groupByLetter} onChange={setGroupByLetter} />
        </SettingItem>

        <SettingItem
          label="Import contacts"
          description="Import contacts from a vCard (.vcf) file with duplicate detection."
        >
          <Button
            variant="outline"
            size="sm"
            icon={<Upload size={14} color={c.text} />}
            onPress={() => setImportOpen(true)}
            disabled={books.length === 0}
          >
            Import
          </Button>
        </SettingItem>

        <SettingItem
          label="Export contacts"
          description={exportLabel}
        >
          <Button
            variant="outline"
            size="sm"
            icon={<Download size={14} color={c.text} />}
            onPress={() => { void handleExport(); }}
            disabled={exportable.length === 0 || exporting}
            loading={exporting}
          >
            Export
          </Button>
        </SettingItem>
      </SettingsSection>

      <SettingsSection
        title="Address books"
        description="Create, rename, and remove the address books that organize your contacts."
      >
        {books.map((book) => (
          <View key={book.id} style={styles.bookRow}>
            <BookUser size={16} color={c.textSecondary} />
            {editingId === book.id ? (
              <>
                <TextInput
                  style={styles.bookInput}
                  value={editName}
                  onChangeText={setEditName}
                  autoFocus
                  returnKeyType="done"
                  onSubmitEditing={() => { void commitRename(); }}
                  placeholderTextColor={c.textMuted}
                />
                <Pressable onPress={() => { void commitRename(); }} hitSlop={6} style={styles.iconBtn}>
                  <Check size={16} color={c.primary} />
                </Pressable>
                <Pressable onPress={() => setEditingId(null)} hitSlop={6} style={styles.iconBtn}>
                  <X size={16} color={c.textMuted} />
                </Pressable>
              </>
            ) : (
              <>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.bookName} numberOfLines={1}>{book.name}</Text>
                  <Text style={styles.bookCount}>
                    {book.count} contact{book.count === 1 ? '' : 's'}
                  </Text>
                </View>
                {book.myRights?.mayWrite !== false && (
                  <Pressable onPress={() => startRename(book.id, book.name)} hitSlop={6} style={styles.iconBtn}>
                    <Pencil size={15} color={c.textSecondary} />
                  </Pressable>
                )}
                {book.myRights?.mayDelete !== false && books.length > 1 && (
                  <Pressable
                    onPress={() => setDeleteTarget({ id: book.id, name: book.name, count: book.count })}
                    hitSlop={6}
                    style={styles.iconBtn}
                  >
                    <Trash2 size={15} color={c.error} />
                  </Pressable>
                )}
              </>
            )}
          </View>
        ))}

        {adding ? (
          <View style={styles.bookRow}>
            <BookUser size={16} color={c.textSecondary} />
            <TextInput
              style={styles.bookInput}
              value={newName}
              onChangeText={setNewName}
              placeholder="New address book name"
              placeholderTextColor={c.textMuted}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={() => { void commitCreate(); }}
            />
            <Pressable
              onPress={() => { void commitCreate(); }}
              disabled={!newName.trim() || busy}
              hitSlop={6}
              style={styles.iconBtn}
            >
              <Check size={16} color={c.primary} />
            </Pressable>
            <Pressable onPress={() => { setAdding(false); setNewName(''); }} hitSlop={6} style={styles.iconBtn}>
              <X size={16} color={c.textMuted} />
            </Pressable>
          </View>
        ) : (
          <Pressable
            style={styles.addRow}
            onPress={() => { setEditingId(null); setAdding(true); }}
          >
            <Plus size={16} color={c.primary} />
            <Text style={styles.addLabel}>New address book</Text>
          </Pressable>
        )}

        <View style={{ marginTop: spacing.sm }}>
          <Button
            variant="ghost"
            size="sm"
            onPress={() => { void fetchAddressBooks(); void fetchContacts(); }}
          >
            Refresh
          </Button>
        </View>
      </SettingsSection>

      <ContactImportSheet
        visible={importOpen}
        onClose={() => setImportOpen(false)}
        targetBookId={importTargetBookId}
        targetBookName={books[0]?.name}
        onImported={() => { void fetchContacts(); }}
      />

      <Dialog
        visible={deleteTarget !== null}
        title="Delete address book"
        message={
          deleteTarget
            ? `Delete "${deleteTarget.name}"?${deleteTarget.count > 0 ? ` Its ${deleteTarget.count} contact${deleteTarget.count === 1 ? '' : 's'} will be removed from this book.` : ''} This cannot be undone.`
            : ''
        }
        variant="destructive"
        confirmText="Delete"
        onConfirm={() => { void confirmDelete(); }}
        onCancel={() => setDeleteTarget(null)}
      />
    </>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    bookRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
    },
    bookName: { ...typography.body, color: c.text },
    bookCount: { ...typography.caption, color: c.textMuted, marginTop: 1 },
    bookInput: {
      flex: 1,
      ...typography.body,
      color: c.text,
      height: componentSizes.inputHeight,
      paddingHorizontal: spacing.md,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      backgroundColor: c.background,
    },
    iconBtn: {
      width: 32,
      height: 32,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm,
    },
    addRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.md,
    },
    addLabel: { ...typography.body, color: c.primary },
  });
}
