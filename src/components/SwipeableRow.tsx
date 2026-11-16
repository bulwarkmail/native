import React, { useContext, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Dimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  Easing, Extrapolation, FadeIn, FadeOut, interpolate, runOnJS, useAnimatedStyle, useSharedValue, withSpring, withTiming,
} from 'react-native-reanimated';
import {
  Archive, Trash2, ShieldAlert, ShieldCheck, MailOpen, Mail, Star, Pin, PinOff, FolderInput,
  type AppIcon,
} from './icons';
import { typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { useLocaleStore } from '../stores/locale-store';
import type { SwipeAction, SwipeMode } from '../stores/settings-store';
import { haptic } from '../lib/haptics';
import {
  shouldClaimGesture, dragOffset, resolveRelease, exitsRow, releaseWouldAct, flyDuration,
  COMMIT_THRESHOLD, REVEAL_WIDTH,
  type SwipeConfig,
} from './swipe-gesture';
import { SwipeScrollLockContext } from './SwipeLockedFlatList';

interface SwipeableRowProps {
  children: React.ReactNode;
  /** Right-to-left swipe action (revealed under a leftward drag, sits at right edge). */
  leftAction: SwipeAction;
  /** Left-to-right swipe action (revealed under a rightward drag, sits at left edge). */
  rightAction: SwipeAction;
  /** Pass the row state used to compute action labels (e.g. unread/starred toggling). */
  context: SwipeContext;
  onAction: (action: SwipeAction) => void;
  /**
   * 'instant' (default): swipe past COMMIT_THRESHOLD and release fires the action.
   * 'reveal': swipe past ACTIVATION_THRESHOLD reveals an action band that must be tapped.
   */
  mode?: SwipeMode;
  appearing?: boolean;
}

export interface SwipeContext {
  unread: boolean;
  starred: boolean;
  pinned: boolean;
  /** Inside Junk the spam band flips to "Not spam" (webmail 1.7.7). */
  inJunk?: boolean;
}

// Distance the row flies off-screen by before the action callback fires.
const EXIT_DISTANCE = 600;

const ACTION_META: Record<Exclude<SwipeAction, 'none'>, { icon: AppIcon; bg: string; defaultLabel: string }> = {
  archive: { icon: Archive,      bg: '#1d4ed8', defaultLabel: 'Archive' },
  delete:  { icon: Trash2,       bg: '#b91c1c', defaultLabel: 'Delete' },
  spam:    { icon: ShieldAlert,  bg: '#a16207', defaultLabel: 'Spam' },
  read:    { icon: MailOpen,     bg: '#0f766e', defaultLabel: 'Read' },
  star:    { icon: Star,         bg: '#a16207', defaultLabel: 'Star' },
  pin:     { icon: Pin,          bg: '#7c3aed', defaultLabel: 'Pin' },
  move:    { icon: FolderInput,  bg: '#475569', defaultLabel: 'Move' },
};

type Translate = (key: string, fallback?: string) => string;

function actionLabel(action: SwipeAction, context: SwipeContext, t: Translate): string {
  switch (action) {
    case 'none': return '';
    case 'read': return context.unread ? t('context_menu.mark_read', 'Read') : t('context_menu.mark_unread', 'Unread');
    case 'star': return context.starred ? t('context_menu.unstar', 'Unstar') : t('context_menu.star', 'Star');
    case 'pin': return context.pinned ? t('context_menu.unpin', 'Unpin') : t('context_menu.pin', 'Pin');
    case 'spam': return context.inJunk ? t('context_menu.not_spam', 'Not spam') : t('email_list.swipe_spam', 'Spam');
    case 'archive': return t('context_menu.archive', 'Archive');
    case 'delete': return t('context_menu.delete', 'Delete');
    case 'move': return t('email_list.swipe_move', 'Move');
  }
}

function actionIcon(action: Exclude<SwipeAction, 'none'>, context: SwipeContext): AppIcon {
  if (action === 'spam' && context.inJunk) return ShieldCheck;
  if (action === 'read' && !context.unread) return Mail;
  if (action === 'pin' && context.pinned) return PinOff;
  return ACTION_META[action].icon;
}

function sameContext(a: SwipeContext, b: SwipeContext): boolean {
  if (a === b) return true;
  const keys = Object.keys(a) as (keyof SwipeContext)[];
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

// Props compare by identity, except `context`, which callers build per row
// and which therefore compares by its fields.
function sameRowProps(prev: SwipeableRowProps, next: SwipeableRowProps): boolean {
  const keys = Object.keys(next) as (keyof SwipeableRowProps)[];
  if (keys.length !== Object.keys(prev).length) return false;
  return keys.every((key) =>
    key === 'context' ? sameContext(prev.context, next.context) : prev[key] === next[key],
  );
}

const CLAIM_DX = 8;
const FAIL_DY = 10;
const FAR = 1e6;
const SPRING = { damping: 30, stiffness: 400, mass: 1 };
const ROW_EXIT = FadeOut.duration(150);
const ROW_ENTER = FadeIn.duration(250);
const COME_BACK_MS = 1500;

export const SwipeableRow = React.memo(function SwipeableRow({
  children, leftAction, rightAction, context, onAction, mode = 'instant', appearing = false,
}: SwipeableRowProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const tx = useSharedValue(0);
  const armed = useSharedValue(false);
  const widthRef = useRef(Dimensions.get('window').width);
  const [bandsMounted, setBandsMounted] = useState(false);
  const dragging = useRef(false);
  const scrollLock = useContext(SwipeScrollLockContext);
  const scrollLockRef = useRef(scrollLock);
  scrollLockRef.current = scrollLock;

  const latest = useRef<SwipeConfig & { onAction: (a: SwipeAction) => void }>({
    leftAction, rightAction, mode, onAction,
  });
  latest.current = { leftAction, rightAction, mode, onAction };

  const openSideRef = useRef<'left' | 'right' | null>(null);
  const [openSide, setOpenSide] = useState<'left' | 'right' | null>(null);
  const [leaving, setLeaving] = useState(false);
  const comeBackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const js = React.useMemo(() => {
    let releaseHeld: (() => void) | null = null;
    const releaseScroll = () => {
      releaseHeld?.();
      releaseHeld = null;
    };
    const unmountBandsAtRest = () => {
      if (dragging.current || openSideRef.current !== null) return;
      setBandsMounted(false);
    };
    const springTo = (toValue: number, velocity = 0) => {
      tx.value = withSpring(toValue, { ...SPRING, velocity }, (finished) => {
        if (finished && toValue === 0) runOnJS(unmountBandsAtRest)();
      });
    };
    const settle = (velocity = 0) => springTo(0, velocity);
    const close = (velocity = 0) => {
      springTo(0, velocity);
      openSideRef.current = null;
      setOpenSide(null);
    };
    const openTo = (side: 'left' | 'right', velocity = 0) => {
      springTo(side === 'right' ? REVEAL_WIDTH : -REVEAL_WIDTH, velocity);
      openSideRef.current = side;
      setOpenSide(side);
    };
    const comeBack = () => {
      comeBackTimer.current = null;
      setLeaving(false);
      springTo(0);
    };
    const afterFly = (action: SwipeAction) => {
      latest.current.onAction(action);
      if (comeBackTimer.current) clearTimeout(comeBackTimer.current);
      comeBackTimer.current = setTimeout(comeBack, COME_BACK_MS);
    };
    const fly = (toValue: number, action: SwipeAction, velocity: number) => {
      if (exitsRow(action)) {
        setLeaving(true);
        tx.value = withTiming(toValue, { duration: flyDuration(toValue - tx.value, velocity), easing: Easing.out(Easing.quad) }, () => {
          runOnJS(afterFly)(action);
        });
      } else {
        latest.current.onAction(action);
        settle(velocity * 1000);
      }
    };
    const fireFromBandTap = (action: SwipeAction) => {
      close();
      if (action === 'none') return;
      if (exitsRow(action)) {
        requestAnimationFrame(() => latest.current.onAction(action));
      } else {
        latest.current.onAction(action);
      }
    };
    const begin = () => {
      releaseScroll();
      releaseHeld = scrollLockRef.current.hold();
      dragging.current = true;
      setBandsMounted(true);
    };
    const finish = (dx: number, dy: number, vx: number) => {
      dragging.current = false;
      const outcome = resolveRelease({ dx, dy, vx }, latest.current, openSideRef.current);
      switch (outcome.kind) {
        case 'open':
          openTo(outcome.side, vx * 1000);
          break;
        case 'close':
          close(vx * 1000);
          break;
        case 'fire':
          haptic(exitsRow(outcome.action) ? 'medium' : 'light');
          fly(outcome.direction * (widthRef.current || EXIT_DISTANCE), outcome.action, vx);
          break;
        case 'settle':
          settle(vx * 1000);
          break;
      }
    };
    const cancel = () => {
      if (!dragging.current) return;
      dragging.current = false;
      if (latest.current.mode === 'reveal') close();
      else settle();
    };
    return { releaseScroll, close, fireFromBandTap, begin, finish, cancel };
  }, [tx]);
  const { releaseScroll, close, fireFromBandTap, begin, finish, cancel } = js;
  useEffect(() => releaseScroll, []);
  useEffect(() => () => {
    if (comeBackTimer.current) clearTimeout(comeBackTimer.current);
  }, []);

  const pan = React.useMemo(() => {
    const config: SwipeConfig = { leftAction, rightAction, mode };
    const side = openSide;
    const claims = (dx: number) => shouldClaimGesture({ dx, dy: 0, vx: 0 }, config, side);
    return Gesture.Pan()
      .activeOffsetX([claims(-CLAIM_DX) ? -CLAIM_DX : -FAR, claims(CLAIM_DX) ? CLAIM_DX : FAR])
      .failOffsetY([-FAIL_DY, FAIL_DY])
      .onStart(() => {
        armed.value = releaseWouldAct(tx.value, config, side);
        runOnJS(begin)();
      })
      .onUpdate((e) => {
        const next = dragOffset({ dx: e.translationX, dy: e.translationY, vx: 0 }, config, side);
        tx.value = next;
        const nowArmed = releaseWouldAct(next, config, side);
        if (nowArmed !== armed.value) {
          armed.value = nowArmed;
          if (nowArmed) runOnJS(haptic)('selection');
        }
      })
      .onEnd((e, success) => {
        if (success) runOnJS(finish)(e.translationX, e.translationY, e.velocityX / 1000);
        else runOnJS(cancel)();
      })
      .onFinalize(() => {
        runOnJS(releaseScroll)();
      });
  }, [leftAction, rightAction, mode, openSide, tx, armed, begin, finish, cancel, releaseScroll]);

  const contentStyle = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }] }));
  const leftBandStyle = useAnimatedStyle(() => ({
    opacity: interpolate(tx.value, [-1, 0, 1], [0, 0, 1], Extrapolation.CLAMP),
  }));
  const rightBandStyle = useAnimatedStyle(() => ({
    opacity: interpolate(tx.value, [-1, 0, 1], [1, 0, 0], Extrapolation.CLAMP),
  }));
  const leftIconStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(tx.value, [0, COMMIT_THRESHOLD], [0.85, 1.15], Extrapolation.CLAMP) }],
  }));
  const rightIconStyle = useAnimatedStyle(() => ({
    transform: [{ scale: interpolate(tx.value, [-COMMIT_THRESHOLD, 0], [1.15, 0.85], Extrapolation.CLAMP) }],
  }));

  const onLayout = (e: { nativeEvent: { layout: { width: number } } }) => {
    widthRef.current = e.nativeEvent.layout.width;
  };

  if (mode === 'reveal') {
    const renderRevealBand = (action: SwipeAction, side: 'left' | 'right') => {
      if (action === 'none') return null;
      const meta = ACTION_META[action];
      const Icon = actionIcon(action, context);
      const label = actionLabel(action, context, t);
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
      <GestureDetector gesture={pan}>
        <Animated.View
          style={styles.wrap}
          onLayout={onLayout}
          entering={appearing ? ROW_ENTER : undefined}
          exiting={leaving ? ROW_EXIT : undefined}
        >
          {bandsMounted ? renderRevealBand(rightAction, 'left') : null}
          {bandsMounted ? renderRevealBand(leftAction, 'right') : null}
          <Animated.View style={[styles.content, contentStyle]}>
            {children}
            {openSide ? (
              <Pressable
                style={StyleSheet.absoluteFill}
                onPress={() => close()}
              />
            ) : null}
          </Animated.View>
        </Animated.View>
      </GestureDetector>
    );
  }

  const renderInstantBand = (action: SwipeAction, side: 'left' | 'right') => {
    if (action === 'none') return null;
    const meta = ACTION_META[action];
    const Icon = actionIcon(action, context);
    const label = actionLabel(action, context, t);
    return (
      <View
        style={[
          styles.bandInstant,
          { backgroundColor: meta.bg },
          side === 'left' ? { justifyContent: 'flex-start' } : { justifyContent: 'flex-end' },
        ]}
      >
        <Animated.View style={[styles.bandInner, side === 'left' ? leftIconStyle : rightIconStyle]}>
          <Icon size={22} color="#fff" />
          <Text style={styles.bandLabel}>{label}</Text>
        </Animated.View>
      </View>
    );
  };

  return (
    <GestureDetector gesture={pan}>
      <Animated.View
        style={styles.wrap}
        onLayout={onLayout}
        entering={appearing ? ROW_ENTER : undefined}
        exiting={leaving ? ROW_EXIT : undefined}
      >
        {bandsMounted ? (
          <Animated.View style={[StyleSheet.absoluteFill, leftBandStyle]} pointerEvents="none">
            {renderInstantBand(rightAction, 'left')}
          </Animated.View>
        ) : null}
        {bandsMounted ? (
          <Animated.View style={[StyleSheet.absoluteFill, rightBandStyle]} pointerEvents="none">
            {renderInstantBand(leftAction, 'right')}
          </Animated.View>
        ) : null}
        <Animated.View style={[styles.content, contentStyle]}>
          {children}
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}, sameRowProps);

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
