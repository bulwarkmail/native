import React, { useContext, useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, Pressable, Dimensions } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation, Extrapolation, FadeIn, FadeOut, interpolate, interpolateColor, runOnJS,
  useAnimatedStyle, useSharedValue, withSpring, withTiming,
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
  dragOffset, resolveRelease, exitsRow, releaseWouldAct, nextArmedState, flyPlan, flyProgress,
  panTravel, decidePanActivation, restingOffset, armChange, releaseHaptic,
  CLAIM_DX, COMMIT_THRESHOLD, DISARM_THRESHOLD, REVEAL_WIDTH, SETTLE_SPRING,
  type SwipeConfig,
} from './swipe-gesture';
import { SwipeScrollGestureContext, SwipeScrollLockContext } from './SwipeLockedFlatList';

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

const ARM_POP = { stiffness: 550, damping: 24, mass: 1 };
const ICON_POP = 0.12;
const FILL_LIT_AT = 0.6;
const FILL_MIN_DP = 1;
const ICON_REVEAL = 48;
const BAND_PAD = 16;
const EDGE_MARGIN = 8;
const RIDE_GAP = 16;
const MUTED_TOWARD = '#6b7280';
const MUTED_MIX = 0.55;

function mixHex(from: string, to: string, amount: number): string {
  const channel = (hex: string, i: number) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
  const out = [0, 1, 2].map((i) => Math.round(channel(from, i) + (channel(to, i) - channel(from, i)) * amount));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function bandColors(action: SwipeAction): { muted: string; full: string } {
  const full = action === 'none' ? MUTED_TOWARD : ACTION_META[action].bg;
  return { muted: mixHex(full, MUTED_TOWARD, MUTED_MIX), full };
}

function bandIconStyle(offset: number, armed: number, sign: 1 | -1, contentWidth: number) {
  'worklet';
  const reach = Math.max(0, sign * offset);
  const grow = interpolate(reach, [0, COMMIT_THRESHOLD], [0.75, 1], Extrapolation.CLAMP);
  const baseScale = grow * (1 + ICON_POP * armed);
  let scale = baseScale;
  let shift = Math.min(armed, 1) * Math.max(0, reach - COMMIT_THRESHOLD);
  if (contentWidth > 0) {
    const fitWidth = Math.max(DISARM_THRESHOLD, reach) - 2 * EDGE_MARGIN;
    scale = Math.min(baseScale, fitWidth / contentWidth);
    const unshiftedCenter = BAND_PAD + contentWidth / 2;
    const halfScaled = (contentWidth * scale) / 2;
    const needed = BAND_PAD + contentWidth * (1 + ICON_POP / 2) + RIDE_GAP;
    const ride = Math.min(armed, 1) * Math.max(0, reach - Math.max(COMMIT_THRESHOLD, needed));
    const minCenter = EDGE_MARGIN + halfScaled;
    const maxCenter = reach - EDGE_MARGIN - halfScaled;
    const targetCenter = Math.max(minCenter, Math.min(unshiftedCenter + ride, maxCenter));
    shift = targetCenter - unshiftedCenter;
  }
  return {
    opacity: interpolate(reach, [0, ICON_REVEAL], [0, 1], Extrapolation.CLAMP),
    transform: [
      { translateX: sign * shift },
      { scale },
    ],
  };
}
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
  const armedProgress = useSharedValue(0);
  const armedSide = useSharedValue<0 | 1 | -1>(0);
  const startTx = useSharedValue(0);
  const downX = useSharedValue(0);
  const downY = useSharedValue(0);
  const claimX = useSharedValue(0);
  const hasClaimX = useSharedValue(false);
  const decided = useSharedValue(false);
  const rowWidth = useSharedValue(Dimensions.get('window').width || EXIT_DISTANCE);
  const started = useSharedValue(false);
  const leftIconWidth = useSharedValue(0);
  const rightIconWidth = useSharedValue(0);
  const [bandsMounted, setBandsMounted] = useState(false);
  const dragging = useRef(false);
  const touching = useRef(false);
  const scrollLock = useContext(SwipeScrollLockContext);
  const scrollGestures = useContext(SwipeScrollGestureContext);
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
      if (touching.current || dragging.current || openSideRef.current !== null) return;
      setBandsMounted(false);
    };
    const springTo = (toValue: number, velocity = 0) => {
      if (toValue === 0) {
        armed.value = false;
        armedProgress.value = withSpring(0, ARM_POP);
      }
      tx.value = withSpring(toValue, { ...SETTLE_SPRING, velocity }, (finished) => {
        if (finished && toValue === 0) {
          armedSide.value = 0;
          runOnJS(unmountBandsAtRest)();
        }
      });
    };
    const setOpen = (side: 'left' | 'right' | null) => {
      openSideRef.current = side;
      setOpenSide(side);
    };
    const close = (velocity = 0) => {
      springTo(0, velocity);
      setOpen(null);
    };
    const comeBack = () => {
      comeBackTimer.current = null;
      setLeaving(false);
      springTo(0);
    };
    const startLeaving = () => setLeaving(true);
    const afterFly = (action: SwipeAction) => {
      latest.current.onAction(action);
      if (comeBackTimer.current) clearTimeout(comeBackTimer.current);
      comeBackTimer.current = setTimeout(comeBack, COME_BACK_MS);
    };
    const fireInPlace = (action: SwipeAction) => latest.current.onAction(action);
    const fireFromBandTap = (action: SwipeAction) => {
      close();
      if (action === 'none') return;
      if (exitsRow(action)) {
        requestAnimationFrame(() => latest.current.onAction(action));
      } else {
        latest.current.onAction(action);
      }
    };
    const prepare = () => {
      touching.current = true;
      setBandsMounted(true);
    };
    const begin = () => {
      releaseScroll();
      releaseHeld = scrollLockRef.current.hold();
      touching.current = true;
      dragging.current = true;
      setBandsMounted(true);
    };
    const endDrag = () => {
      touching.current = false;
      dragging.current = false;
    };
    return {
      releaseScroll, unmountBandsAtRest, close, setOpen, startLeaving, afterFly, fireInPlace,
      fireFromBandTap, prepare, begin, endDrag,
    };
  }, [tx, armed, armedProgress, armedSide]);
  const {
    releaseScroll, unmountBandsAtRest, close, setOpen, startLeaving, afterFly, fireInPlace,
    fireFromBandTap, prepare, begin, endDrag,
  } = js;
  useEffect(() => releaseScroll, []);
  useEffect(() => () => {
    if (comeBackTimer.current) clearTimeout(comeBackTimer.current);
  }, []);

  const pan = React.useMemo(() => {
    const config: SwipeConfig = { leftAction, rightAction, mode };
    const side = openSide;
    const springBack = (toValue: number, velocity: number) => {
      'worklet';
      if (toValue === 0) {
        armed.value = false;
        armedProgress.value = withSpring(0, ARM_POP);
      }
      tx.value = withSpring(toValue, { ...SETTLE_SPRING, velocity: velocity * 1000 }, (finished) => {
        if (finished && toValue === 0) {
          armedSide.value = 0;
          runOnJS(unmountBandsAtRest)();
        }
      });
    };
    const gesture = Gesture.Pan()
      .enabled(!leaving)
      .manualActivation(true)
      .onTouchesDown((e) => {
        const touch = e.changedTouches[0];
        if (!touch) return;
        downX.value = touch.absoluteX;
        downY.value = touch.absoluteY;
        hasClaimX.value = false;
        decided.value = false;
      })
      .onTouchesMove((e, stateManager) => {
        if (decided.value) return;
        const touch = e.allTouches[0] ?? e.changedTouches[0];
        if (!touch) return;
        const dx = touch.absoluteX - downX.value;
        const dy = touch.absoluteY - downY.value;
        const verdict = decidePanActivation(dx, dy, config, side);
        if (verdict === 'activate') {
          decided.value = true;
          claimX.value = downX.value + (dx > 0 ? Math.min(dx, CLAIM_DX) : Math.max(dx, -CLAIM_DX));
          hasClaimX.value = true;
          stateManager.activate();
        } else if (verdict === 'fail') {
          decided.value = true;
          stateManager.fail();
        }
      })
      .onTouchesUp((e, stateManager) => {
        if (e.numberOfTouches === 0 && !started.value) {
          decided.value = true;
          stateManager.fail();
        }
      })
      .onTouchesCancelled((_e, stateManager) => {
        if (!started.value) {
          decided.value = true;
          stateManager.fail();
        }
      })
      .onBegin(() => {
        started.value = false;
        runOnJS(prepare)();
      })
      .onStart(() => {
        cancelAnimation(tx);
        started.value = true;
        startTx.value = tx.value;
        const alreadyArmed = releaseWouldAct(tx.value, config, side);
        armed.value = alreadyArmed;
        armedSide.value = alreadyArmed ? (tx.value > 0 ? 1 : -1) : 0;
        runOnJS(begin)();
      })
      .onUpdate((e) => {
        const travel = panTravel(e.absoluteX, claimX.value, hasClaimX.value, e.translationX);
        const next = dragOffset({ dx: travel, dy: e.translationY, vx: 0 }, config, side, startTx.value);
        tx.value = next;
        if ((armedSide.value === 1 && next <= 0) || (armedSide.value === -1 && next >= 0)) {
          armed.value = false;
          armedSide.value = 0;
          cancelAnimation(armedProgress);
          armedProgress.value = 0;
        }
        const nowArmed = nextArmedState(next, armed.value, config, side);
        if (armChange(armed.value, nowArmed)) {
          armed.value = nowArmed;
          if (nowArmed) armedSide.value = next > 0 ? 1 : -1;
          runOnJS(haptic)('selection');
          armedProgress.value = withSpring(nowArmed ? 1 : 0, ARM_POP);
        }
      })
      .onEnd((e, success) => {
        const vx = e.velocityX / 1000;
        if (!success) {
          springBack(0, 0);
          runOnJS(setOpen)(null);
          return;
        }
        const outcome = resolveRelease({ dx: tx.value - restingOffset(side), dy: e.translationY, vx }, config, side, armed.value);
        const tick = releaseHaptic(outcome, armed.value);
        if (tick) runOnJS(haptic)(tick);
        if (outcome.kind === 'fire') {
          const action = outcome.action;
          armed.value = true;
          armedSide.value = outcome.direction;
          armedProgress.value = withSpring(1, ARM_POP);
          if (exitsRow(action)) {
            const toValue = outcome.direction * rowWidth.value;
            const plan = flyPlan(toValue - tx.value, vx);
            const slope = plan.startSlope;
            tx.value = withTiming(toValue, {
              duration: plan.duration,
              easing: (u: number) => {
                'worklet';
                return flyProgress(slope, u);
              },
            }, (finished) => {
              if (finished) runOnJS(afterFly)(action);
            });
            runOnJS(startLeaving)();
          } else {
            springBack(0, vx);
            runOnJS(fireInPlace)(action);
          }
        } else if (outcome.kind === 'open') {
          springBack(outcome.side === 'right' ? REVEAL_WIDTH : -REVEAL_WIDTH, vx);
          runOnJS(setOpen)(outcome.side);
        } else {
          springBack(0, vx);
          runOnJS(setOpen)(null);
        }
      })
      .onFinalize(() => {
        hasClaimX.value = false;
        decided.value = false;
        runOnJS(endDrag)();
        runOnJS(releaseScroll)();
        if (!started.value) runOnJS(unmountBandsAtRest)();
      });
    return scrollGestures.length > 0 ? gesture.blocksExternalGesture(...scrollGestures) : gesture;
  }, [
    leftAction, rightAction, mode, openSide, leaving, scrollGestures, tx, armed, armedProgress, armedSide,
    startTx, downX, downY, claimX, hasClaimX, decided, started, rowWidth,
    prepare, begin, endDrag, setOpen, startLeaving, afterFly, fireInPlace, releaseScroll, unmountBandsAtRest,
  ]);

  const contentStyle = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }] }));
  const leftBandStyle = useAnimatedStyle(() => ({
    opacity: tx.value >= FILL_MIN_DP ? 1 : 0,
  }));
  const rightBandStyle = useAnimatedStyle(() => ({
    opacity: tx.value <= -FILL_MIN_DP ? 1 : 0,
  }));
  const leftColors = bandColors(rightAction);
  const rightColors = bandColors(leftAction);
  const hasFill = mode !== 'reveal' && (leftAction !== 'none' || rightAction !== 'none');
  const fillStyle = useAnimatedStyle(() => {
    const toRight = tx.value > 0;
    const progress = (toRight && armedSide.value === -1) || (!toRight && armedSide.value === 1) ? 0 : armedProgress.value;
    const lit = Math.min(1, Math.max(0, progress / FILL_LIT_AT));
    return {
      opacity: Math.abs(tx.value) < FILL_MIN_DP ? 0 : 1,
      backgroundColor: toRight
        ? interpolateColor(lit, [0, 1], [leftColors.muted, leftColors.full])
        : interpolateColor(lit, [0, 1], [rightColors.muted, rightColors.full]),
    };
  }, [leftColors.muted, leftColors.full, rightColors.muted, rightColors.full]);
  const leftIconStyle = useAnimatedStyle(() =>
    bandIconStyle(tx.value, armedSide.value === -1 ? 0 : armedProgress.value, 1, leftIconWidth.value),
  );
  const rightIconStyle = useAnimatedStyle(() =>
    bandIconStyle(tx.value, armedSide.value === 1 ? 0 : armedProgress.value, -1, rightIconWidth.value),
  );

  const onLayout = (e: { nativeEvent: { layout: { width: number } } }) => {
    if (e.nativeEvent.layout.width > 0) rowWidth.value = e.nativeEvent.layout.width;
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
    const Icon = actionIcon(action, context);
    const label = actionLabel(action, context, t);
    return (
      <Animated.View
        style={[
          styles.bandInstant,
          side === 'left' ? { justifyContent: 'flex-start' } : { justifyContent: 'flex-end' },
        ]}
      >
        <Animated.View
          style={[styles.bandInner, side === 'left' ? leftIconStyle : rightIconStyle]}
          onLayout={(e) => {
            const width = e.nativeEvent.layout.width;
            if (width > 0) {
              if (side === 'left') leftIconWidth.value = width;
              else rightIconWidth.value = width;
            }
          }}
        >
          <Icon size={22} color="#fff" />
          <Text style={styles.bandLabel}>{label}</Text>
        </Animated.View>
      </Animated.View>
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
        {hasFill ? <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, fillStyle]} /> : null}
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
      paddingHorizontal: BAND_PAD,
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
