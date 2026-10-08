import React from 'react';
import { Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { BookUser, Check, Pencil, X } from 'lucide-react-native';
import { SettingsSection } from './settings-section';
import { useContactsStore, selectAddressBooksWithCount } from '../../stores/contacts-store';
import { useEmailStore } from '../../stores/email-store';
import { useLocaleStore } from '../../stores/locale-store';
import { scopedBooks, scopedBookActions, renameScopedBook } from '../../lib/managed-scope';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';

interface ScopedAddressBooksPaneProps {
  /** JMAP id of the shared/group account Settings manages. */
  managedAccountId: string;
}

/**
 * The Contacts pane of Settings scoped to a shared/group account (webmail:
 * AddressBookManagementSettings in scoped mode): that account's address
 * books, to rename where the rights allow it. The user's own preferences,
 * import, export, creating, sharing and deleting are not offered here.
 */
export function ScopedAddressBooksPane({ managedAccountId }: ScopedAddressBooksPaneProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const contacts = useContactsStore((s) => s.contacts);
  const addressBooks = useContactsStore((s) => s.addressBooks);
  const fetchAddressBooks = useContactsStore((s) => s.fetchAddressBooks);
  // The app account the pane opened in: every rename is for it, and refused once another is shown.
  const [appAccountId] = React.useState(() => useEmailStore.getState().activeAccountId);
  const books = React.useMemo(
    () => scopedBooks(selectAddressBooksWithCount(addressBooks, contacts), managedAccountId),
    [addressBooks, contacts, managedAccountId],
  );

  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editName, setEditName] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (useContactsStore.getState().addressBooks.length === 0) void fetchAddressBooks();
  }, [fetchAddressBooks]);

  const commitRename = async () => {
    const name = editName.trim();
    if (!editingId || !name || busy) { setEditingId(null); return; }
    setBusy(true);
    try {
      await renameScopedBook({ appAccountId, managedAccountId }, editingId, name);
      setEditingId(null);
    } catch (err) {
      Alert.alert(
        t('contacts.address_books.rename_failed', 'Failed to rename address book'),
        err instanceof Error ? err.message : t('identities.validation_errors.unknown_error', 'Unknown error'),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection
      title={t('settings.contacts.manage_title', 'Address Books')}
      description={t('settings.scoped.address_books_description', 'Rename the address books of this account.')}
    >
      {books.length === 0 ? (
        <Text style={styles.empty}>{t('settings.contacts.no_address_books', 'No address books found')}</Text>
      ) : books.map((book) => (
        <View key={book.id} style={styles.row}>
          <BookUser size={16} color={c.textSecondary} />
          {editingId === book.id ? (
            <>
              <TextInput
                style={styles.input}
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
                <Text style={styles.name} numberOfLines={1}>{book.name}</Text>
                <Text style={styles.count}>
                  {t('settings.contacts.book_count', '{count, plural, one {# contact} other {# contacts}}', { count: book.count })}
                </Text>
              </View>
              {scopedBookActions(book).rename && (
                <Pressable
                  onPress={() => { setEditingId(book.id); setEditName(book.name); }}
                  hitSlop={6}
                  style={styles.iconBtn}
                  accessibilityRole="button"
                  accessibilityLabel={t('contacts.address_books.rename', 'Rename address book')}
                >
                  <Pencil size={15} color={c.textSecondary} />
                </Pressable>
              )}
            </>
          )}
        </View>
      ))}
    </SettingsSection>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.borderLight,
    },
    name: { ...typography.body, color: c.text },
    count: { ...typography.caption, color: c.textMuted, marginTop: 1 },
    empty: { ...typography.body, color: c.textMuted, paddingVertical: spacing.sm },
    input: {
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
  });
}
