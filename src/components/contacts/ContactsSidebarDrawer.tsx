import React from 'react';
import {
  View, Text, StyleSheet, Pressable, ScrollView, Modal, Animated, Dimensions, Easing,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  X, Users, Tag, BookUser, Inbox, ChevronDown, ChevronRight,
} from 'lucide-react-native';
import type { ContactCategory } from '../../stores/contacts-store';
import { useContactsStore } from '../../stores/contacts-store';
import { getContactDisplayName, getContactKeywords, isGroup } from '../../lib/contact-utils';
import { colors, spacing, radius, typography } from '../../theme/tokens';

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
  const selectedCategory = useContactsStore((s) => s.selectedCategory);
  const setSelectedCategory = useContactsStore((s) => s.setSelectedCategory);
  const contacts = useContactsStore((s) => s.contacts);
  const addressBooks = useContactsStore((s) => s.addressBooks);

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
  const groups = React.useMemo(() => contacts.filter(isGroup), [contacts]);
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

  const [expanded, setExpanded] = React.useState({
    books: true,
    groups: true,
    tags: true,
  });

  const slideX = React.useRef(new Animated.Value(-Dimensions.get('window').width)).current;
  const overlay = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(slideX, { toValue: 0, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlay, { toValue: 1, duration: 240, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideX, { toValue: -Dimensions.get('window').width, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlay, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, slideX, overlay]);

  const select = (cat: ContactCategory) => {
    setSelectedCategory(cat);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <Animated.View style={[styles.overlay, { opacity: overlay }]}>
        <Pressable style={styles.overlayPress} onPress={onClose} />
      </Animated.View>

      <Animated.View style={[styles.drawer, { transform: [{ translateX: slideX }] }]}>
        <SafeAreaView style={styles.drawerSafe} edges={['top', 'bottom', 'left']}>
          <View style={styles.header}>
            <Pressable onPress={onClose} style={styles.headerClose} hitSlop={8}>
              <X size={20} color={colors.text} />
            </Pressable>
            <Text style={styles.headerTitle}>Contacts</Text>
          </View>

          <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
            <CategoryRow
              icon={<Inbox size={16} color={colors.primary} />}
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
            {expanded.books && books.map((book) => (
              <CategoryRow
                key={book.id}
                icon={<BookUser size={16} color={colors.textSecondary} />}
                label={book.name}
                count={book.count}
                active={isSameCategory(selectedCategory, { type: 'addressBook', addressBookId: book.id })}
                onPress={() => select({ type: 'addressBook', addressBookId: book.id })}
              />
            ))}
            {expanded.books && (
              <CategoryRow
                icon={<BookUser size={16} color={colors.textMuted} />}
                label="Uncategorized"
                count={0}
                active={selectedCategory.type === 'uncategorized'}
                onPress={() => select({ type: 'uncategorized' })}
              />
            )}

            {groups.length > 0 && (
              <SectionHeader
                label="Groups"
                expanded={expanded.groups}
                onPress={() => setExpanded((e) => ({ ...e, groups: !e.groups }))}
              />
            )}
            {expanded.groups && groups.map((g) => (
              <CategoryRow
                key={g.id}
                icon={<Users size={16} color={colors.textSecondary} />}
                label={getContactDisplayName(g) || 'Group'}
                count={g.members ? Object.keys(g.members).length : 0}
                active={isSameCategory(selectedCategory, { type: 'group', groupId: g.id })}
                onPress={() => select({ type: 'group', groupId: g.id })}
              />
            ))}

            {keywords.length > 0 && (
              <SectionHeader
                label="Tags"
                expanded={expanded.tags}
                onPress={() => setExpanded((e) => ({ ...e, tags: !e.tags }))}
              />
            )}
            {expanded.tags && keywords.map((kw) => (
              <CategoryRow
                key={kw.keyword}
                icon={<Tag size={16} color={colors.textSecondary} />}
                label={kw.keyword}
                count={kw.count}
                active={isSameCategory(selectedCategory, { type: 'keyword', keyword: kw.keyword })}
                onPress={() => select({ type: 'keyword', keyword: kw.keyword })}
              />
            ))}
          </ScrollView>
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

function SectionHeader({ label, expanded, onPress }: { label: string; expanded: boolean; onPress: () => void }) {
  return (
    <Pressable style={styles.sectionHeader} onPress={onPress}>
      {expanded ? (
        <ChevronDown size={14} color={colors.textMuted} />
      ) : (
        <ChevronRight size={14} color={colors.textMuted} />
      )}
      <Text style={styles.sectionHeaderText}>{label}</Text>
    </Pressable>
  );
}

function CategoryRow({
  icon, label, count, active, onPress,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        active && styles.rowActive,
        pressed && !active && styles.rowPressed,
      ]}
    >
      <View style={styles.rowIcon}>{icon}</View>
      <Text style={[styles.rowLabel, active && styles.rowLabelActive]} numberOfLines={1}>{label}</Text>
      {count > 0 && <Text style={styles.rowCount}>{count}</Text>}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  overlayPress: { flex: 1 },
  drawer: {
    position: 'absolute',
    top: 0, bottom: 0, left: 0,
    width: '85%',
    maxWidth: 340,
    backgroundColor: '#262626',
    borderRightWidth: 1,
    borderRightColor: colors.border,
  },
  drawerSafe: { flex: 1 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  headerClose: {
    width: 36, height: 36,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.sm,
  },
  headerTitle: { ...typography.h3, color: colors.text },

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
  sectionHeaderText: { ...typography.bodySemibold, color: colors.text },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderLeftWidth: 2,
    borderLeftColor: 'transparent',
  },
  rowPressed: { backgroundColor: colors.surfaceHover },
  rowActive: { backgroundColor: colors.accent, borderLeftColor: colors.primary },
  rowIcon: {
    width: 20, height: 20,
    alignItems: 'center', justifyContent: 'center',
    marginRight: spacing.sm,
  },
  rowLabel: { flex: 1, ...typography.body, color: colors.text },
  rowLabelActive: { ...typography.bodySemibold, color: colors.text },
  rowCount: { ...typography.caption, color: colors.textMuted, marginLeft: spacing.sm },
});
