import React from 'react';
import { View, Text, StyleSheet, Pressable, Modal, Animated, Easing } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X } from 'lucide-react-native';
import { spacing, radius, typography, type ThemePalette } from '../../theme/tokens';
import { useColors } from '../../theme/colors';
import { useSheetDrag } from '../../lib/use-sheet-drag';
import { useLocaleStore } from '../../stores/locale-store';

export interface ActionSheetItem {
  key: string;
  label: string;
  icon?: React.ReactNode;
  trailing?: React.ReactNode;
  destructive?: boolean;
  disabled?: boolean;
  onPress: () => void;
}

interface ActionSheetProps {
  visible: boolean;
  title: string;
  subtitle?: string;
  items: ActionSheetItem[];
  onClose: () => void;
  children?: React.ReactNode;
}

/**
 * Bottom sheet with a list of actions - the same slide-up/drag-to-dismiss
 * pattern as the reader's More sheet, reused for address and attachment
 * actions.
 */
export function ActionSheet({ visible, title, subtitle, items, onClose, children }: ActionSheetProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const insets = useSafeAreaInsets();
  const t = useLocaleStore((s) => s.t);
  const slideY = React.useRef(new Animated.Value(500)).current;
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;
  const dragHandlers = useSheetDrag({ slideY, closedY: 500, onClose });

  React.useEffect(() => {
    if (visible) {
      Animated.parallel([
        Animated.timing(slideY, { toValue: 0, duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 1, duration: 220, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideY, { toValue: 500, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: true }),
        Animated.timing(overlayOpacity, { toValue: 0, duration: 180, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, slideY, overlayOpacity]);

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[styles.overlay, { opacity: overlayOpacity }]}>
        <Pressable style={styles.overlayPress} onPress={onClose} />
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
            <View style={styles.headerText}>
              <Text style={styles.title} numberOfLines={1}>{title}</Text>
              {subtitle ? <Text style={styles.subtitle} numberOfLines={1}>{subtitle}</Text> : null}
            </View>
            <Pressable onPress={onClose} hitSlop={8} style={styles.close}
              accessibilityRole="button"
              accessibilityLabel={t('common.close', 'Close')}
            >
              <X size={18} color={c.textSecondary} />
            </Pressable>
          </View>
        </View>
        {children}
        {items.map((item) => (
          <Pressable
            key={item.key}
            onPress={item.disabled ? undefined : item.onPress}
            style={({ pressed }) => [styles.item, pressed && styles.itemPressed, item.disabled && styles.itemDisabled]}
          >
            <View style={styles.itemIcon}>{item.icon}</View>
            <Text style={[styles.itemLabel, item.destructive && styles.itemLabelDestructive]}>{item.label}</Text>
            {item.trailing}
          </Pressable>
        ))}
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
      left: 0,
      right: 0,
      bottom: 0,
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
      gap: spacing.sm,
    },
    headerText: { flex: 1, minWidth: 0 },
    title: { ...typography.bodySemibold, color: c.text },
    subtitle: { ...typography.caption, color: c.textMuted, marginTop: 2 },
    close: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', borderRadius: radius.xs },
    item: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.md,
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      minHeight: 48,
    },
    itemPressed: { backgroundColor: c.surfaceHover },
    itemDisabled: { opacity: 0.4 },
    itemIcon: { width: 20, alignItems: 'center', justifyContent: 'center' },
    itemLabel: { ...typography.body, color: c.text, flex: 1 },
    itemLabelDestructive: { color: c.error },
  });
}
