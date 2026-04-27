import React from 'react';
import {
  View, Text, StyleSheet, Pressable, Modal, TextInput, FlatList,
  Animated, Dimensions, Easing,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Search, X, Check } from 'lucide-react-native';
import type { ContactCard } from '../../api/types';
import {
  useContactsStore,
  sortContactsByDisplayName,
} from '../../stores/contacts-store';
import { matchesContactSearch, isGroup } from '../../lib/contact-utils';
import ContactListRow from './ContactListRow';
import { useSheetDrag } from '../../lib/use-sheet-drag';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';

interface Props {
  visible: boolean;
  onClose: () => void;
  onSelect: (ids: string[]) => void;
  title?: string;
  excludedIds?: Set<string>;
  multi?: boolean;
}

export default function ContactPickerSheet({
  visible, onClose, onSelect, title = 'Add Contact', excludedIds, multi = true,
}: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const allContacts = useContactsStore((s) => s.contacts);
  const sorted = React.useMemo(
    () => sortContactsByDisplayName(allContacts.filter((contact) => !isGroup(contact))),
    [allContacts],
  );
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState<Set<string>>(new Set());

  const slideY = React.useRef(new Animated.Value(Dimensions.get('window').height)).current;
  const overlay = React.useRef(new Animated.Value(0)).current;
  const dragHandlers = useSheetDrag({
    slideY,
    closedY: Dimensions.get('window').height,
    onClose,
  });

  React.useEffect(() => {
    if (visible) {
      setSelected(new Set());
      setQuery('');
      Animated.parallel([
        Animated.timing(slideY, { toValue: 0, duration: 240, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlay, { toValue: 1, duration: 240, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideY, { toValue: Dimensions.get('window').height, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlay, { toValue: 0, duration: 200, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, slideY, overlay]);

  const filtered = React.useMemo(
    () => sorted.filter((c) => {
      if (excludedIds?.has(c.id)) return false;
      if (!query) return true;
      return matchesContactSearch(c, query);
    }),
    [sorted, query, excludedIds],
  );

  const toggle = (c: ContactCard) => {
    if (!multi) {
      onSelect([c.id]);
      onClose();
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(c.id)) next.delete(c.id);
      else next.add(c.id);
      return next;
    });
  };

  const confirm = () => {
    if (selected.size === 0) return;
    onSelect(Array.from(selected));
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="none" statusBarTranslucent onRequestClose={onClose}>
      <Animated.View style={[styles.overlay, { opacity: overlay }]}>
        <Pressable style={styles.overlayPress} onPress={onClose} />
      </Animated.View>

      <Animated.View style={[styles.sheet, { transform: [{ translateY: slideY }] }]}>
        <SafeAreaView style={{ flex: 1 }} edges={['bottom']}>
          <View {...dragHandlers}>
            <View style={styles.handleHit}>
              <View style={styles.handle} />
            </View>
            <View style={styles.header}>
              <Pressable onPress={onClose} style={styles.headerBtn} hitSlop={8}>
                <X size={20} color={c.text} />
              </Pressable>
              <Text style={styles.headerTitle}>{title}</Text>
              {multi && (
                <Pressable
                  onPress={confirm}
                  disabled={selected.size === 0}
                  style={[styles.doneBtn, selected.size === 0 && styles.doneBtnDisabled]}
                  hitSlop={8}
                >
                  <Text style={styles.doneLabel}>Add{selected.size > 0 ? ` (${selected.size})` : ''}</Text>
                </Pressable>
              )}
            </View>
          </View>

          <View style={styles.searchBar}>
            <Search size={16} color={c.textMuted} />
            <TextInput
              style={styles.searchInput}
              placeholder="Search contacts..."
              placeholderTextColor={c.textMuted}
              value={query}
              onChangeText={setQuery}
              autoFocus
            />
            {query.length > 0 && (
              <Pressable onPress={() => setQuery('')} hitSlop={8}>
                <X size={16} color={c.textMuted} />
              </Pressable>
            )}
          </View>

          <FlatList
            data={filtered}
            keyExtractor={(c) => c.id}
            renderItem={({ item }) => (
              <ContactListRow
                contact={item}
                onPress={() => toggle(item)}
                selected={selected.has(item.id)}
                selectionMode={multi}
              />
            )}
            ItemSeparatorComponent={() => <View style={styles.separator} />}
            ListEmptyComponent={
              <View style={styles.empty}>
                <Text style={styles.emptyText}>No contacts match</Text>
              </View>
            }
            keyboardShouldPersistTaps="handled"
          />
        </SafeAreaView>
      </Animated.View>
    </Modal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  overlayPress: { flex: 1 },
  sheet: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    top: '15%',
    backgroundColor: c.background,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
  },
  handleHit: {
    alignItems: 'center',
    paddingTop: spacing.sm,
    paddingBottom: spacing.xs,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: c.border,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    gap: spacing.xs,
    borderBottomWidth: 1,
    borderBottomColor: c.borderLight,
  },
  headerBtn: {
    width: 40, height: 40,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.full,
  },
  headerTitle: { ...typography.h3, color: c.text, flex: 1, marginLeft: spacing.xs },
  doneBtn: {
    paddingHorizontal: spacing.md,
    height: 36,
    justifyContent: 'center',
    backgroundColor: c.primary,
    borderRadius: radius.full,
  },
  doneBtnDisabled: { opacity: 0.5 },
  doneLabel: { ...typography.bodyMedium, color: c.primaryForeground },

  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: spacing.lg,
    marginVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    height: componentSizes.inputHeight,
    borderWidth: 1,
    borderColor: c.border,
    borderRadius: radius.sm,
    gap: spacing.sm,
  },
  searchInput: { flex: 1, ...typography.body, color: c.text, paddingVertical: 0 },

  separator: { height: 1, backgroundColor: c.borderLight, marginLeft: 68 },

  empty: { paddingVertical: spacing.xxxl, alignItems: 'center' },
  emptyText: { ...typography.body, color: c.textMuted },
  });
}
