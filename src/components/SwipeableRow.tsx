import React, { useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Animated, PanResponder, Pressable, Dimensions,
} from 'react-native';
import {
  Archive, Trash2, ShieldAlert, MailOpen, Star, Pin, FolderInput,
  type LucideIcon,
} from 'lucide-react-native';
import { typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import type { SwipeAction, SwipeMode } from '../stores/settings-store';

interface SwipeableRowProps {
  children: React.ReactNode;
  /** Right-to-left swipe action (revealed under a leftward drag, sits at right edge). */
  leftAction: SwipeAction;
  /** Left-to-right swipe action (revealed under a rightward drag, sits at left edge). */
  rightAction: SwipeAction;
  /** Pass the row state used to compute action labels (e.g. unread/starred toggling). */
  context: { unread: boolean; starred: boolean; pinned: boolean };
  onAction: (action: SwipeAction) => void;
  /**
   * 'instant' (default): swipe past COMMIT_THRESHOLD and release fires the action.
   * 'reveal': swipe past ACTIVATION_THRESHOLD reveals an action band that must be tapped.
   */
  mode?: SwipeMode;
}

// Instant mode: distance the user must drag past on release to fire the action.
const COMMIT_THRESHOLD = 96;
// Reveal mode: drag past this on release to snap to the open (revealed) state.
const ACTIVATION_THRESHOLD = 32;
// Reveal mode: width of the action band shown when revealed.
const REVEAL_WIDTH = 88;

const DIRECTION_BIAS = 1.5;       // dx must dominate dy by this factor
const MIN_DX_TO_CLAIM = 6;
const MAX_DRAG_OVERSHOOT_INSTANT = 240;
const MAX_DRAG_OVERSHOOT_REVEAL = REVEAL_WIDTH * 1.4;
// Distance the row flies off-screen by before the action callback fires.
const EXIT_DISTANCE = 600;

const ACTION_META: Record<Exclude<SwipeAction, 'none'>, { icon: LucideIcon; bg: string; defaultLabel: string }> = {
  archive: { icon: Archive,      bg: '#1d4ed8', defaultLabel: 'Archive' },
  delete:  { icon: Trash2,       bg: '#b91c1c', defaultLabel: 'Delete' },
  spam:    { icon: ShieldAlert,  bg: '#a16207', defaultLabel: 'Spam' },
  read:    { icon: MailOpen,     bg: '#0f766e', defaultLabel: 'Read' },
  star:    { icon: Star,         bg: '#a16207', defaultLabel: 'Star' },
  pin:     { icon: Pin,          bg: '#7c3aed', defaultLabel: 'Pin' },
  move:    { icon: FolderInput,  bg: '#475569', defaultLabel: 'Move' },
};

function actionLabel(action: SwipeAction, context: { unread: boolean; starred: boolean; pinned: boolean }): string {
  if (action === 'read') return context.unread ? 'Read' : 'Unread';
  if (action === 'star') return context.starred ? 'Unstar' : 'Star';
  if (action === 'pin') return context.pinned ? 'Unpin' : 'Pin';
  if (action === 'none') return '';
  return ACTION_META[action].defaultLabel;
}

// Actions that visibly remove the row from the list (so the row should fly off
// instead of snapping back). Toggle-style actions stay in place.
function exitsRow(action: SwipeAction): boolean {
  return action === 'archive' || action === 'delete' || action === 'spam' || action === 'move';
}

export function SwipeableRow({
  children, leftAction, rightAction, context, onAction, mode = 'instant',
}: SwipeableRowProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const dx = useRef(new Animated.Value(0)).current;
  const claimed = useRef(false);
  const widthRef = useRef(Dimensions.get('window').width);

  // Reveal-mode-only state: which side (if any) is currently sitting open.
  const openSideRef = useRef<'left' | 'right' | null>(null);
  const [openSide, setOpenSide] = useState<'left' | 'right' | null>(null);

  const close = () => {
    Animated.spring(dx, { toValue: 0, useNativeDriver: true, speed: 24, bounciness: 4 }).start();
    openSideRef.current = null;
    setOpenSide(null);
  };

  const openTo = (side: 'left' | 'right') => {
    const target = side === 'right' ? REVEAL_WIDTH : -REVEAL_WIDTH;
    Animated.spring(dx, { toValue: target, useNativeDriver: true, speed: 24, bounciness: 4 }).start();
    openSideRef.current = side;
    setOpenSide(side);
  };

  const fly = (toValue: number, action: SwipeAction) => {
    // For destructive/move actions: race the row off-screen and fire the
    // action - the parent will remove the row from the list. For toggle
    // actions: fire immediately and snap back so the same row can update in
    // place.
    if (exitsRow(action)) {
      Animated.timing(dx, {
        toValue,
        duration: 180,
        useNativeDriver: true,
      }).start(() => {
        onAction(action);
        // The row is about to be removed; reset translation in case it isn't
        // (e.g. the action failed silently) so we don't leave it off-screen.
        dx.setValue(0);
      });
    } else {
      onAction(action);
      Animated.spring(dx, { toValue: 0, useNativeDriver: true, speed: 24, bounciness: 4 }).start();
    }
  };

  const fireFromBandTap = (action: SwipeAction) => {
    close();
    if (action === 'none') return;
    if (exitsRow(action)) {
      // Let the row collapse a frame, then fire so the parent's list update
      // has a clean starting point.
      requestAnimationFrame(() => onAction(action));
    } else {
      onAction(action);
    }
  };

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) => {
        if (Math.abs(g.dx) < MIN_DX_TO_CLAIM) return false;
        if (Math.abs(g.dx) < Math.abs(g.dy) * DIRECTION_BIAS) return false;
        // Reveal mode: if a side is already open, allow the gesture so the
        // user can drag it closed.
        if (mode === 'reveal' && openSideRef.current === null) {
          if (g.dx > 0 && rightAction === 'none') return false;
          if (g.dx < 0 && leftAction === 'none') return false;
        } else if (mode !== 'reveal') {
          if (g.dx > 0 && rightAction === 'none') return false;
          if (g.dx < 0 && leftAction === 'none') return false;
        }
        claimed.current = true;
        return true;
      },
      onPanResponderMove: (_, g) => {
        const overshoot = mode === 'reveal' ? MAX_DRAG_OVERSHOOT_REVEAL : MAX_DRAG_OVERSHOOT_INSTANT;
        const base =
          mode === 'reveal'
            ? openSideRef.current === 'right' ? REVEAL_WIDTH
              : openSideRef.current === 'left' ? -REVEAL_WIDTH
              : 0
            : 0;
        const next = base + g.dx;
        const clamped = Math.max(-overshoot, Math.min(overshoot, next));
        dx.setValue(clamped);
      },
      onPanResponderRelease: (_, g) => {
        claimed.current = false;
        if (mode === 'reveal') {
          const base =
            openSideRef.current === 'right' ? REVEAL_WIDTH
              : openSideRef.current === 'left' ? -REVEAL_WIDTH
              : 0;
          const finalDx = base + g.dx;
          if (finalDx > ACTIVATION_THRESHOLD && rightAction !== 'none') {
            openTo('right');
          } else if (finalDx < -ACTIVATION_THRESHOLD && leftAction !== 'none') {
            openTo('left');
          } else {
            close();
          }
          return;
        }
        // Instant mode: fire on release-past-threshold, no second tap.
        if (g.dx >= COMMIT_THRESHOLD && rightAction !== 'none') {
          fly(widthRef.current || EXIT_DISTANCE, rightAction);
        } else if (g.dx <= -COMMIT_THRESHOLD && leftAction !== 'none') {
          fly(-(widthRef.current || EXIT_DISTANCE), leftAction);
        } else {
          Animated.spring(dx, { toValue: 0, useNativeDriver: true, speed: 24, bounciness: 4 }).start();
        }
      },
      onPanResponderTerminate: () => {
        if (mode === 'reveal') close();
        else Animated.spring(dx, { toValue: 0, useNativeDriver: true, speed: 24, bounciness: 4 }).start();
        claimed.current = false;
      },
      onPanResponderTerminationRequest: () => !claimed.current,
    }),
  ).current;

  const onLayout = (e: { nativeEvent: { layout: { width: number } } }) => {
    widthRef.current = e.nativeEvent.layout.width;
  };

  if (mode === 'reveal') {
    // Reveal mode: bands sit at the row edges with a fixed REVEAL_WIDTH and
    // are tap targets. The row slides over them; releasing past the activation
    // threshold snaps the row to the open position so the band is fully
    // visible and tappable.
    const renderRevealBand = (action: SwipeAction, side: 'left' | 'right') => {
      if (action === 'none') return null;
      const meta = ACTION_META[action];
      const Icon = meta.icon;
      const label = actionLabel(action, context);
      return (
        <Pressable
          onPress={() => fireFromBandTap(action)}
          style={[
            styles.bandReveal,
            side === 'left' ? { left: 0, alignItems: 'flex-start' } : { right: 0, alignItems: 'flex-end' },
            { backgroundColor: meta.bg, width: REVEAL_WIDTH },
          ]}
        >
          <View style={styles.bandInner}>
            <Icon size={20} color="#fff" />
            <Text style={styles.bandLabel}>{label}</Text>
          </View>
        </Pressable>
      );
    };

    return (
      <View style={styles.wrap} onLayout={onLayout} {...responder.panHandlers}>
        {renderRevealBand(rightAction, 'left')}
        {renderRevealBand(leftAction, 'right')}
        <Animated.View style={[styles.content, { transform: [{ translateX: dx }] }]}>
          {children}
          {/* When an action is revealed, an overlay absorbs taps on the row so
              a tap closes the swipe instead of opening the email. */}
          {openSide ? (
            <Pressable
              style={StyleSheet.absoluteFill}
              onPress={close}
            />
          ) : null}
        </Animated.View>
      </View>
    );
  }

  // Instant mode: bands fill the gap behind the row as it's dragged.
  const renderInstantBand = (action: SwipeAction, side: 'left' | 'right') => {
    if (action === 'none') return null;
    const meta = ACTION_META[action];
    const Icon = meta.icon;
    const label = actionLabel(action, context);
    const inputRange = side === 'left' ? [0, COMMIT_THRESHOLD] : [-COMMIT_THRESHOLD, 0];
    const iconScale = dx.interpolate({
      inputRange,
      outputRange: side === 'left' ? [0.85, 1.15] : [1.15, 0.85],
      extrapolate: 'clamp',
    });
    return (
      <View
        style={[
          styles.bandInstant,
          { backgroundColor: meta.bg },
          side === 'left' ? { justifyContent: 'flex-start' } : { justifyContent: 'flex-end' },
        ]}
      >
        <Animated.View style={[styles.bandInner, { transform: [{ scale: iconScale }] }]}>
          <Icon size={22} color="#fff" />
          <Text style={styles.bandLabel}>{label}</Text>
        </Animated.View>
      </View>
    );
  };

  const rightBandOpacity = dx.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: [0, 0, 1],
    extrapolate: 'clamp',
  });
  const leftBandOpacity = dx.interpolate({
    inputRange: [-1, 0, 1],
    outputRange: [1, 0, 0],
    extrapolate: 'clamp',
  });

  return (
    <View style={styles.wrap} onLayout={onLayout} {...responder.panHandlers}>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: rightBandOpacity }]} pointerEvents="none">
        {renderInstantBand(rightAction, 'left')}
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: leftBandOpacity }]} pointerEvents="none">
        {renderInstantBand(leftAction, 'right')}
      </Animated.View>
      <Animated.View style={[styles.content, { transform: [{ translateX: dx }] }]}>
        {children}
      </Animated.View>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    wrap: { position: 'relative', backgroundColor: c.background, overflow: 'hidden' },
    content: { backgroundColor: c.background },
    bandInstant: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 24,
    },
    bandReveal: {
      position: 'absolute',
      top: 0,
      bottom: 0,
      justifyContent: 'center',
      paddingHorizontal: 16,
    },
    bandInner: { alignItems: 'center', gap: 4 },
    bandLabel: { ...typography.caption, color: '#fff', fontWeight: '600' },
  });
}
