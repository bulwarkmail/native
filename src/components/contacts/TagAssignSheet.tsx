import React from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Modal, Animated, Easing, TextInput,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Tag, X, Plus } from 'lucide-react-native';
import { spacing, radius, typography, componentSizes, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSheetDrag } from '../../lib/use-sheet-drag';
import { useContactsStore, selectKeywordsUsed } from '../../stores/contacts-store';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Called with the chosen tag (existing or freshly typed). */
  onPick: (keyword: string) => void;
  title?: string;
}

export default function TagAssignSheet({
  visible, onClose, onPick, title = 'Add tag',
}: Props) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const insets = useSafeAreaInsets();
  const keywords = useContactsStore(selectKeywordsUsed);

  const [input, setInput] = React.useState('');

  const slideY = React.useRef(new Animated.Value(600)).current;
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;
  const dragHandlers = useSheetDrag({ slideY, closedY: 600, onClose });

  React.useEffect(() => {
    if (visible) {
      setInput('');
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

  const submitNew = () => {
    const kw = input.trim();
    if (!kw) return;
    onPick(kw);
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

        <View style={styles.inputRow}>
          <TextInput
            style={styles.input}
            placeholder="New tag name"
            placeholderTextColor={c.textMuted}
            value={input}
            onChangeText={setInput}
            autoCapitalize="none"
            returnKeyType="done"
            onSubmitEditing={submitNew}
          />
          <Pressable
            onPress={submitNew}
            disabled={!input.trim()}
            style={[styles.addBtn, !input.trim() && styles.addBtnDisabled]}
            hitSlop={6}
          >
            <Plus size={16} color={c.primaryForeground} />
          </Pressable>
        </View>

        <ScrollView keyboardShouldPersistTaps="handled">
          {keywords.length === 0 ? (
            <Text style={styles.empty}>No tags yet. Type one above.</Text>
          ) : (
            keywords.map((kw) => (
              <Pressable
                key={kw.keyword}
                onPress={() => onPick(kw.keyword)}
                style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
              >
                <Tag size={16} color={c.textSecondary} />
                <Text style={styles.rowLabel} numberOfLines={1}>{kw.keyword}</Text>
                <Text style={styles.rowCount}>{kw.count}</Text>
              </Pressable>
            ))
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
    inputRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.sm,
    },
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
    addBtn: {
      width: 36,
      height: 36,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: c.primary,
      borderRadius: radius.full,
    },
    addBtnDisabled: { opacity: 0.4 },
    empty: { ...typography.caption, color: c.textMuted, textAlign: 'center', paddingVertical: spacing.xl },
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
    rowCount: { ...typography.caption, color: c.textMuted },
  });
}
