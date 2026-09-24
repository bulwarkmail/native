import React from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, Modal, Animated, Dimensions, Easing, TextInput, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  X, Users, Tag, BookUser, Inbox, ChevronDown, ChevronRight, Plus, Share2, Check,
} from 'lucide-react-native';
import type { RootStackParamList } from '../../navigation/types';
import type { AddressBook } from '../../api/types';
import type { ContactCategory } from '../../stores/contacts-store';
import {
  useContactsStore, selectCreateTargetBookId, selectGroupMembers, selectUncategorized,
} from '../../stores/contacts-store';
import { getContactDisplayName, getContactKeywords, isGroup } from '../../lib/contact-utils';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';

type Nav = NativeStackNavigationProp<RootStackParamList>;

interface Props {
  visible: boolean;
  onClose: () => void;
}

function isSameCategory(a: ContactCategory, b: ContactCategory): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'addressBook' && b.type === 'addressBook') return a.addressBookId === b.addressBookId;
  if (a.type === 'group' && b.type === 'group') return a.groupId === b.groupId;
  if (a.type === 'keyword' && b.type === 'keyword') return a.keyword === b.keyword;
  return true;
}

export default function ContactsSidebarDrawer({ visible, onClose }: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const navigation = useNavigation<Nav>();
  const selectedCategory = useContactsStore((s) => s.selectedCategory);
  const setSelectedCategory = useContactsStore((s) => s.setSelectedCategory);
  const contacts = useContactsStore((s) => s.contacts);
  const addressBooks = useContactsStore((s) => s.addressBooks);
  const renameKeyword = useContactsStore((s) => s.renameKeyword);

  const totalCount = React.useMemo(
    () => contacts.filter((c) => !isGroup(c)).length,
    [contacts],
  );
  const books = React.useMemo(
    () =>
      addressBooks.map((book) => ({
        ...book,
        count: contacts.filter((c) => !isGroup(c) && c.addressBookIds?.[book.id]).length,
      })),
    [addressBooks, contacts],
  );
  const ownBooks = React.useMemo(() => books.filter((b) => !b.isShared), [books]);
  // Books from shared / group accounts, grouped by the account they live in
  // (the webmail's "Shared from X" sections).
  const sharedSections = React.useMemo(() => {
    const byAccount = new Map<string, { name: string; books: Array<AddressBook & { count: number }> }>();
    for (const book of books) {
      if (!book.isShared) continue;
      const key = book.accountId || '?';
      const entry = byAccount.get(key) ?? { name: book.accountName || key, books: [] };
      entry.books.push(book);
      byAccount.set(key, entry);
    }
    return Array.from(byAccount.entries()).map(([accountId, entry]) => ({ accountId, ...entry }));
  }, [books]);
  const groups = React.useMemo(() => contacts.filter(isGroup), [contacts]);
  // Count resolved members so a deleted card stops counting immediately.
  const memberCountByGroup = React.useMemo(() => {
    const out = new Map<string, number>();
    for (const g of groups) {
      out.set(g.id, selectGroupMembers({ contacts }, g.id).filter((m) => !isGroup(m)).length);
    }
    return out;
  }, [groups, contacts]);
  const keywords = React.useMemo(() => {
    const counts = new Map<string, number>();
    for (const contact of contacts) {
      for (const kw of getContactKeywords(contact)) {
        counts.set(kw, (counts.get(kw) || 0) + 1);
      }
    }
    return Array.from(counts.entries())
      .map(([keyword, count]) => ({ keyword, count }))
      .sort((a, b) => a.keyword.localeCompare(b.keyword));
  }, [contacts]);
  const uncategorizedCount = React.useMemo(() => selectUncategorized(contacts).length, [contacts]);

  const [expanded, setExpanded] = React.useState({
    books: true,
    shared: true,
    groups: true,
    tags: true,
  });
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [renameValue, setRenameValue] = React.useState('');
  const [renameBusy, setRenameBusy] = React.useState(false);

  const slideX = React.useRef(new Animated.Value(-Dimensions.get('window').width)).current;
  const overlay = React.useRef(new Animated.Value(0)).current;

  // Also kicked from the Modal's onShow — the first open fires this effect
  // before the modal's native view exists, so that animation is dropped and
  // the drawer stays parked off-screen until the second open.
  const runOpen = React.useCallback(() => {
    Animated.parallel([
      Animated.timing(slideX, { toValue: 0, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.timing(overlay, { toValue: 1, duration: 240, useNativeDriver: true }),
    ]).start();
  }, [slideX, overlay]);

  React.useEffect(() => {
    if (visible) {
      runOpen();
    } else {
      Animated.parallel([
        Animated.timing(slideX, { toValue: -Dimensions.get('window').width, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlay, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, runOpen, slideX, overlay]);

  const select = (cat: ContactCategory) => {
    setSelectedCategory(cat);
    onClose();
  };

  const commitRename = async () => {
    const from = renaming;
    const to = renameValue.trim();
    if (!from || !to || renameBusy) { setRenaming(null); return; }
    if (to === from) { setRenaming(null); return; }
    setRenameBusy(true);
    try {
      await renameKeyword(from, to);
      setRenaming(null);
    } catch (err) {
      Alert.alert('Rename failed', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setRenameBusy(false);
    }
  };

  const renderBook = (book: AddressBook & { count: number }) => (
    <CategoryRow
      key={book.id}
      icon={<BookUser size={16} color={c.textSecondary} />}
      label={book.name}
      count={book.count}
      badge={book.isDefault ? 'Default' : undefined}
      active={isSameCategory(selectedCategory, { type: 'addressBook', addressBookId: book.id })}
      onPress={() => select({ type: 'addressBook', addressBookId: book.id })}
    />
  );

  return (
    <Modal visible={visible} transparent animationType="none" statusBarTranslucent onRequestClose={onClose} onShow={runOpen}>
      <Animated.View style={[styles.overlay, { opacity: overlay }]}>
        <Pressable style={styles.overlayPress} onPress={onClose} />
      </Animated.View>

      <Animated.View style={[styles.drawer, { transform: [{ translateX: slideX }] }]}>
        <SafeAreaView style={styles.drawerSafe} edges={['top', 'bottom', 'left']}>
          <View style={styles.header}>
            <Pressable onPress={onClose} style={styles.headerClose} hitSlop={8}>
              <X size={20} color={c.text} />
            </Pressable>
            <Text style={styles.headerTitle}>Contacts</Text>
          </View>

          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            <CategoryRow
              icon={<Inbox size={16} color={c.primary} />}
              label="All Contacts"
              count={totalCount}
              active={selectedCategory.type === 'all'}
              onPress={() => select({ type: 'all' })}
            />

            <SectionHeader
              label="Address Books"
              expanded={expanded.books}
              onPress={() => setExpanded((e) => ({ ...e, books: !e.books }))}
            />
            {expanded.books && ownBooks.map(renderBook)}

            {sharedSections.map((section) => (
              <React.Fragment key={section.accountId}>
                <SectionHeader
                  label={`Shared from ${section.name}`}
                  icon={<Share2 size={12} color={c.textMuted} />}
                  expanded={expanded.shared}
                  onPress={() => setExpanded((e) => ({ ...e, shared: !e.shared }))}
                />
                {expanded.shared && section.books.map(renderBook)}
              </React.Fragment>
            ))}

            <SectionHeader
              label="Groups"
              expanded={expanded.groups}
              onPress={() => setExpanded((e) => ({ ...e, groups: !e.groups }))}
            />
            {expanded.groups && groups.map((g) => (
              <CategoryRow
                key={g.id}
                icon={<Users size={16} color={c.textSecondary} />}
                label={getContactDisplayName(g) || 'Group'}
                count={memberCountByGroup.get(g.id) ?? 0}
                active={isSameCategory(selectedCategory, { type: 'group', groupId: g.id })}
                onPress={() => select({ type: 'group', groupId: g.id })}
              />
            ))}
            {expanded.groups && (
              <CategoryRow
                icon={<Plus size={16} color={c.primary} />}
                label="New group"
                count={0}
                active={false}
                muted
                onPress={() => {
                  onClose();
                  // Into the address book being viewed, like a new contact.
                  navigation.navigate('ContactForm', {
                    asGroup: true,
                    addressBookId: selectCreateTargetBookId(selectedCategory, addressBooks),
                  });
                }}
              />
            )}

            <SectionHeader
              label="Tags"
              expanded={expanded.tags}
              onPress={() => setExpanded((e) => ({ ...e, tags: !e.tags }))}
            />
            {expanded.tags && keywords.map((kw) => (
              renaming === kw.keyword ? (
                <View key={kw.keyword} style={styles.renameRow}>
                  <Tag size={16} color={c.textSecondary} />
                  <TextInput
                    style={styles.renameInput}
                    value={renameValue}
                    onChangeText={setRenameValue}
                    autoFocus
                    returnKeyType="done"
                    onSubmitEditing={() => { void commitRename(); }}
                    placeholderTextColor={c.textMuted}
                  />
                  <Pressable onPress={() => { void commitRename(); }} hitSlop={6} style={styles.renameBtn}>
                    <Check size={16} color={c.primary} />
                  </Pressable>
                  <Pressable onPress={() => setRenaming(null)} hitSlop={6} style={styles.renameBtn}>
                    <X size={16} color={c.textMuted} />
                  </Pressable>
                </View>
              ) : (
                <CategoryRow
                  key={kw.keyword}
                  icon={<Tag size={16} color={c.textSecondary} />}
                  label={kw.keyword}
                  count={kw.count}
                  active={isSameCategory(selectedCategory, { type: 'keyword', keyword: kw.keyword })}
                  onPress={() => select({ type: 'keyword', keyword: kw.keyword })}
                  onLongPress={() => {
                    setRenameValue(kw.keyword);
                    setRenaming(kw.keyword);
                  }}
                />
              )
            ))}
            {expanded.tags && (
              <CategoryRow
                icon={<Tag size={16} color={c.textMuted} />}
                label="No category"
                count={uncategorizedCount}
                active={selectedCategory.type === 'uncategorized'}
                onPress={() => select({ type: 'uncategorized' })}
              />
            )}
            {expanded.tags && keywords.length > 0 && (
              <Text style={styles.hint}>Long-press a tag to rename it</Text>
            )}
          </ScrollView>
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

function SectionHeader({
  label, expanded, onPress, icon,
}: {
  label: string;
  expanded: boolean;
  onPress: () => void;
  icon?: React.ReactNode;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <Pressable style={styles.sectionHeader} onPress={onPress}>
      {expanded ? (
        <ChevronDown size={14} color={c.textMuted} />
      ) : (
        <ChevronRight size={14} color={c.textMuted} />
      )}
      {icon}
      <Text style={styles.sectionHeaderText} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

function CategoryRow({
  icon, label, count, active, onPress, onLongPress, badge, muted,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  active: boolean;
  onPress: () => void;
  onLongPress?: () => void;
  badge?: string;
  muted?: boolean;
}) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      style={({ pressed }) => [
        styles.row,
        active && styles.rowActive,
        pressed && !active && styles.rowPressed,
      ]}
    >
      <View style={styles.rowIcon}>{icon}</View>
      <Text
        style={[styles.rowLabel, active && styles.rowLabelActive, muted && styles.rowLabelMuted]}
        numberOfLines={1}
      >
        {label}
      </Text>
      {!!badge && <Text style={styles.rowBadge}>{badge}</Text>}
      {count > 0 && <Text style={styles.rowCount}>{count}</Text>}
    </Pressable>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  overlayPress: { flex: 1 },
  drawer: {
    position: 'absolute',
    top: 0, bottom: 0, left: 0,
    width: '85%',
    maxWidth: 340,
    backgroundColor: c.secondary,
    borderRightWidth: 1,
    borderRightColor: c.border,
  },
  drawerSafe: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
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
  headerTitle: { ...typography.h3, color: c.text },

  scroll: { flex: 1 },
  scrollContent: { paddingBottom: spacing.md },

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.md,
    paddingBottom: 4,
  },
  sectionHeaderText: { ...typography.bodySemibold, color: c.text, flexShrink: 1 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
  },
  rowPressed: { backgroundColor: c.surfaceHover },
  rowActive: { backgroundColor: c.accent, borderLeftColor: c.primary },
  rowIcon: {
    width: 20, height: 20,
    alignItems: 'center', justifyContent: 'center',
    marginRight: spacing.sm,
  },
  rowLabel: { flex: 1, ...typography.body, color: c.text },
  rowLabelActive: { ...typography.bodySemibold, color: c.text },
  rowLabelMuted: { color: c.primary },
  rowBadge: {
    ...typography.small,
    color: c.textMuted,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.full,
    paddingHorizontal: 6,
    paddingVertical: 1,
    marginLeft: spacing.sm,
  },
  rowCount: { ...typography.caption, color: c.textMuted, marginLeft: spacing.sm },

  renameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    minHeight: 44,
    paddingHorizontal: spacing.md,
  },
  renameInput: {
    flex: 1,
    ...typography.body,
    color: c.text,
    height: componentSizes.inputHeight - 6,
    paddingHorizontal: spacing.sm,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.sm,
    backgroundColor: c.background,
  },
  renameBtn: {
    width: 28, height: 28,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.sm,
  },
  hint: { ...typography.small, color: c.textMuted, paddingHorizontal: spacing.md, paddingTop: spacing.xs },
  });
}
