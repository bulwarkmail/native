import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { View, StyleSheet, Pressable, type PointerEvent } from 'react-native';
import { Archive, Trash2, MailOpen, Mail, Star, type AppIcon } from './icons';
import { radius, spacing, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { useLocaleStore } from '../stores/locale-store';
import { isHoverPointer, type RowHoverAction } from '../lib/row-hover-actions';
import { mouseSeen, noteMouse, rehover, subscribeMouseSeen } from '../lib/mouse-pointer';

/**
 * What a list whose rows are `RowHoverActions` adds to its FlatList. `rows`
 * is whatever the list renders.
 *
 * The system reports a pointer only when it moves. When the list moves under
 * a still one (a wheel scroll, the hovered row deleted, new mail pushing the
 * rows down) the row that was hovered would keep its buttons somewhere else
 * and the row now under the pointer would have none, so a second click on
 * the same spot opened a message instead of deleting it. After a scroll or a
 * change of rows the row under the pointer is therefore hovered afresh.
 *
 * Until a mouse shows up the list gets no props at all.
 */
export function useRowHoverList(rows: unknown) {
  const seen = useSyncExternalStore(subscribeMouseSeen, mouseSeen);

  useEffect(() => {
    if (!seen) return undefined;
    // After the rows have been laid out in their new places.
    const frame = requestAnimationFrame(rehover);
    return () => cancelAnimationFrame(frame);
  }, [rows, seen]);

  return useMemo(() => (seen ? {
    onScroll: rehover,
    scrollEventThrottle: 32,
    // Android gives a scroll bar's thumb a 48dp-wide target for a mouse and
    // takes a press there as the start of a drag, so a click on the button
    // nearest the list's edge did nothing. No scroll bar, no such target.
    showsVerticalScrollIndicator: false,
  } : {}), [seen]);
}

interface RowHoverActionsProps {
  /** The actions to show, in order; none shows nothing. */
  actions: readonly RowHoverAction[];
  unread: boolean;
  starred: boolean;
  onAction: (action: RowHoverAction) => void;
  /** The row, told whether the pointer is over it so it can show that. */
  children: (hovered: boolean) => React.ReactNode;
}

type Translate = (key: string, fallback?: string) => string;

function actionLabel(action: RowHoverAction, unread: boolean, starred: boolean, t: Translate): string {
  switch (action) {
    case 'delete': return t('context_menu.delete', 'Delete');
    case 'star': return starred ? t('context_menu.unstar', 'Unstar') : t('context_menu.star', 'Star');
    case 'read': return unread ? t('context_menu.mark_read', 'Mark as read') : t('context_menu.mark_unread', 'Mark as unread');
    case 'archive': return t('context_menu.archive', 'Archive');
  }
}

function actionIcon(action: RowHoverAction, unread: boolean): AppIcon {
  switch (action) {
    case 'delete': return Trash2;
    case 'star': return Star;
    case 'read': return unread ? MailOpen : Mail;
    case 'archive': return Archive;
  }
}

/**
 * A mail row with the webmail's quick actions over its end while a mouse
 * pointer is on it. Nothing shows for touch, so a phone is unchanged.
 *
 * Android only reports the pointer to JS with W3C pointer events on
 * (MainApplication); elsewhere the row never hears of it and stays as it is.
 */
export function RowHoverActions({ actions, unread, starred, onAction, children }: RowHoverActionsProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const [hovered, setHovered] = useState(false);

  const onPointerEnter = (event: PointerEvent) => {
    if (!isHoverPointer(event.nativeEvent.pointerType)) return;
    noteMouse();
    setHovered(true);
  };
  const onPointerLeave = () => setHovered(false);
  // The row stays hovered while there is nothing to show (rows being picked),
  // so the buttons are there as soon as there is.
  const shown = hovered && actions.length > 0;

  return (
    <View onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}>
      {children(shown)}
      {shown ? (
        <View style={styles.anchor} pointerEvents="box-none">
          <View style={styles.strip}>
            {actions.map((action) => {
              const Icon = actionIcon(action, unread);
              const filled = action === 'star' && starred;
              return (
                <Pressable
                  key={action}
                  onPress={() => onAction(action)}
                  style={({ pressed }) => [styles.button, pressed && styles.buttonPressed]}
                  accessibilityRole="button"
                  accessibilityLabel={actionLabel(action, unread, starred, t)}
                  testID={`row-hover-${action}`}
                >
                  <Icon
                    size={16}
                    color={filled ? c.starred : c.textSecondary}
                    fill={filled ? c.starred : undefined}
                  />
                </Pressable>
              );
            })}
          </View>
        </View>
      ) : null}
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    // Centred on the row's height, at its end edge.
    anchor: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      end: spacing.sm,
      justifyContent: 'center',
    },
    // Opaque, since it lies over the row's date and the end of its text. The
    // hovered row's colour: `muted`, which every theme keeps readable under
    // text (theme-contrast.test.ts); `surfaceHover` is some themes' accent.
    strip: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: c.muted,
      borderRadius: radius.md,
      paddingHorizontal: spacing.xs,
    },
    button: {
      width: 32,
      height: 32,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.sm,
    },
    buttonPressed: { opacity: 0.6 },
  });
}
