import React from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Modal, Animated, Easing,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Check, Mail } from 'lucide-react-native';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { useSheetDrag } from '../lib/use-sheet-drag';
import type { Identity } from '../api/types';
import { useLocaleStore } from '../stores/locale-store';

interface IdentitySheetProps {
  visible: boolean;
  onClose: () => void;
  identities: Identity[];
  selectedIdentityId: string | null;
  onPick: (identity: Identity) => void;
}

export function IdentitySheet({
  visible, onClose, identities, selectedIdentityId, onPick,
}: IdentitySheetProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const insets = useSafeAreaInsets();
  const slideY = React.useRef(new Animated.Value(500)).current;
  const overlayOpacity = React.useRef(new Animated.Value(0)).current;
  const dragHandlers = useSheetDrag({ slideY, closedY: 500, onClose });
  const { t } = useLocaleStore();

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
      <Animated.View style={[styles.sheetOverlay, { opacity: overlayOpacity }]}>
        <Pressable style={styles.sheetOverlayPress} onPress={onClose} />
      </Animated.View>
      <Animated.View
        style={[
          styles.sheet,
          { paddingBottom: Math.max(insets.bottom, spacing.md), transform: [{ translateY: slideY }] },
        ]}
      >
        <View {...dragHandlers}>
          <View style={styles.sheetHandleHit}>
            <View style={styles.sheetHandle} />
          </View>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{t('email_composer.from', 'From')}</Text>
            <Pressable onPress={onClose} hitSlop={8} style={styles.sheetClose}>
              <X size={18} color={c.textSecondary} />
            </Pressable>
          </View>
        </View>
        <ScrollView style={styles.scrollList}>
          {identities.map((identity) => {
            const isSelected = identity.id === selectedIdentityId;
            return (
              <Pressable
                key={identity.id}
                onPress={() => {
                  onPick(identity);
                  onClose();
                }}
                style={({ pressed }) => [
                  styles.identityRow,
                  pressed && styles.identityRowPressed,
                ]}
              >
                <View style={styles.iconWrap}>
                  <Mail size={16} color={isSelected ? c.primary : c.textSecondary} />
                </View>
                <View style={styles.identityDetails}>
                  {!!identity.name && (
                    <Text style={styles.identityName} numberOfLines={1}>
                      {identity.name}
                    </Text>
                  )}
                  <Text style={[styles.identityEmail, !identity.name && styles.identityEmailOnly]} numberOfLines={1}>
                    {identity.email}
                  </Text>
                </View>
                {isSelected && (
                  <View style={styles.checkWrap}>
                    <Check size={16} color={c.primary} />
                  </View>
                )}
              </Pressable>
            );
          })}
        </ScrollView>
      </Animated.View>
    </Modal>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    sheetOverlay: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: 'rgba(0,0,0,0.5)',
    },
    sheetOverlayPress: { flex: 1 },
    sheet: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      maxHeight: '60%',
      backgroundColor: c.popover,
      borderTopLeftRadius: radius.lg,
      borderTopRightRadius: radius.lg,
      borderTopWidth: 1,
      borderColor: c.border,
      paddingTop: spacing.sm,
    },
    sheetHandleHit: {
      alignItems: 'center',
      paddingTop: spacing.xs,
      paddingBottom: spacing.sm,
    },
    sheetHandle: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: c.border,
    },
    sheetHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: spacing.lg,
      paddingBottom: spacing.sm,
      borderBottomWidth: 1,
      borderBottomColor: c.border,
    },
    sheetTitle: {
      ...typography.bodySemibold,
      color: c.text,
    },
    sheetClose: {
      width: 28,
      height: 28,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.xs,
    },
    scrollList: {
      paddingVertical: spacing.xs,
    },
    identityRow: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: spacing.lg,
      paddingVertical: spacing.md,
      minHeight: 52,
    },
    identityRowPressed: {
      backgroundColor: c.surfaceHover,
    },
    iconWrap: {
      marginRight: spacing.md,
      width: 28,
      height: 28,
      borderRadius: radius.xs,
      backgroundColor: c.surface,
      alignItems: 'center',
      justifyContent: 'center',
    },
    identityDetails: {
      flex: 1,
      justifyContent: 'center',
    },
    identityName: {
      ...typography.bodyMedium,
      color: c.text,
    },
    identityEmail: {
      ...typography.caption,
      color: c.textSecondary,
      marginTop: 2,
    },
    identityEmailOnly: {
      ...typography.bodyMedium,
      color: c.text,
      marginTop: 0,
    },
    checkWrap: {
      marginLeft: spacing.md,
    },
  });
}
