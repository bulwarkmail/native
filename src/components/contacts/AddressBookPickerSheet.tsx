import React from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Modal, Animated, Easing, TextInput, Alert,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BookUser, X, Check, Plus } from 'lucide-react-native';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSheetDrag } from '../../lib/use-sheet-drag';
import { useContactsStore } from '../../stores/contacts-store';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Book the contact(s) currently live in - shown with a check, not selectable. */
  currentBookId?: string | null;
  onPick: (addressBookId: string) => void;
  title?: string;
}

export default function AddressBookPickerSheet({
  visible, onClose, currentBookId, onPick, title = 'Move to address book',
}: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const insets = useSafeAreaInsets();
  const addressBooks = useContactsStore((s) => s.addressBooks);
  const createAddressBook = useContactsStore((s) => s.createAddressBook);

  const [creating, setCreating] = React.useState(false);
  const [newName, setNewName] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  const slideY = React.useRef(new Animated.Value(600)).current;
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;
  const dragHandlers = useSheetDrag({ slideY, closedY: 600, onClose });

  React.useEffect(() => {
    if (visible) {
      setCreating(false);
      setNewName('');
      Animated.parallel([
        Animated.timing(slideY, { toValue: 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideY, { toValue: 600, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, slideY, overlayOpacity]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      const book = await createAddressBook(name);
      setCreating(false);
      setNewName('');
      onPick(book.id);
    } catch (err) {
      Alert.alert('Could not create address book', err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[styles.overlay, { opacity: overlayOpacity }]}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
      </Animated.View>
      <Animated.View
        style={[
          styles.sheet,
          { paddingBottom: Math.max(insets.bottom, spacing.md), transform: [{ translateY: slideY }] },
        ]}
      >
        <View {...dragHandlers}>
          <View style={styles.handleHit}>
            <View style={styles.handle} />
          </View>
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <Pressable onPress={onClose} hitSlop={8} style={styles.close}>
              <X size={18} color={c.textSecondary} />
            </Pressable>
          </View>
        </View>

        <ScrollView keyboardShouldPersistTaps="handled">
          {addressBooks.map((book) => {
            const isCurrent = book.id === currentBookId;
            const canWrite = book.myRights?.mayWrite !== false;
            const canTarget = canWrite && !isCurrent;
            return (
              <Pressable
                key={book.id}
                onPress={canTarget ? () => onPick(book.id) : undefined}
                disabled={!canTarget}
                style={({ pressed }) => [styles.row, pressed && canTarget && styles.rowPressed]}
              >
                <BookUser size={16} color={canTarget ? c.textSecondary : c.textMuted} />
                <Text style={[styles.rowLabel, !canTarget && styles.rowLabelDisabled]} numberOfLines={1}>
                  {book.name}
                </Text>
                {isCurrent && <Check size={14} color={c.textMuted} />}
              </Pressable>
            );
          })}

          {creating ? (
            <View style={styles.createRow}>
              <TextInput
                style={styles.createInput}
                placeholder="New address book name"
                placeholderTextColor={c.textMuted}
                value={newName}
                onChangeText={setNewName}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={() => { void handleCreate(); }}
              />
              <Pressable
                onPress={() => { void handleCreate(); }}
                disabled={!newName.trim() || busy}
                style={[styles.createBtn, (!newName.trim() || busy) && styles.createBtnDisabled]}
                hitSlop={6}
              >
                <Check size={16} color={c.primaryForeground} />
              </Pressable>
            </View>
          ) : (
            <Pressable
              onPress={() => setCreating(true)}
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              <Plus size={16} color={c.primary} />
              <Text style={[styles.rowLabel, { color: c.primary }]}>New address book…</Text>
            </Pressable>
          )}
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    overlay: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
    sheet: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      maxHeight: '75%',
      backgroundColor: c.popover,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      borderTopWidth: 1,
      borderColor: c.border,
      paddingTop: spacing.sm,
    },
    handleHit: { alignItems: 'center', paddingTop: spacing.xs, paddingBottom: spacing.sm },
    handle: { width: 36, height: 4, borderRadius: 2, backgroundColor: c.border },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    title: { ...typography.bodySemibold, color: c.text },
    close: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: radius.xs },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm + 2,
      minHeight: 44,
    },
    rowPressed: { backgroundColor: c.surfaceHover },
    rowLabel: { ...typography.body, color: c.text, flex: 1 },
    rowLabelDisabled: { color: c.textMuted },
    createRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
    createInput: {
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
    createBtn: {
      width: 36,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.primary,
      borderRadius: radius.full,
    },
    createBtnDisabled: { opacity: 0.4 },
  });
}
