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
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  Search, Plus, UserCircle, X, Menu, Trash2, Tag, FolderInput,
} from 'lucide-react-native';
import type { RootStackParamList } from '../navigation/types';
import type { ContactCard } from '../api/types';
import {
  useContactsStore,
  sortContactsByDisplayName,
  selectGroupMembers,
  type ContactCategory,
} from '../stores/contacts-store';
import { getContactDisplayName, isGroup, matchesContactSearch } from '../lib/contact-utils';
import { ContactListRow } from '../components/contacts';
import Dialog from '../components/Dialog';
import ContactsSidebarDrawer from '../components/contacts/ContactsSidebarDrawer';
import { useSettingsStore } from '../stores/settings-store';
import { colors, spacing, radius, typography, componentSizes } from '../theme/tokens';

type Nav = NativeStackNavigationProp<RootStackParamList>;

interface Section {
  title: string;
  data: ContactCard[];
}

function groupContacts(contacts: ContactCard[]): Section[] {
  const sorted = sortContactsByDisplayName(contacts);
  const groups: Record<string, ContactCard[]> = {};
  for (const c of sorted) {
    const name = getContactDisplayName(c).trim();
    const letter = (name[0] || '#').toUpperCase();
    const key = /[A-Z]/.test(letter) ? letter : '#';
    if (!groups[key]) groups[key] = [];
    groups[key].push(c);
  }
  return Object.keys(groups)
    .sort((a, b) => {
      if (a === '#') return 1;
      if (b === '#') return -1;
      return a.localeCompare(b);
    })
    .map((title) => ({ title, data: groups[title] }));
}

function categoryTitle(category: ContactCategory, books: Array<{ id: string; name: string }>, groups: ContactCard[]): string {
  switch (category.type) {
    case 'all':
      return 'All Contacts';
    case 'addressBook':
      return books.find((b) => b.id === category.addressBookId)?.name || 'Address Book';
    case 'group': {
      const g = groups.find((c) => c.id === category.groupId);
      return g ? getContactDisplayName(g) || 'Group' : 'Group';
    }
    case 'keyword':
      return `#${category.keyword}`;
    case 'uncategorized':
      return 'Uncategorized';
    default:
      return 'Contacts';
  }
}

export default function ContactsScreen() {
  const navigation = useNavigation<Nav>();
  const contacts = useContactsStore((s) => s.contacts);
  const addressBooks = useContactsStore((s) => s.addressBooks);
  const loading = useContactsStore((s) => s.loading);
  const error = useContactsStore((s) => s.error);
  const selectedCategory = useContactsStore((s) => s.selectedCategory);
  const hydrated = useContactsStore((s) => s.hydrated);
  const fetchAddressBooks = useContactsStore((s) => s.fetchAddressBooks);
  const fetchContacts = useContactsStore((s) => s.fetchContacts);
  const hydrate = useContactsStore((s) => s.hydrate);
  const bulkDelete = useContactsStore((s) => s.bulkDelete);
  const setSelectedCategory = useContactsStore((s) => s.setSelectedCategory);
  const groupByLetter = useSettingsStore((s) => s.groupContactsByLetter);

  const [searchQuery, setSearchQuery] = React.useState('');
  const [searchActive, setSearchActive] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const [selection, setSelection] = React.useState<Set<string>>(new Set());
  const [confirmBulkDelete, setConfirmBulkDelete] = React.useState(false);

  React.useEffect(() => {
    void hydrate();
  }, [hydrate]);

  React.useEffect(() => {
    void fetchAddressBooks();
    void fetchContacts();
  }, [fetchAddressBooks, fetchContacts]);

  const groups = React.useMemo(() => contacts.filter(isGroup), [contacts]);
  const individuals = React.useMemo(() => contacts.filter((c) => !isGroup(c)), [contacts]);

  const visible = React.useMemo(() => {
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
        filtered = individuals.filter(
          (c) => !c.addressBookIds || Object.keys(c.addressBookIds).length === 0,
        );
        break;
      default:
        filtered = individuals;
    }
    if (!searchQuery) return filtered;
    return filtered.filter((c) => matchesContactSearch(c, searchQuery));
  }, [contacts, individuals, selectedCategory, searchQuery]);

  const sections = React.useMemo<Section[]>(() => {
    if (groupByLetter) return groupContacts(visible);
    // Flat list — single unnamed section keeps SectionList rendering simple.
    return [{ title: '', data: sortContactsByDisplayName(visible) }];
  }, [visible, groupByLetter]);

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
    if (isGroup(c)) {
      navigation.navigate('GroupDetail', { groupId: c.id });
    } else {
      navigation.navigate('ContactDetail', { contactId: c.id });
    }
  };

  const handleLongPress = (c: ContactCard) => {
    toggleSelect(c.id);
  };

  const clearSelection = () => setSelection(new Set());

  const doBulkDelete = async () => {
    const ids = Array.from(selection);
    setConfirmBulkDelete(false);
    clearSelection();
    await bulkDelete(ids);
  };

  const title = categoryTitle(selectedCategory, addressBooks, groups);

  // Top chip row: All / per-address-book / Groups
  const chips = React.useMemo(() => {
    const items: Array<{ key: string; label: string; category: ContactCategory; active: boolean }> = [
      {
        key: 'all',
        label: 'All',
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
        label: 'Groups',
        category: { type: 'all' },
        active: false,
      });
      for (const g of groups) {
        items.push({
          key: `group:${g.id}`,
          label: getContactDisplayName(g) || 'Group',
          category: { type: 'group', groupId: g.id },
          active: selectedCategory.type === 'group' && selectedCategory.groupId === g.id,
        });
      }
    }
    return items;
  }, [addressBooks, groups, selectedCategory]);

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      <ContactsSidebarDrawer visible={drawerOpen} onClose={() => setDrawerOpen(false)} />

      <View style={styles.header}>
        {selectionMode ? (
          <>
            <Pressable onPress={clearSelection} style={styles.headerIconBtn} hitSlop={8}>
              <X size={22} color={colors.text} />
            </Pressable>
            <Text style={styles.headerTitle}>{selection.size} selected</Text>
            <View style={styles.headerActions}>
              <Pressable
                onPress={() => setConfirmBulkDelete(true)}
                style={styles.headerIconBtn}
                hitSlop={8}
              >
                <Trash2 size={20} color={colors.error} />
              </Pressable>
            </View>
          </>
        ) : (
          <>
            <Pressable onPress={() => setDrawerOpen(true)} style={styles.headerIconBtn} hitSlop={8}>
              <Menu size={22} color={colors.text} />
            </Pressable>
            <Text style={styles.headerTitle} numberOfLines={1}>{title}</Text>
            <Text style={styles.headerCount}>{visible.length}</Text>
            <View style={styles.headerActions}>
              <Pressable
                onPress={() => setSearchActive((v) => !v)}
                style={styles.headerIconBtn}
                hitSlop={8}
              >
                <Search size={20} color={colors.text} />
              </Pressable>
              <Pressable
                onPress={() => navigation.navigate('ContactForm', {})}
                style={styles.addBtn}
                hitSlop={8}
              >
                <Plus size={18} color={colors.primaryForeground} />
              </Pressable>
            </View>
          </>
        )}
      </View>

      {searchActive && (
        <View style={styles.searchBar}>
          <Search size={16} color={colors.textMuted} />
          <TextInput
            style={styles.searchInput}
            placeholder="Search contacts..."
            placeholderTextColor={colors.textMuted}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoFocus
          />
          {searchQuery.length > 0 && (
            <Pressable onPress={() => setSearchQuery('')} hitSlop={8}>
              <X size={16} color={colors.textMuted} />
            </Pressable>
          )}
        </View>
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
                onPress={() => setSelectedCategory(chip.category)}
                style={[styles.chip, chip.active && styles.chipActive]}
              >
                <Text style={[styles.chipText, chip.active && styles.chipTextActive]} numberOfLines={1}>
                  {chip.label}
                </Text>
              </Pressable>
            ),
          )}
        </ScrollView>
      )}

      {error && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      )}

      <SectionList
        sections={sections}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <ContactListRow
            contact={item}
            onPress={() => handleRowPress(item)}
            onLongPress={() => handleLongPress(item)}
            selected={selection.has(item.id)}
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
            tintColor={colors.primary}
          />
        }
        ListEmptyComponent={
          loading ? (
            <View style={styles.emptyState}>
              <ActivityIndicator color={colors.primary} />
            </View>
          ) : (
            <View style={styles.emptyState}>
              <UserCircle size={48} color={colors.surfaceActive} />
              <Text style={styles.emptyTitle}>
                {searchQuery ? 'No contacts found' : 'No contacts yet'}
              </Text>
              <Text style={styles.emptySubtitle}>
                {searchQuery ? 'Try a different search' : 'Tap + to add one'}
              </Text>
            </View>
          )
        }
      />

      <Dialog
        visible={confirmBulkDelete}
        title="Delete contacts"
        message={`Delete ${selection.size} contact${selection.size === 1 ? '' : 's'}? This cannot be undone.`}
        variant="destructive"
        confirmText="Delete"
        onConfirm={doBulkDelete}
        onCancel={() => setConfirmBulkDelete(false)}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  listContent: { paddingBottom: 80 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    gap: spacing.sm,
  },
  headerTitle: { ...typography.h3, color: colors.text, flexShrink: 1 },
  headerCount: {
    ...typography.small,
    color: colors.textMuted,
    backgroundColor: colors.surface,
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
    backgroundColor: colors.primary,
    borderRadius: radius.full,
  },

  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.lg,
    marginBottom: spacing.md,
    paddingHorizontal: spacing.md,
    height: componentSizes.inputHeight,
    backgroundColor: colors.background,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    gap: spacing.sm,
  },
  searchInput: { flex: 1, ...typography.body, color: colors.text, paddingVertical: 0 },

  chipBar: { flexGrow: 0, marginBottom: spacing.sm },
  chipBarContent: {
    paddingHorizontal: spacing.lg,
    gap: spacing.sm,
    alignItems: 'center',
  },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  chipText: { ...typography.captionMedium, color: colors.textSecondary },
  chipTextActive: { color: colors.primaryForeground },
  chipDivider: {
    width: 1,
    height: 16,
    backgroundColor: colors.border,
    marginHorizontal: spacing.xs,
  },

  sectionHeader: {
    backgroundColor: colors.background,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: colors.borderLight,
  },
  sectionHeaderText: { ...typography.small, color: colors.primary },

  separator: { height: 1, backgroundColor: colors.borderLight, marginLeft: 68 },

  errorBanner: {
    marginHorizontal: spacing.lg,
    marginBottom: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    backgroundColor: colors.errorBg,
    borderWidth: 1,
    borderColor: colors.errorBorder,
  },
  errorText: { ...typography.caption, color: colors.errorForeground },

  emptyState: {
    alignItems: 'center',
    paddingVertical: spacing.xxxl * 2,
    gap: spacing.sm,
  },
  emptyTitle: { ...typography.bodyMedium, color: colors.textSecondary },
  emptySubtitle: { ...typography.caption, color: colors.textMuted },
});
