import React, { useRef } from 'react';
import {
  View, Text, StyleSheet, Animated, PanResponder, Dimensions,
} from 'react-native';
import {
  Archive, Trash2, ShieldAlert, MailOpen, Star, Pin, FolderInput,
  type LucideIcon,
} from 'lucide-react-native';
import { typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import type { SwipeAction } from '../stores/settings-store';

interface SwipeableRowProps {
  children: React.ReactNode;
  /** Right-to-left swipe action (revealed under a leftward drag, sits at right edge). */
  leftAction: SwipeAction;
  /** Left-to-right swipe action (revealed under a rightward drag, sits at left edge). */
  rightAction: SwipeAction;
  /** Pass the row state used to compute action labels (e.g. unread/starred toggling). */
  context: { unread: boolean; starred: boolean; pinned: boolean };
  onAction: (action: SwipeAction) => void;
}

// Distance (px) of horizontal travel needed to commit the action on release.
// Drag less than this and the row snaps back without firing.
const COMMIT_THRESHOLD = 96;
const DIRECTION_BIAS = 1.5;       // dx must dominate dy by this factor
const MIN_DX_TO_CLAIM = 6;
const MAX_DRAG_OVERSHOOT = 240;
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
  children, leftAction, rightAction, context, onAction,
}: SwipeableRowProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const dx = useRef(new Animated.Value(0)).current;
  const claimed = useRef(false);
  const widthRef = useRef(Dimensions.get('window').width);

  const snapBack = () => {
    Animated.spring(dx, { toValue: 0, useNativeDriver: true, speed: 24, bounciness: 4 }).start();
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
      snapBack();
    }
  };

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) => {
        if (Math.abs(g.dx) < MIN_DX_TO_CLAIM) return false;
        if (Math.abs(g.dx) < Math.abs(g.dy) * DIRECTION_BIAS) return false;
        if (g.dx > 0 && rightAction === 'none') return false;
        if (g.dx < 0 && leftAction === 'none') return false;
        claimed.current = true;
        return true;
      },
      onPanResponderMove: (_, g) => {
        const clamped = Math.max(-MAX_DRAG_OVERSHOOT, Math.min(MAX_DRAG_OVERSHOOT, g.dx));
        dx.setValue(clamped);
      },
      onPanResponderRelease: (_, g) => {
        claimed.current = false;
        if (g.dx >= COMMIT_THRESHOLD && rightAction !== 'none') {
          fly(widthRef.current || EXIT_DISTANCE, rightAction);
        } else if (g.dx <= -COMMIT_THRESHOLD && leftAction !== 'none') {
          fly(-(widthRef.current || EXIT_DISTANCE), leftAction);
        } else {
          snapBack();
        }
      },
      onPanResponderTerminate: () => {
        snapBack();
        claimed.current = false;
      },
      onPanResponderTerminationRequest: () => !claimed.current,
    }),
  ).current;

  const renderBand = (action: SwipeAction, side: 'left' | 'right') => {
    if (action === 'none') return null;
    const meta = ACTION_META[action];
    const Icon = meta.icon;
    const label = actionLabel(action, context);
    // Band stretches to fill the gap behind the row as it's dragged. We
    // animate the icon a touch to signal commit-readiness.
    const inputRange = side === 'left' ? [0, COMMIT_THRESHOLD] : [-COMMIT_THRESHOLD, 0];
    const iconScale = dx.interpolate({
      inputRange,
      outputRange: side === 'left' ? [0.85, 1.15] : [1.15, 0.85],
      extrapolate: 'clamp',
    });
    return (
      <View
        style={[
          styles.band,
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

  const onLayout = (e: { nativeEvent: { layout: { width: number } } }) => {
    widthRef.current = e.nativeEvent.layout.width;
  };

  // Show the matching band based on current drag direction. Both bands occupy
  // the full row, so we fade the inactive one out to avoid bleed-through.
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
        {renderBand(rightAction, 'left')}
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, { opacity: leftBandOpacity }]} pointerEvents="none">
        {renderBand(leftAction, 'right')}
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
  band: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 24,
  },
  bandInner: { alignItems: 'center', gap: 4 },
  bandLabel: { ...typography.caption, color: '#fff', fontWeight: '600' },
  });
}
