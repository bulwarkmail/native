import React, { useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Animated, PanResponder, Pressable, Dimensions,
} from 'react-native';
import {
  Archive, Trash2, ShieldAlert, MailOpen, Mail, Star,
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
  context: { unread: boolean; starred: boolean };
  onAction: (action: SwipeAction) => void;
}

const REVEAL_WIDTH = 88;          // px shown when fully revealed
const ACTIVATION_THRESHOLD = 32;  // px past which release snaps open instead of closing
const DIRECTION_BIAS = 1.5;       // dx must dominate dy by this factor
const MIN_DX_TO_CLAIM = 6;
const MAX_DRAG_OVERSHOOT = REVEAL_WIDTH * 1.4;

const ACTION_META: Record<Exclude<SwipeAction, 'none'>, { icon: LucideIcon; bg: string; defaultLabel: string }> = {
  archive: { icon: Archive,      bg: '#1d4ed8', defaultLabel: 'Archive' },
  delete:  { icon: Trash2,       bg: '#b91c1c', defaultLabel: 'Delete' },
  spam:    { icon: ShieldAlert,  bg: '#a16207', defaultLabel: 'Spam' },
  read:    { icon: MailOpen,     bg: '#0f766e', defaultLabel: 'Read' },
  star:    { icon: Star,         bg: '#a16207', defaultLabel: 'Star' },
};

function actionLabel(action: SwipeAction, context: { unread: boolean; starred: boolean }): string {
  if (action === 'read') return context.unread ? 'Read' : 'Unread';
  if (action === 'star') return context.starred ? 'Unstar' : 'Star';
  if (action === 'none') return '';
  return ACTION_META[action].defaultLabel;
}

export function SwipeableRow({
  children, leftAction, rightAction, context, onAction,
}: SwipeableRowProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const dx = useRef(new Animated.Value(0)).current;
  const claimed = useRef(false);
  const widthRef = useRef(Dimensions.get('window').width);
  const openSideRef = useRef<'left' | 'right' | null>(null);
  const [openSide, setOpenSide] = useState<'left' | 'right' | null>(null);

  const close = () => {
    Animated.spring(dx, { toValue: 0, useNativeDriver: true, speed: 24, bounciness: 4 }).start();
    openSideRef.current = null;
    setOpenSide(null);
  };

  const openRight = () => {
    Animated.spring(dx, { toValue: REVEAL_WIDTH, useNativeDriver: true, speed: 24, bounciness: 4 }).start();
    openSideRef.current = 'right';
    setOpenSide('right');
  };

  const openLeft = () => {
    Animated.spring(dx, { toValue: -REVEAL_WIDTH, useNativeDriver: true, speed: 24, bounciness: 4 }).start();
    openSideRef.current = 'left';
    setOpenSide('left');
  };

  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, g) => {
        if (Math.abs(g.dx) < MIN_DX_TO_CLAIM) return false;
        if (Math.abs(g.dx) < Math.abs(g.dy) * DIRECTION_BIAS) return false;
        // If a side is already open, allow the gesture so the user can drag it closed.
        if (openSideRef.current === null) {
          if (g.dx > 0 && rightAction === 'none') return false;
          if (g.dx < 0 && leftAction === 'none') return false;
        }
        claimed.current = true;
        return true;
      },
      onPanResponderMove: (_, g) => {
        const base = openSideRef.current === 'right' ? REVEAL_WIDTH : openSideRef.current === 'left' ? -REVEAL_WIDTH : 0;
        const next = base + g.dx;
        const clamped = Math.max(-MAX_DRAG_OVERSHOOT, Math.min(MAX_DRAG_OVERSHOOT, next));
        dx.setValue(clamped);
      },
      onPanResponderRelease: (_, g) => {
        const base = openSideRef.current === 'right' ? REVEAL_WIDTH : openSideRef.current === 'left' ? -REVEAL_WIDTH : 0;
        const finalDx = base + g.dx;

        if (finalDx > ACTIVATION_THRESHOLD && rightAction !== 'none') {
          openRight();
        } else if (finalDx < -ACTIVATION_THRESHOLD && leftAction !== 'none') {
          openLeft();
        } else {
          close();
        }
        claimed.current = false;
      },
      onPanResponderTerminate: () => {
        close();
        claimed.current = false;
      },
      onPanResponderTerminationRequest: () => !claimed.current,
    }),
  ).current;

  const fireAction = (action: SwipeAction) => {
    close();
    if (action !== 'none') onAction(action);
  };

  const renderBand = (action: SwipeAction, side: 'left' | 'right') => {
    if (action === 'none') return null;
    const meta = ACTION_META[action];
    const Icon = meta.icon;
    const label = actionLabel(action, context);
    return (
      <Pressable
        onPress={() => fireAction(action)}
        style={[
          styles.band,
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

  const onLayout = (e: { nativeEvent: { layout: { width: number } } }) => {
    widthRef.current = e.nativeEvent.layout.width;
  };

  return (
    <View style={styles.wrap} onLayout={onLayout} {...responder.panHandlers}>
      {renderBand(rightAction, 'left')}
      {renderBand(leftAction, 'right')}
      <Animated.View style={[styles.content, { transform: [{ translateX: dx }] }]}>
        {children}
        {/* When an action is revealed, an overlay absorbs taps on the row so a
            tap closes the swipe instead of opening the email. */}
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

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
  wrap: { position: 'relative', backgroundColor: c.background },
  content: { backgroundColor: c.background },
  band: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    justifyContent: 'center',
    paddingHorizontal: 16,
  },
  bandInner: { alignItems: 'center', gap: 4 },
  bandLabel: { color: '#fff', fontWeight: '600', ...typography.caption },
  });
}
