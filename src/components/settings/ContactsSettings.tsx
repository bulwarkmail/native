import React from 'react';
import { Alert, Share, Text, View, StyleSheet, Pressable, TextInput } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import {
  Download, Upload, Plus, Pencil, Trash2, Check, X, BookUser, Star,
} from 'lucide-react-native';
import { SettingsSection, SettingItem, ToggleSwitch } from './settings-section';
import Button from '../Button';
import Dialog from '../Dialog';
import { ContactImportSheet, AddressBookPickerSheet } from '../contacts';
import { useSettingsStore } from '../../stores/settings-store';
import { useLocaleStore } from '../../stores/locale-store';
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
  const sortByLastName = useSettingsStore((s) => s.sortContactsByLastName);
  const updateSetting = useSettingsStore((s) => s.updateSetting);
  const t = useLocaleStore((s) => s.t);
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
  const setDefaultAddressBook = useContactsStore((s) => s.setDefaultAddressBook);
  const getDefaultAddressBookId = useContactsStore((s) => s.getDefaultAddressBookId);

  const [exporting, setExporting] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [importTargetOpen, setImportTargetOpen] = React.useState(false);
  const [importTargetBookId, setImportTargetBookId] = React.useState<string | null>(null);

  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editName, setEditName] = React.useState('');
  const [adding, setAdding] = React.useState(false);
  const [newName, setNewName] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<{ id: string; name: string; count: number } | null>(null);

  const exportable = React.useMemo(() => contacts.filter((cc) => !isGroup(cc)), [contacts]);
  const exportLabel =
    exportable.length === 0
      ? t('settings.contacts.export_empty', 'No contacts to export')
      : t(
        'settings.contacts.export_description_count',
        '{count, plural, one {Export # contact as a single vCard file.} other {Export # contacts as a single vCard file.}}',
        { count: exportable.length },
      );
  // Imports land in the account's default book unless the user picks another.
  const resolvedImportTarget = importTargetBookId ?? getDefaultAddressBookId();
  const importTargetName = books.find((b) => b.id === resolvedImportTarget)?.name;

  const handleSetDefault = async (id: string) => {
    if (busy) return;
    setBusy(true);
    try {
      await setDefaultAddressBook(id);
    } catch (err) {
      Alert.alert(t('contacts.address_books.set_default_failed', 'Failed to set default address book'), err instanceof Error ? err.message : t('identities.validation_errors.unknown_error', 'Unknown error'));
    } finally {
      setBusy(false);
    }
  };

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
          dialogTitle: t('contacts.export.title', 'Export Contacts'),
        });
      } else {
        await Share.share({ message: vcf });
      }
    } catch (err) {
      Alert.alert(t('contacts.export.failed', 'Export failed'), err instanceof Error ? err.message : t('identities.validation_errors.unknown_error', 'Unknown error'));
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
      Alert.alert(t('contacts.address_books.rename_failed', 'Failed to rename address book'), err instanceof Error ? err.message : t('identities.validation_errors.unknown_error', 'Unknown error'));
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
      Alert.alert(t('contacts.address_books.create_failed', 'Failed to create address book'), err instanceof Error ? err.message : t('identities.validation_errors.unknown_error', 'Unknown error'));
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
      Alert.alert(t('contacts.address_books.delete_failed', 'Failed to delete address book'), err instanceof Error ? err.message : t('identities.validation_errors.unknown_error', 'Unknown error'));
    }
  };

  return (
    <>
      <SettingsSection
        title={t('settings.contacts.title', 'Contacts')}
        description={t('settings.contacts.description_mobile', 'Display preferences and address-book tools.')}
      >
        <SettingItem
          label={t('settings.contacts.group_by_letter_label', 'Group by first letter')}
          description={t('settings.contacts.group_by_letter_description', 'Show alphabetical section headers in the contact list')}
        >
          <ToggleSwitch checked={groupByLetter} onChange={setGroupByLetter} />
        </SettingItem>

        <SettingItem
          label={t('settings.contacts.sort_by_last_name_label', 'Sort by last name')}
          description={t(
            'settings.contacts.sort_by_last_name_description',
            'Order the contact list by surname so family members appear together',
          )}
        >
          <ToggleSwitch
            checked={sortByLastName}
            onChange={(checked) => updateSetting('sortContactsByLastName', checked)}
          />
        </SettingItem>

        <SettingItem
          label={t('settings.contacts.import_label', 'Import Contacts')}
          description={t('settings.contacts.import_description_mobile', 'Import contacts from a vCard (.vcf) file with duplicate detection.')}
        >
          <Button
            variant="outline"
            size="sm"
            icon={<Upload size={14} color={c.text} />}
            onPress={() => setImportOpen(true)}
            disabled={books.length === 0}
          >
            {t('contacts.import.import_button', 'Import')}
          </Button>
        </SettingItem>

        <SettingItem
          label={t('settings.contacts.export_label', 'Export Contacts')}
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
            {t('contacts.bulk.export', 'Export')}
          </Button>
        </SettingItem>
      </SettingsSection>

      <SettingsSection
        title={t('settings.contacts.manage_title', 'Address Books')}
        description={t('settings.contacts.manage_description_mobile', 'Create, rename, and remove the address books that organize your contacts.')}
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
                <Pressable
                  onPress={() => { void commitRename(); }}
                  hitSlop={6}
                  style={styles.iconBtn}
                  accessibilityRole="button"
                  accessibilityLabel={t('common.save', 'Save')}
                >
                  <Check size={16} color={c.primary} />
                </Pressable>
                <Pressable
                  onPress={() => setEditingId(null)}
                  hitSlop={6}
                  style={styles.iconBtn}
                  accessibilityRole="button"
                  accessibilityLabel={t('common.cancel', 'Cancel')}
                >
                  <X size={16} color={c.textMuted} />
                </Pressable>
              </>
            ) : (
              <>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.bookName} numberOfLines={1}>
                    {book.isShared && book.accountName ? `${book.name} (${book.accountName})` : book.name}
                  </Text>
                  <Text style={styles.bookCount}>
                    {t('settings.contacts.book_count', '{count, plural, one {# contact} other {# contacts}}', { count: book.count })}
                    {book.isDefault ? ` · ${t('contacts.address_books.default', 'Default')}` : ''}
                  </Text>
                </View>
                {!book.isShared && (
                  <Pressable
                    onPress={() => { if (!book.isDefault) void handleSetDefault(book.id); }}
                    hitSlop={6}
                    style={styles.iconBtn}
                    disabled={!!book.isDefault}
                    accessibilityRole="button"
                    accessibilityLabel={book.isDefault
                      ? t('settings.contacts.default_book', 'Default address book')
                      : t('contacts.address_books.set_default', 'Set as default')}
                  >
                    <Star
                      size={15}
                      color={book.isDefault ? c.primary : c.textSecondary}
                      fill={book.isDefault ? c.primary : 'transparent'}
                    />
                  </Pressable>
                )}
                {book.myRights?.mayWrite !== false && (
                  <Pressable
                    onPress={() => startRename(book.id, book.name)}
                    hitSlop={6}
                    style={styles.iconBtn}
                    accessibilityRole="button"
                    accessibilityLabel={t('contacts.address_books.rename', 'Rename address book')}
                  >
                    <Pencil size={15} color={c.textSecondary} />
                  </Pressable>
                )}
                {/* The default book and shared books cannot be deleted (the server rejects it). */}
                {book.myRights?.mayDelete !== false && !book.isDefault && !book.isShared && books.length > 1 && (
                  <Pressable
                    onPress={() => setDeleteTarget({ id: book.id, name: book.name, count: book.count })}
                    hitSlop={6}
                    style={styles.iconBtn}
                    accessibilityRole="button"
                    accessibilityLabel={t('contacts.address_books.delete', 'Delete address book')}
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
              placeholder={t('contacts.address_books.name_label', 'Address book name')}
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
              accessibilityRole="button"
              accessibilityLabel={t('contacts.address_books.create', 'New address book')}
            >
              <Check size={16} color={c.primary} />
            </Pressable>
            <Pressable
              onPress={() => { setAdding(false); setNewName(''); }}
              hitSlop={6}
              style={styles.iconBtn}
              accessibilityRole="button"
              accessibilityLabel={t('common.cancel', 'Cancel')}
            >
              <X size={16} color={c.textMuted} />
            </Pressable>
          </View>
        ) : (
          <Pressable
            style={styles.addRow}
            onPress={() => { setEditingId(null); setAdding(true); }}
            accessibilityRole="button"
          >
            <Plus size={16} color={c.primary} />
            <Text style={styles.addLabel}>{t('contacts.address_books.create', 'New address book')}</Text>
          </Pressable>
        )}

        <View style={{ marginTop: spacing.sm }}>
          <Button
            variant="ghost"
            size="sm"
            onPress={() => { void fetchAddressBooks(); void fetchContacts(); }}
          >
            {t('common.refresh', 'Refresh')}
          </Button>
        </View>
      </SettingsSection>

      <ContactImportSheet
        visible={importOpen}
        onClose={() => setImportOpen(false)}
        targetBookId={resolvedImportTarget}
        targetBookName={importTargetName}
        onChangeTarget={books.length > 1 ? () => setImportTargetOpen(true) : undefined}
        onImported={() => { void fetchContacts(); }}
      />

      <AddressBookPickerSheet
        visible={importTargetOpen}
        onClose={() => setImportTargetOpen(false)}
        currentBookId={resolvedImportTarget}
        title={t('contacts.import.into_address_book', 'Import into address book')}
        onPick={(id) => { setImportTargetBookId(id); setImportTargetOpen(false); }}
      />

      <Dialog
        visible={deleteTarget !== null}
        title={t('contacts.address_books.delete', 'Delete address book')}
        message={
          deleteTarget
            ? t(
              'contacts.address_books.confirm_delete_count',
              '{count, plural, =0 {Delete "{name}"? This cannot be undone.} one {Delete "{name}"? Its # contact will be deleted with it. This cannot be undone.} other {Delete "{name}"? Its # contacts will be deleted with it. This cannot be undone.}}',
              { name: deleteTarget.name, count: deleteTarget.count },
            )
            : ''
        }
        variant="destructive"
        confirmText={t('common.delete', 'Delete')}
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
