import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  SectionList,
  Pressable,
  TextInput,
  ActivityIndicator,
  RefreshControl,
  ScrollView,
  Alert,
  Share,
} from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import { useBackWhileFocused } from '../lib/use-back-while-focused';
import { listBackStep } from '../lib/list-back';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Search, Plus, UserCircle, X, Menu, Trash2, Tag, FolderInput, Upload, CheckSquare, Share2, Filter,
} from '../components/icons';
import { ContactFiltersPanel } from '../components/contacts/ContactFiltersPanel';
import {
  countActiveFilters, EMPTY_CONTACT_FILTERS, matchesContactFilters, type ContactListFilters,
} from '../lib/contact-list-filters';
import type { RootStackParamList } from '../navigation/types';
import type { ContactCard } from '../api/types';
import {
  useContactsStore,
  sortContactsByName,
  selectCreateTargetBookId,
  selectGroupMembers,
  selectUncategorized,
  type ContactCategory,
} from '../stores/contacts-store';
import { getContactDisplayName, getContactSortName, isGroup, matchesContactSearch } from '../lib/contact-utils';
import { contactsToVCard } from '../lib/vcard';
import { inlineContactMediaForExport } from '../lib/contact-media';
import {
  ContactListRow,
  AddressBookPickerSheet,
  ContactImportSheet,
  TagAssignSheet,
} from '../components/contacts';
import Dialog from '../components/Dialog';
import ContactsSidebarDrawer from '../components/contacts/ContactsSidebarDrawer';
import { DirectoryBrowser } from '../components/contacts/DirectoryBrowser';
import { supportsSharing } from '../api/files';
import { useSettingsStore } from '../stores/settings-store';
import { useLocaleStore, type TranslateFn } from '../stores/locale-store';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';

type Nav = NativeStackNavigationProp<RootStackParamList>;

interface Section {
  title: string;
  data: ContactCard[];
}

/** Letter sections for contacts already in `sortContactsByName` order. */
function groupContacts(sorted: ContactCard[], byLastName: boolean): Section[] {
  const groups: Record<string, ContactCard[]> = {};
  for (const c of sorted) {
    // Sections follow the sort name, so with "sort by last name" Alice Smith
    // files under S.
    const name = getContactSortName(c, byLastName).trim();
    // Any letter (Ä, É, Ł, 王…) gets its own section like the webmail; only
    // digits and symbols fall into "#". Hermes supports Unicode property escapes.
    const first = Array.from(name)[0] || '#';
    const letter = first.toLocaleUpperCase();
    const key = /\p{L}/u.test(letter) ? letter : '#';
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  }
  return Object.keys(groups)
    .sort((a, b) => {
      if (a === '#') return 1;
      if (b === '#') return -1;
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    })
    .map((title) => ({ title, data: groups[title] }));
}

function categoryTitle(
  category: ContactCategory,
  books: Array<{ id: string; name: string }>,
  groups: ContactCard[],
  t: TranslateFn,
): string {
  switch (category.type) {
    case 'all':
      return t('contacts.all_contacts', 'All Contacts');
    case 'addressBook':
      return books.find((b) => b.id === category.addressBookId)?.name
        || t('contacts.address_books.address_book', 'Address Book');
    case 'group': {
      const g = groups.find((c) => c.id === category.groupId);
      return (g && getContactDisplayName(g)) || t('contacts.group', 'Group');
    }
    case 'keyword':
      return `#${category.keyword}`;
    case 'uncategorized':
      return t('contacts.no_category', 'No Category');
    default:
      return t('contacts.title', 'Contacts');
  }
}

interface ContactsScreenProps {
  /** Split view: open the contact in the detail pane instead of the stack. */
  onOpenContact?: (contact: ContactCard) => void;
  /** The contact open in the detail pane. */
  activeContactId?: string | null;
}

export default function ContactsScreen({ onOpenContact, activeContactId = null }: ContactsScreenProps = {}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const navigation = useNavigation<Nav>();
  const t = useLocaleStore((s) => s.t);
  const contacts = useContactsStore((s) => s.contacts);
  const addressBooks = useContactsStore((s) => s.addressBooks);
  const loading = useContactsStore((s) => s.loading);
  const error = useContactsStore((s) => s.error);
  const selectedCategory = useContactsStore((s) => s.selectedCategory);
  const hydrated = useContactsStore((s) => s.hydrated);
  const fetchAddressBooks = useContactsStore((s) => s.fetchAddressBooks);
  const fetchContacts = useContactsStore((s) => s.fetchContacts);
  const fetchContactsIfStale = useContactsStore((s) => s.fetchContactsIfStale);
  const hydrate = useContactsStore((s) => s.hydrate);
  const bulkDelete = useContactsStore((s) => s.bulkDelete);
  const moveContactsToAddressBook = useContactsStore((s) => s.moveContactsToAddressBook);
  const addKeywordToContacts = useContactsStore((s) => s.addKeywordToContacts);
  const setSelectedCategory = useContactsStore((s) => s.setSelectedCategory);
  const getDefaultAddressBookId = useContactsStore((s) => s.getDefaultAddressBookId);
  const groupByLetter = useSettingsStore((s) => s.groupContactsByLetter);
  const sortByLastName = useSettingsStore((s) => s.sortContactsByLastName);

  const [searchQuery, setSearchQuery] = React.useState('');
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const [filters, setFilters] = React.useState<ContactListFilters>(EMPTY_CONTACT_FILTERS);
  const activeFilterCount = countActiveFilters(filters);
  // The company directory shows in place of the list (#1253). Not a stored
  // category: it is the server's list, not the user's contacts.
  const [showDirectory, setShowDirectory] = React.useState(false);
  const directoryAvailable = supportsSharing();
  const [searchActive, setSearchActive] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [selection, setSelection] = React.useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = React.useState(false);
  const [moveSheetOpen, setMoveSheetOpen] = React.useState(false);
  const [tagSheetOpen, setTagSheetOpen] = React.useState(false);
  const [importOpen, setImportOpen] = React.useState(false);
  const [importTargetOpen, setImportTargetOpen] = React.useState(false);
  const [importTargetBookId, setImportTargetBookId] = React.useState<string | null>(null);

  React.useEffect(() => {
    void hydrate();
  }, [hydrate]);

  // The cards loaded at startup and follow live changes; only download them
  // again when that copy is stale. Pull to refresh still forces a reload.
  React.useEffect(() => {
    void fetchAddressBooks();
    void fetchContactsIfStale();
  }, [fetchAddressBooks, fetchContactsIfStale]);

  const groups = React.useMemo(() => contacts.filter(isGroup), [contacts]);
  const individuals = React.useMemo(() => contacts.filter((c) => !isGroup(c)), [contacts]);

  const categoryContacts = React.useMemo(() => {
    let filtered: ContactCard[];
    switch (selectedCategory.type) {
      case 'all':
        filtered = individuals;
        break;
      case 'addressBook':
        filtered = individuals.filter((c) => c.addressBookIds?.[selectedCategory.addressBookId]);
        break;
      case 'group':
        filtered = selectGroupMembers(
          { contacts } as Parameters<typeof selectGroupMembers>[0],
          selectedCategory.groupId,
        ).filter((c) => !isGroup(c));
        break;
      case 'keyword':
        filtered = individuals.filter((c) => c.keywords?.[selectedCategory.keyword]);
        break;
      case 'uncategorized':
        // "No category" = contacts without a keyword, like the webmail.
        filtered = selectUncategorized(individuals);
        break;
      default:
        filtered = individuals;
    }
    return filtered;
  }, [contacts, individuals, selectedCategory]);

  // Sort once per list or order change; search only filters the sorted list,
  // so typing never re-sorts the address book (PF10).
  const sorted = React.useMemo(
    () => sortContactsByName(categoryContacts, sortByLastName),
    [categoryContacts, sortByLastName],
  );

  const visible = React.useMemo(() => {
    // The filters sit under the search field and apply while it is open.
    const filtered = searchActive && activeFilterCount > 0 ? sorted.filter((c) => matchesContactFilters(c, filters)) : sorted;
    if (!searchQuery) return filtered;
    return filtered.filter((c) => matchesContactSearch(c, searchQuery));
  }, [sorted, searchQuery, filters, activeFilterCount, searchActive]);

  const sections = React.useMemo<Section[]>(() => {
    if (groupByLetter) return groupContacts(visible, sortByLastName);
    // Flat list - single unnamed section keeps SectionList rendering simple.
    return [{ title: '', data: visible }];
  }, [visible, groupByLetter, sortByLastName]);

  const selectionMode = selection.size > 0;
  const toggleSelect = (id: string) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleRowPress = (c: ContactCard) => {
    if (selectionMode) {
      toggleSelect(c.id);
      return;
    }
    if (onOpenContact) {
      onOpenContact(c);
    } else if (isGroup(c)) {
      navigation.navigate('GroupDetail', { groupId: c.id });
    } else {
      navigation.navigate('ContactDetail', { contactId: c.id });
    }
  };

  const handleLongPress = (c: ContactCard) => {
    toggleSelect(c.id);
  };

  const clearSelection = () => setSelection(new Set());

  // Back leaves selection mode, then the search, before it leaves the tab.
  const backStep = listBackStep({ selecting: selectionMode, searching: searchActive || searchQuery.length > 0 });
  useBackWhileFocused(backStep !== 'leave', () => {
    if (backStep === 'clear-selection') {
      clearSelection();
    } else {
      setSearchQuery('');
      setSearchActive(false);
    }
  });

  const doBulkDelete = async () => {
    const ids = Array.from(selection);
    setConfirmBulkDelete(false);
    clearSelection();
    await bulkDelete(ids);
  };

  const selectAllVisible = () => {
    setSelection((prev) => {
      const allSelected = visible.length > 0 && visible.every((c) => prev.has(c.id));
      return allSelected ? new Set() : new Set(visible.map((c) => c.id));
    });
  };

  // Downloading photos stored as blobs (Stalwart 1.0) into the file takes a
  // moment; a second tap meanwhile would start the whole export again.
  const exportingRef = React.useRef(false);
  const exportSelected = async () => {
    const selected = contacts.filter((c) => selection.has(c.id));
    if (selected.length === 0 || exportingRef.current) return;
    exportingRef.current = true;
    try {
      await shareVCard(contactsToVCard(await inlineContactMediaForExport(selected)));
    } finally {
      exportingRef.current = false;
    }
  };

  const shareVCard = async (vcf: string) => {
    try {
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
    }
  };

  // A new contact or group lands in the address book being viewed, not the
  // default one.
  const createBookId = React.useMemo(
    () => selectCreateTargetBookId(selectedCategory, addressBooks),
    [selectedCategory, addressBooks],
  );

  const openNewMenu = () => {
    Alert.alert(t('common.create', 'Create'), undefined, [
      {
        text: t('contacts.create_new', 'New Contact'),
        onPress: () => navigation.navigate('ContactForm', { addressBookId: createBookId }),
      },
      {
        text: t('contacts.groups.create', 'New Group'),
        onPress: () => navigation.navigate('ContactForm', { asGroup: true, addressBookId: createBookId }),
      },
      { text: t('common.cancel', 'Cancel'), style: 'cancel' },
    ]);
  };

  // Default target for moves/imports: the currently-viewed address book, else
  // the account's default book.
  const defaultBookId = React.useMemo(() => {
    if (selectedCategory.type === 'addressBook') return selectedCategory.addressBookId;
    return getDefaultAddressBookId();
  }, [selectedCategory, addressBooks, getDefaultAddressBookId]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleBulkMove = async (bookId: string) => {
    const ids = Array.from(selection);
    setMoveSheetOpen(false);
    clearSelection();
    try {
      await moveContactsToAddressBook(ids, bookId);
    } catch (err) {
      Alert.alert(t('contacts.address_books.move_failed', 'Failed to move contact'), err instanceof Error ? err.message : t('identities.validation_errors.unknown_error', 'Unknown error'));
    }
  };

  const handleBulkTag = async (keyword: string) => {
    const ids = Array.from(selection);
    setTagSheetOpen(false);
    clearSelection();
    try {
      await addKeywordToContacts(ids, keyword);
    } catch (err) {
      Alert.alert(t('contacts.bulk.tag_failed', 'Tagging failed'), err instanceof Error ? err.message : t('identities.validation_errors.unknown_error', 'Unknown error'));
    }
  };

  const openImport = () => {
    setImportTargetBookId(defaultBookId);
    setImportOpen(true);
  };

  const importTargetName = React.useMemo(
    () => addressBooks.find((b) => b.id === importTargetBookId)?.name,
    [addressBooks, importTargetBookId],
  );

  const title = showDirectory
    ? t('contacts.directory.title', 'Directory')
    : categoryTitle(selectedCategory, addressBooks, groups, t);

  // Top chip row: All / per-address-book / Groups
  const chips = React.useMemo(() => {
    const items: Array<{ key: string; label: string; category: ContactCategory; active: boolean }> = [
      {
        key: 'all',
        label: t('contacts.tabs.all', 'All'),
        category: { type: 'all' },
        active: selectedCategory.type === 'all',
      },
    ];
    for (const book of addressBooks) {
      items.push({
        key: `book:${book.id}`,
        label: book.name,
        category: { type: 'addressBook', addressBookId: book.id },
        active: selectedCategory.type === 'addressBook' && selectedCategory.addressBookId === book.id,
      });
    }
    if (groups.length > 0) {
      items.push({
        key: 'groups-divider',
        label: t('contacts.tabs.groups', 'Groups'),
        category: { type: 'all' },
        active: false,
      });
      for (const g of groups) {
        items.push({
          key: `group:${g.id}`,
          label: getContactDisplayName(g) || t('contacts.group', 'Group'),
          category: { type: 'group', groupId: g.id },
          active: selectedCategory.type === 'group' && selectedCategory.groupId === g.id,
        });
      }
    }
    return items;
  }, [addressBooks, groups, selectedCategory, t]);

  return (
    <SafeAreaView style={styles.container} edges={['top', 'left', 'right']}>
      <ContactsSidebarDrawer visible={drawerOpen} onClose={() => setDrawerOpen(false)} />

      <View style={styles.header}>
        {selectionMode ? (
          <>
            <Pressable
              onPress={clearSelection}
              style={styles.headerIconBtn}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('contacts.bulk.clear', 'Clear selection')}
            >
              <X size={22} color={c.text} />
            </Pressable>
            <Text style={styles.headerTitle}>
              {t('contacts.bulk.selected', '{count, plural, one {1 selected} other {# selected}}', { count: selection.size })}
            </Text>
            <View style={styles.headerActions}>
              <Pressable
                onPress={selectAllVisible}
                style={styles.headerIconBtn}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('contacts.bulk.select_all', 'Select all')}
              >
                <CheckSquare size={20} color={c.text} />
              </Pressable>
              <Pressable
                onPress={() => { void exportSelected(); }}
                style={styles.headerIconBtn}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('contacts.bulk.export', 'Export')}
              >
                <Share2 size={20} color={c.text} />
              </Pressable>
              {addressBooks.length > 0 && (
                <Pressable
                  onPress={() => setMoveSheetOpen(true)}
                  style={styles.headerIconBtn}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={t('contacts.bulk.move_to_address_book', 'Move to address book')}
                >
                  <FolderInput size={20} color={c.text} />
                </Pressable>
              )}
              <Pressable
                onPress={() => setTagSheetOpen(true)}
                style={styles.headerIconBtn}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('contacts.bulk.add_tag', 'Add tag')}
              >
                <Tag size={20} color={c.text} />
              </Pressable>
              <Pressable
                onPress={() => setConfirmBulkDelete(true)}
                style={styles.headerIconBtn}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('contacts.bulk.delete', 'Delete')}
              >
                <Trash2 size={20} color={c.error} />
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <Pressable
              onPress={() => setDrawerOpen(true)}
              style={styles.headerIconBtn}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('contacts.open_categories', 'Open categories')}
            >
              <Menu size={22} color={c.text} />
            </Pressable>
            <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
            <Text style={styles.headerCount}>{visible.length}</Text>
            <View style={styles.headerActions}>
              <Pressable
                onPress={() => setSearchActive((v) => !v)}
                style={styles.headerIconBtn}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('common.search', 'Search')}
              >
                <Search size={20} color={c.text} />
              </Pressable>
              <Pressable
                onPress={openImport}
                style={styles.headerIconBtn}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('contacts.import_vcard', 'Import vCard')}
              >
                <Upload size={20} color={c.text} />
              </Pressable>
              <Pressable
                onPress={() => navigation.navigate('ContactForm', { addressBookId: createBookId })}
                onLongPress={openNewMenu}
                style={styles.addBtn}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel={t('contacts.create_new', 'New Contact')}
                accessibilityHint={t('contacts.create_hint_mobile', 'Long-press to create a group instead')}
              >
                <Plus size={18} color={c.primaryForeground} />
              </Pressable>
            </View>
          </>
        )}
      </View>

      {searchActive && (
        <View style={styles.searchBar}>
          <Search size={16} color={c.textMuted} />
          <TextInput
            accessibilityLabel={t('contacts.search_placeholder', 'Search contacts...')}
            style={styles.searchInput}
            placeholder={t('contacts.search_placeholder', 'Search contacts...')}
            placeholderTextColor={c.textMuted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoFocus
          />
          {searchQuery.length > 0 && (
            <Pressable
              onPress={() => setSearchQuery('')}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel={t('contacts.clear_search', 'Clear search')}
            >
              <X size={16} color={c.textMuted} />
            </Pressable>
          )}
          <Pressable
            onPress={() => setFiltersOpen((v) => !v)}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={t('contacts.filters.toggle', 'Filters')}
            accessibilityState={{ expanded: filtersOpen }}
          >
            <Filter size={16} color={activeFilterCount > 0 ? c.primary : c.textMuted} />
          </Pressable>
        </View>
      )}
      {searchActive && filtersOpen && (
        <ContactFiltersPanel filters={filters} onChange={setFilters} onClose={() => setFiltersOpen(false)} />
      )}

      {!selectionMode && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={styles.chipBar}
          contentContainerStyle={styles.chipBarContent}
        >
          {chips.map((chip) =>
            chip.key === 'groups-divider' ? (
              <View key={chip.key} style={styles.chipDivider} />
            ) : (
              <Pressable
                key={chip.key}
                onPress={() => { setShowDirectory(false); setSelectedCategory(chip.category); }}
                style={[styles.chip, chip.active && !showDirectory && styles.chipActive]}
                hitSlop={{ top: 6, bottom: 6 }}
                accessibilityRole="button"
                accessibilityState={{ selected: chip.active && !showDirectory }}
              >
                <Text style={[styles.chipText, chip.active && !showDirectory && styles.chipTextActive]} numberOfLines={1}>
                  {chip.label}
                </Text>
              </Pressable>
            ),
          )}
          {directoryAvailable && (
            <>
              <View style={styles.chipDivider} />
              <Pressable
                onPress={() => setShowDirectory(true)}
                style={[styles.chip, showDirectory && styles.chipActive]}
                hitSlop={{ top: 6, bottom: 6 }}
                accessibilityRole="button"
                accessibilityState={{ selected: showDirectory }}
              >
                <Text style={[styles.chipText, showDirectory && styles.chipTextActive]} numberOfLines={1}>
                  {t('contacts.directory.title', 'Directory')}
                </Text>
              </Pressable>
            </>
          )}
        </ScrollView>
      )}

      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      {showDirectory && !selectionMode ? <DirectoryBrowser query={searchQuery} /> : <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <ContactListRow
            contact={item}
            onPress={() => handleRowPress(item)}
            onLongPress={() => handleLongPress(item)}
            selected={selection.has(item.id)}
            active={item.id === activeContactId}
            selectionMode={selectionMode}
          />
        )}
        renderSectionHeader={({ section }) =>
          section.title ? (
            <View style={styles.sectionHeader}>
              <Text style={styles.sectionHeaderText}>{section.title}</Text>
            </View>
          ) : null
        }
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        stickySectionHeadersEnabled
        contentContainerStyle={styles.listContent}
        refreshControl={
          <RefreshControl
            refreshing={loading && hydrated}
            onRefresh={() => {
              void fetchContacts();
              void fetchAddressBooks();
            }}
            tintColor={c.primary}
          />
        }
        ListEmptyComponent={
          loading ? (
            <View style={styles.emptyState}>
              <ActivityIndicator color={c.primary} />
            </View>
          ) : (
            <View style={styles.emptyState}>
              <UserCircle size={48} color={c.surfaceActive} />
              <Text style={styles.emptyTitle}>
                {searchQuery
                  ? t('contacts.empty_search', 'No contacts match your search')
                  : t('contacts.empty_state_title', 'No contacts yet')}
              </Text>
              <Text style={styles.emptySubtitle}>
                {searchQuery
                  ? t('contacts.empty_search_hint', 'Try a different search term')
                  : t('contacts.empty_state_hint_mobile', 'Tap + to add one')}
              </Text>
            </View>
          )
        }
      />}

      <Dialog
        visible={confirmBulkDelete}
        title={t('contacts.bulk.delete_confirm_title', 'Delete contacts')}
        message={t(
          'contacts.bulk.delete_confirm_mobile',
          '{count, plural, one {Delete # contact? This cannot be undone.} other {Delete # contacts? This cannot be undone.}}',
          { count: selection.size },
        )}
        variant="destructive"
        confirmText={t('contacts.bulk.delete', 'Delete')}
        onConfirm={doBulkDelete}
        onCancel={() => setConfirmBulkDelete(false)}
      />

      <AddressBookPickerSheet
        visible={moveSheetOpen}
        onClose={() => setMoveSheetOpen(false)}
        onPick={(id) => { void handleBulkMove(id); }}
      />

      <TagAssignSheet
        visible={tagSheetOpen}
        onClose={() => setTagSheetOpen(false)}
        onPick={(kw) => { void handleBulkTag(kw); }}
      />

      <ContactImportSheet
        visible={importOpen}
        onClose={() => setImportOpen(false)}
        targetBookId={importTargetBookId}
        targetBookName={importTargetName}
        onChangeTarget={addressBooks.length > 1 ? () => setImportTargetOpen(true) : undefined}
        onImported={() => { void fetchContacts(); }}
      />

      <AddressBookPickerSheet
        visible={importTargetOpen}
        onClose={() => setImportTargetOpen(false)}
        currentBookId={importTargetBookId}
        title={t('contacts.import.into_address_book', 'Import into address book')}
        onPick={(id) => { setImportTargetBookId(id); setImportTargetOpen(false); }}
      />
    </SafeAreaView>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  container: { flex: 1, backgroundColor: c.background },
  listContent: { paddingBottom: 80 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  headerTitle: { ...typography.h3, color: c.text, flexShrink: 1 },
  headerCount: {
    ...typography.small,
    color: c.textMuted,
    backgroundColor: c.surface,
    borderRadius: radius.full,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  headerActions: {
    flex: 1,
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: spacing.sm,
  },
  headerIconBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
  },
  addBtn: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: c.primary,
    borderRadius: radius.full,
  },

  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    height: componentSizes.inputHeight,
    backgroundColor: c.background,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: c.border,
    gap: spacing.sm,
  },
  searchInput: { flex: 1, ...typography.body, color: c.text, paddingVertical: 0 },

  // flexShrink 0: in a short (landscape) window the column squeezed the
  // horizontal scroller and cut the chips off at the bottom.
  chipBar: { flexGrow: 0, flexShrink: 0, marginBottom: 2 },
  // The vertical padding leaves room for the chips' slop, which makes them
  // 48 dp targets (they were about 28 dp).
  chipBarContent: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 6,
    gap: spacing.sm,
    alignItems: 'center',
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    minHeight: 36,
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: c.surface,
    borderWidth: 1,
    borderColor: c.border,
  },
  chipActive: {
    backgroundColor: c.primary,
    borderColor: c.primary,
  },
  chipText: { ...typography.captionMedium, color: c.textSecondary },
  chipTextActive: { color: c.primaryForeground },
  chipDivider: {
    width: 1,
    height: 16,
    backgroundColor: c.border,
    marginHorizontal: spacing.xs,
  },

  sectionHeader: {
    backgroundColor: c.background,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: c.borderLight,
  },
  sectionHeaderText: { ...typography.captionMedium, color: c.mutedForeground },

  separator: { height: 1, backgroundColor: c.borderLight, marginLeft: 68 },

  errorBanner: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: c.errorBg,
    borderWidth: 1,
    borderColor: c.errorBorder,
  },
  errorText: { ...typography.caption, color: c.errorForeground },

  emptyState: {
    alignItems: 'center',
    paddingVertical: spacing.xxxl * 2,
    gap: spacing.sm,
  },
  emptyTitle: { ...typography.bodyMedium, color: c.textSecondary },
  emptySubtitle: { ...typography.caption, color: c.textMuted },
  });
}
