import React from 'react';
import {
  View, Text, StyleSheet, ScrollView, Pressable, Modal, Animated, Easing, TextInput,
} from 'react-native';
import {
  Inbox, Send, File as FileIcon, Trash2, Ban, Archive, Folder,
  X, Check, type AppIcon,
} from './icons';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { buildMailboxTree, flattenVisible, type MailboxNode } from '../lib/mailbox-tree';
import { useSheetDrag } from '../lib/use-sheet-drag';
import { useLocaleStore } from '../stores/locale-store';
import { localizeMailboxName } from '../lib/mailbox-label';
import { mailboxIconKind, type MailboxIconKind } from '../lib/mailbox-icon';
import type { Mailbox } from '../api/types';
import { MODAL_ORIENTATIONS } from '../lib/modal-orientations';
import { useSheetInsets } from '../lib/use-layout';
import { useSheetBottomInset } from '../lib/sheet-bottom-inset';
import {
  filterTree, loadRecentMoveTargets, MOVE_FILTER_THRESHOLD, MOVE_RECENT_SHOWN, noteMoveTarget, readRecentMoveTargets,
} from '../lib/move-recent';
import { useAuthStore } from '../stores/auth-store';

// By role only, like the sidebar (mailboxIconKind, #1235): a user folder
// named "web/sentry" is not the Sent folder.
const MOVE_TARGET_ICONS: Partial<Record<MailboxIconKind, AppIcon>> = {
  inbox: Inbox,
  sent: Send,
  drafts: FileIcon,
  trash: Trash2,
  junk: Ban,
  archive: Archive,
};

function moveTargetIcon(role: string | null | undefined): AppIcon {
  return MOVE_TARGET_ICONS[mailboxIconKind(role, false, false)] ?? Folder;
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
  const t = useLocaleStore((s) => s.t);
  // Above the taskbar, and above the keyboard while "Find a folder" is typed in.
  const bottomInset = useSheetBottomInset(visible);
  const slideY = React.useRef(new Animated.Value(500)).current;
  // Centred on a wide window, clear of side insets in landscape.
  const sheetInsets = useSheetInsets();
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

  // A filter field on a long list and the recent folders first (webmail
  // move-target-list.tsx, 56e833fe6). Recents are kept per signed-in account.
  const accountKey = useAuthStore((s) => s.activeAccountId);
  const [query, setQuery] = React.useState('');
  const [recentIds, setRecentIds] = React.useState<string[]>([]);
  React.useEffect(() => {
    if (!visible) {
      setQuery('');
      return;
    }
    let live = true;
    setRecentIds(readRecentMoveTargets(accountKey));
    void loadRecentMoveTargets().then(() => { if (live) setRecentIds(readRecentMoveTargets(accountKey)); });
    return () => { live = false; };
  }, [visible, accountKey]);
  const showFilter = mailboxes.length > MOVE_FILTER_THRESHOLD;
  const filtering = query.trim().length > 0;
  const canTarget = (node: Pick<MailboxNode, 'id' | 'isAccountNode' | 'myRights' | 'role'>) =>
    // A shared account's header is a grouping row, not a folder, and Drafts
    // is never a move target (the webmail excludes it too).
    !node.isAccountNode && node.myRights?.mayAddItems !== false && node.id !== currentMailboxId
    && node.role !== 'drafts';
  const recent = React.useMemo(
    () => recentIds
      .map((id) => mailboxes.find((m) => m.id === id))
      .filter((m): m is Mailbox => !!m && canTarget(m))
      .slice(0, MOVE_RECENT_SHOWN),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [recentIds, mailboxes, currentMailboxId],
  );
  const pick = (id: string) => {
    noteMoveTarget(accountKey, id);
    onPick(id);
  };

  const visibleNodes = React.useMemo(() => {
    const tree = filterTree(
      buildMailboxTree(mailboxes),
      query,
      (n) => (n.isAccountNode ? n.name : localizeMailboxName(n.role, n.name, t)),
    );
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
  }, [mailboxes, query, t]);

  return (
    <Modal supportedOrientations={MODAL_ORIENTATIONS} visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View style={[styles.sheetOverlay, { opacity: overlayOpacity }]}>
        <Pressable style={styles.sheetOverlayPress} onPress={onClose} />
      </Animated.View>
      <Animated.View
        style={[
          styles.sheet,
          { paddingBottom: Math.max(bottomInset, spacing.md), transform: [{ translateY: slideY }], ...sheetInsets },
        ]}
      >
        <View {...dragHandlers}>
          <View style={styles.sheetHandleHit}>
            <View style={styles.sheetHandle} />
          </View>
          <View style={styles.sheetHeader}>
            <Text style={styles.sheetTitle}>{t('context_menu.move_to', 'Move to folder')}</Text>
            <Pressable onPress={onClose} hitSlop={10} style={styles.sheetClose}
              accessibilityRole="button"
              accessibilityLabel={t('common.close', 'Close')}
            >
              <X size={18} color={c.textSecondary} />
            </Pressable>
          </View>
        </View>
        {showFilter && (
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder={t('menuMove.filter_placeholder', 'Find a folder')}
            placeholderTextColor={c.textMuted}
            accessibilityLabel={t('menuMove.filter_placeholder', 'Find a folder')}
            autoCorrect={false}
            autoCapitalize="none"
            style={styles.filterInput}
            testID="move-filter"
          />
        )}
        <ScrollView keyboardShouldPersistTaps="handled">
          {!filtering && recent.length > 0 && (
            <>
              <Text style={styles.sectionLabel}>{t('menuMove.recent', 'Recent')}</Text>
              {recent.map((m) => {
                const Icon = moveTargetIcon(m.role);
                return (
                  <Pressable
                    key={`recent-${m.id}`}
                    onPress={() => pick(m.id)}
                    style={({ pressed }) => [styles.moveRow, pressed && styles.moveRowPressed, { paddingLeft: spacing.lg }]}
                    testID={`move-recent:${m.id}`}
                  >
                    <Icon size={16} color={c.textSecondary} />
                    <Text style={styles.moveRowLabel} numberOfLines={1}>{localizeMailboxName(m.role, m.name, t)}</Text>
                  </Pressable>
                );
              })}
              <View style={styles.sectionDivider} />
            </>
          )}
          {filtering && visibleNodes.length === 0 && (
            <Text style={styles.sectionLabel}>{t('menuMove.no_match', 'No folder matches')}</Text>
          )}
          {visibleNodes.map((node) => {
            const Icon = moveTargetIcon(node.role);
            const isCurrent = node.id === currentMailboxId;
            const targetable = canTarget(node);
            return (
              <Pressable
                key={node.id}
                onPress={targetable ? () => pick(node.id) : undefined}
                disabled={!targetable}
                style={({ pressed }) => [
                  styles.moveRow,
                  pressed && targetable && styles.moveRowPressed,
                  { paddingLeft: spacing.lg + node.depth * 16 },
                ]}
              >
                <Icon size={16} color={targetable ? c.textSecondary : c.textMuted} />
                <Text
                  style={[styles.moveRowLabel, !targetable && styles.moveRowLabelDisabled]}
                  numberOfLines={1}
                >
                  {node.isAccountNode ? node.name : localizeMailboxName(node.role, node.name, t)}
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
    filterInput: {
      ...typography.body,
      color: c.text,
      marginHorizontal: spacing.lg,
      marginVertical: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderWidth: 1,
      borderColor: c.border,
      borderRadius: radius.sm,
    },
    sectionLabel: {
      ...typography.caption,
      color: c.textMuted,
      paddingHorizontal: spacing.lg,
      paddingTop: spacing.sm,
      paddingBottom: spacing.xs,
    },
    sectionDivider: {
      height: 1,
      backgroundColor: c.border,
      marginVertical: spacing.xs,
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
