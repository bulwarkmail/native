import React from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Modal, Animated, Easing,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { X, Check, Tag } from 'lucide-react-native';
import { spacing, radius, typography, colors as tokenColors, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { useSheetDrag } from '../lib/use-sheet-drag';
import { keywordToken, type KeywordDef } from '../stores/keywords-store';
import type { Email } from '../api/types';

interface TagSheetProps {
  visible: boolean;
  onClose: () => void;
  keywords: KeywordDef[];
  /** The currently-selected emails, used to show which tags are already set. */
  selectedEmails: Email[];
  /** Toggle a keyword token on/off across the whole selection. */
  onToggle: (token: string, on: boolean) => void;
}

export function TagSheet({ visible, onClose, keywords, selectedEmails, onToggle }: TagSheetProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const insets = useSafeAreaInsets();
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

  // A tag counts as "applied" only when every selected email carries it; in
  // that case tapping removes it, otherwise tapping adds it to all.
  const allHaveToken = React.useCallback(
    (token: string) =>
      selectedEmails.length > 0 && selectedEmails.every((e) => !!e.keywords?.[token]),
    [selectedEmails],
  );

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
            <Text style={styles.title}>Tag {selectedEmails.length} selected</Text>
            <Pressable onPress={onClose} hitSlop={8} style={styles.close}>
              <X size={18} color={c.textSecondary} />
            </Pressable>
          </View>
        </View>
        <ScrollView>
          {keywords.length === 0 ? (
            <Text style={styles.empty}>No tags defined. Add tags in Settings.</Text>
          ) : (
            keywords.map((kw) => {
              const token = keywordToken(kw.id);
              const applied = allHaveToken(token);
              const dot = tokenColors.tags[kw.color]?.dot ?? c.primary;
              return (
                <Pressable
                  key={kw.id}
                  onPress={() => onToggle(token, !applied)}
                  style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
                >
                  <Tag size={16} color={dot} fill={dot} />
                  <Text style={styles.rowLabel} numberOfLines={1}>{kw.label}</Text>
                  {applied && <Check size={16} color={c.primary} />}
                </Pressable>
              );
            })
          )}
        </ScrollView>
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
    empty: { ...typography.body, color: c.textMuted, padding: spacing.lg, textAlign: 'center' },
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
