import React from 'react';
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Check, Search, Users, X } from '../icons';
import SenderAvatar from '../SenderAvatar';
import { useColors } from '../../theme/colors';
import { componentSizes, radius, spacing, typography, type ThemePalette } from '../../theme/tokens';
import { useLocaleStore } from '../../stores/locale-store';
import { useContactsStore } from '../../stores/contacts-store';
import { MODAL_ORIENTATIONS } from '../../lib/modal-orientations';
import { useSheetBottomInset } from '../../lib/sheet-bottom-inset';
import { filterDirectory, type DirectoryEntry } from '../../lib/contact-directory';
import { contactEntries, pickedEntries, pickerKey } from '../../lib/compose-recipient-picker';

export type PickerField = 'to' | 'cc' | 'bcc';
type PickerTab = 'contacts' | 'directory';

/**
 * Tick recipients from the contacts, and from the directory on a tab of its
 * own where the server has one (webmail directory-picker-dialog.tsx). Typing
 * a name only offered suggestions one at a time.
 */
export function RecipientPickerSheet({ visible, onClose, onAdd }: {
  visible: boolean;
  onClose: () => void;
  /** The ticked entries in list order; the sheet closes afterwards. */
  onAdd: (field: PickerField, entries: DirectoryEntry[]) => void;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const locale = useLocaleStore((s) => s.locale);
  const bottomInset = useSheetBottomInset(visible);
  const contacts = useContactsStore((s) => s.contacts);
  const directory = useContactsStore((s) => s.directory);
  const directoryStatus = useContactsStore((s) => s.directoryStatus);
  const fetchDirectory = useContactsStore((s) => s.fetchDirectory);
  const ownEntries = React.useMemo(() => contactEntries(contacts), [contacts]);
  const hasDirectory = directoryStatus !== 'unavailable';
  const [tab, setTab] = React.useState<PickerTab>('contacts');
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());

  React.useEffect(() => {
    if (!visible) return;
    setSelected(new Set());
    setQuery('');
    // Contacts first; straight to the directory for someone who has none.
    setTab(ownEntries.length === 0 && hasDirectory ? 'directory' : 'contacts');
    if (directoryStatus === 'idle') void fetchDirectory();
    // On open only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const shown = React.useMemo(
    () => filterDirectory(tab === 'contacts' ? ownEntries : directory, query, locale),
    [tab, ownEntries, directory, query, locale],
  );

  const toggle = (entry: DirectoryEntry) => {
    const key = pickerKey(entry);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const add = (field: PickerField) => {
    const entries = pickedEntries(selected, [ownEntries, directory]);
    if (entries.length === 0) return;
    onAdd(field, entries);
    onClose();
  };

  const emptyText = tab === 'contacts'
    ? ownEntries.length === 0
      ? t('compose_send.contacts_empty_title', 'No contacts yet')
      : t('compose_send.contacts_no_match', 'No contact matches your search')
    : directory.length === 0
      ? t('contacts.directory.empty_title', 'The directory is empty')
      : t('contacts.directory.no_match', 'No one in the directory matches your search');

  const tabButton = (value: PickerTab, label: string) => (
    <Pressable
      key={value}
      onPress={() => setTab(value)}
      accessibilityRole="tab"
      accessibilityState={{ selected: tab === value }}
      style={[styles.tab, tab === value && styles.tabActive]}
    >
      <Text style={[styles.tabText, tab === value && styles.tabTextActive]}>{label}</Text>
    </Pressable>
  );

  const addButton = (field: PickerField, label: string, primary = false) => (
    <Pressable
      onPress={() => add(field)}
      disabled={selected.size === 0}
      accessibilityRole="button"
      accessibilityState={{ disabled: selected.size === 0 }}
      style={[styles.btn, primary ? styles.btnPrimary : styles.btnOutline, selected.size === 0 && styles.btnDisabled]}
    >
      <Text style={primary ? styles.btnPrimaryText : styles.btnText}>{label}</Text>
    </Pressable>
  );

  return (
    <Modal supportedOrientations={MODAL_ORIENTATIONS} visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={[styles.backdrop, { paddingBottom: spacing.lg + bottomInset }]}>
        <View style={styles.card} accessibilityViewIsModal>
          <View style={styles.header}>
            <Text style={styles.title} accessibilityRole="header">{t('compose_send.picker_title', 'Add recipients')}</Text>
            <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel={t('contacts.directory.cancel', 'Cancel')}>
              <X size={18} color={c.textSecondary} />
            </Pressable>
          </View>
          {hasDirectory && (
            <View style={styles.tabs} accessibilityRole="tablist">
              {tabButton('contacts', t('compose_send.tab_contacts', 'Contacts'))}
              {tabButton('directory', t('compose_send.tab_directory', 'Directory'))}
            </View>
          )}
          <View style={styles.search}>
            <Search size={16} color={c.textMuted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder={t('contacts.directory.search_placeholder', 'Search name or email address')}
              placeholderTextColor={c.textMuted}
              accessibilityLabel={t('contacts.directory.search_placeholder', 'Search name or email address')}
              autoCapitalize="none"
              autoCorrect={false}
              style={styles.searchInput}
            />
          </View>
          <FlatList
            style={styles.list}
            data={shown}
            keyExtractor={(e) => pickerKey(e)}
            keyboardShouldPersistTaps="handled"
            renderItem={({ item }) => {
              const checked = selected.has(pickerKey(item));
              return (
                <Pressable
                  onPress={() => toggle(item)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked }}
                  accessibilityLabel={item.name !== item.email ? `${item.name}, ${item.email}` : item.email}
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                >
                  <View style={[styles.box, checked && styles.boxOn]}>
                    {checked ? <Check size={14} color={c.primaryForeground} /> : null}
                  </View>
                  {item.type === 'group'
                    ? <View style={styles.iconAvatar}><Users size={16} color={c.primary} /></View>
                    : <SenderAvatar name={item.name} email={item.email} size={componentSizes.avatarSm} photo={null} />}
                  <View style={styles.info}>
                    <Text style={styles.name} numberOfLines={1}>{item.name}</Text>
                    {item.name !== item.email ? <Text style={styles.email} numberOfLines={1}>{item.email}</Text> : null}
                  </View>
                </Pressable>
              );
            }}
            ListEmptyComponent={
              <View style={styles.empty}>
                {tab === 'directory' && directoryStatus === 'loading'
                  ? <ActivityIndicator color={c.primary} />
                  : <Text style={styles.emptyText}>{emptyText}</Text>}
              </View>
            }
          />
          <View style={styles.footer}>
            <Text style={styles.count}>{t('contacts.directory.selected_count', '{count} selected', { count: selected.size })}</Text>
            {addButton('bcc', t('contacts.directory.add_bcc', 'Add to Bcc'))}
            {addButton('cc', t('contacts.directory.add_cc', 'Add to Cc'))}
            {addButton('to', t('contacts.directory.add_to', 'Add to To'), true)}
          </View>
        </View>
      </View>
    </Modal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', padding: spacing.lg },
    card: {
      width: '100%',
      maxWidth: 520,
      height: '85%',
      backgroundColor: c.background,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.lg,
      overflow: 'hidden',
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: c.border,
    },
    title: { ...typography.bodySemibold, color: c.text },
    tabs: { flexDirection: 'row', gap: spacing.xs, paddingHorizontal: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.border },
    tab: { paddingHorizontal: spacing.md, paddingVertical: spacing.sm, borderBottomWidth: 2, borderBottomColor: 'transparent', minHeight: 44, justifyContent: 'center' },
    tabActive: { borderBottomColor: c.primary },
    tabText: { ...typography.bodyMedium, color: c.mutedForeground },
    tabTextActive: { color: c.text },
    search: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      margin: spacing.md,
      paddingHorizontal: spacing.md,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
      minHeight: 40,
    },
    searchInput: { ...typography.body, color: c.text, flex: 1, paddingVertical: 0 },
    list: { flex: 1 },
    row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, minHeight: 48 },
    rowPressed: { backgroundColor: c.surfaceHover },
    box: { width: 20, height: 20, borderRadius: radius.sm, borderWidth: 1, borderColor: c.border, alignItems: 'center', justifyContent: 'center' },
    boxOn: { backgroundColor: c.primary, borderColor: c.primary },
    iconAvatar: {
      width: componentSizes.avatarSm,
      height: componentSizes.avatarSm,
      borderRadius: componentSizes.avatarSm / 2,
      backgroundColor: c.primaryBg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    info: { flex: 1, minWidth: 0 },
    name: { ...typography.bodyMedium, color: c.text },
    email: { ...typography.caption, color: c.textSecondary },
    empty: { padding: spacing.xl, alignItems: 'center' },
    emptyText: { ...typography.body, color: c.mutedForeground, textAlign: 'center' },
    footer: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      alignItems: 'center',
      justifyContent: 'flex-end',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: c.border,
    },
    count: { ...typography.caption, color: c.mutedForeground, marginRight: 'auto' },
    btn: { paddingHorizontal: spacing.md, minHeight: 36, borderRadius: radius.sm, justifyContent: 'center' },
    btnOutline: { borderWidth: 1, borderColor: c.border },
    btnPrimary: { backgroundColor: c.primary },
    btnDisabled: { opacity: 0.5 },
    btnText: { ...typography.bodyMedium, color: c.text },
    btnPrimaryText: { ...typography.bodyMedium, color: c.primaryForeground },
  });
}
