import React from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Modal, Animated, Easing,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Inbox, Send, File as FileIcon, Trash2, Ban, Archive, Folder,
  X, Check, type LucideIcon,
} from 'lucide-react-native';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { buildMailboxTree, flattenVisible, type MailboxNode } from '../lib/mailbox-tree';
import { useSheetDrag } from '../lib/use-sheet-drag';
import type { Mailbox } from '../api/types';

function moveTargetIcon(role: string | null | undefined, name: string): LucideIcon {
  const lower = name.toLowerCase();
  if (role === 'inbox' || lower.includes('inbox')) return Inbox;
  if (role === 'sent' || lower.includes('sent')) return Send;
  if (role === 'drafts' || lower.includes('draft')) return FileIcon;
  if (role === 'trash' || lower.includes('trash') || lower.includes('deleted')) return Trash2;
  if (role === 'junk' || role === 'spam' || lower.includes('junk') || lower.includes('spam')) return Ban;
  if (role === 'archive' || lower.includes('archive')) return Archive;
  return Folder;
}

interface MoveSheetProps {
  visible: boolean;
  onClose: () => void;
  mailboxes: Mailbox[];
  /** Folder the email is currently in - shown with a check, not selectable. */
  currentMailboxId: string | null;
  onPick: (id: string) => void;
}

export function MoveSheet({
  visible, onClose, mailboxes, currentMailboxId, onPick,
}: MoveSheetProps) {
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

  const visibleNodes = React.useMemo(() => {
    const tree = buildMailboxTree(mailboxes);
    const expanded = new Set<string>();
    const collect = (nodes: MailboxNode[]) => {
      for (const n of nodes) {
        if (n.children.length > 0) {
          expanded.add(n.id);
          collect(n.children);
        }
      }
    };
    collect(tree);
    return flattenVisible(tree, expanded);
  }, [mailboxes]);

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
            <Text style={styles.sheetTitle}>Move to folder</Text>
            <Pressable onPress={onClose} hitSlop={8} style={styles.sheetClose}>
              <X size={18} color={c.textSecondary} />
            </Pressable>
          </View>
        </View>
        <ScrollView>
          {visibleNodes.map((node) => {
            const Icon = moveTargetIcon(node.role, node.name);
            const isCurrent = node.id === currentMailboxId;
            const canTarget = node.myRights?.mayAddItems !== false && !isCurrent;
            return (
              <Pressable
                key={node.id}
                onPress={canTarget ? () => onPick(node.id) : undefined}
                disabled={!canTarget}
                style={({ pressed }) => [
                  styles.moveRow,
                  pressed && canTarget && styles.moveRowPressed,
                  { paddingLeft: spacing.lg + node.depth * 16 },
                ]}
              >
                <Icon size={16} color={canTarget ? c.textSecondary : c.textMuted} />
                <Text
                  style={[styles.moveRowLabel, !canTarget && styles.moveRowLabelDisabled]}
                  numberOfLines={1}
                >
                  {node.name}
                </Text>
                {isCurrent && <Check size={14} color={c.textMuted} />}
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
      maxHeight: '75%',
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
    moveRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingRight: spacing.lg,
      paddingVertical: spacing.sm + 2,
      minHeight: 44,
    },
    moveRowPressed: { backgroundColor: c.surfaceHover },
    moveRowLabel: {
      ...typography.body,
      color: c.text,
      flex: 1,
    },
    moveRowLabelDisabled: {
      color: c.textMuted,
    },
  });
}
