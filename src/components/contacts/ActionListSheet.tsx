import React from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Modal, Animated, Easing, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from '../icons';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSheetDrag } from '../../lib/use-sheet-drag';
import { useLocaleStore } from '../../stores/locale-store';
import { MODAL_ORIENTATIONS } from '../../lib/modal-orientations';
import { useSheetInsets } from '../../lib/use-layout';
import { createAfterDismissQueue } from '../../lib/after-modal-dismiss';

export interface ActionListItem {
  key: string;
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  /** Drawn in the primary colour, such as "New group…". */
  primary?: boolean;
}

interface Props {
  visible: boolean;
  onClose: () => void;
  title: string;
  items: ActionListItem[];
}

/**
 * A bottom sheet with one row per action: what is done with the ticked
 * contacts, or the group they go into (webmail bulk "Add to group").
 */
export default function ActionListSheet({ visible, onClose, title, items }: Props) {
  const c = useColors();
  const t = useLocaleStore((s) => s.t);
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const insets = useSafeAreaInsets();
  const sheetInsets = useSheetInsets();
  const slideY = React.useRef(new Animated.Value(600)).current;
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;
  const dragHandlers = useSheetDrag({ slideY, closedY: 600, onClose });
  // A row may open another sheet, which iOS only shows once this one is gone.
  const afterDismiss = React.useRef(createAfterDismissQueue(Platform.OS)).current;

  React.useEffect(() => {
    Animated.parallel([
      Animated.timing(slideY, { toValue: visible ? 0 : 600, duration: visible ? 220 : 180, easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic), useNativeDriver: true }),
      Animated.timing(overlayOpacity, { toValue: visible ? 1 : 0, duration: visible ? 220 : 180, useNativeDriver: true }),
    ]).start();
  }, [visible, slideY, overlayOpacity]);

  return (
    <Modal supportedOrientations={MODAL_ORIENTATIONS} visible={visible} transparent animationType="none" onRequestClose={onClose} onDismiss={afterDismiss.flush} statusBarTranslucent>
      <Animated.View style={[styles.overlay, { opacity: overlayOpacity }]}>
        <Pressable style={{ flex: 1 }} onPress={onClose} />
      </Animated.View>
      <Animated.View
        style={[
          styles.sheet,
          { paddingBottom: Math.max(insets.bottom, spacing.md), transform: [{ translateY: slideY }], ...sheetInsets },
        ]}
      >
        <View {...dragHandlers}>
          <View style={styles.handleHit}>
            <View style={styles.handle} />
          </View>
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <Pressable
              onPress={onClose}
              hitSlop={10}
              style={styles.close}
              accessibilityRole="button"
              accessibilityLabel={t('common.close', 'Close')}
            >
              <X size={18} color={c.textSecondary} />
            </Pressable>
          </View>
        </View>
        <ScrollView>
          {items.map((item) => (
            <Pressable
              key={item.key}
              onPress={() => { onClose(); afterDismiss.run(item.onPress); }}
              accessibilityRole="button"
              style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
            >
              {item.icon}
              <Text style={[styles.rowLabel, item.primary && { color: c.primary }]} numberOfLines={1}>{item.label}</Text>
            </Pressable>
          ))}
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
  });
}
