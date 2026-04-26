import React, { useRef } from 'react';
import {
  View, Text, StyleSheet, Animated, PanResponder, Pressable, Dimensions,
} from 'react-native';
import {
  Archive, Trash2, ShieldAlert, MailOpen, Mail, Star,
  type LucideIcon,
} from 'lucide-react-native';
import { colors, typography } from '../theme/tokens';
import type { SwipeAction } from '../stores/settings-store';

interface SwipeableRowProps {
  children: React.ReactNode;
  /** Right-to-left swipe action (revealed under a leftward drag). */
  leftAction: SwipeAction;
  /** Left-to-right swipe action (revealed under a rightward drag). */
  rightAction: SwipeAction;
  /** Pass the row state used to compute action labels (e.g. unread/starred toggling). */
  context: { unread: boolean; starred: boolean };
  onAction: (action: SwipeAction) => void;
}

const ACTIVATION_THRESHOLD = 0.4; // fraction of row width
const DIRECTION_BIAS = 1.5;       // dx must dominate dy by this factor to claim the gesture
const MIN_DX_TO_CLAIM = 6;

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
  const dx = useRef(new Animated.Value(0)).current;
  const claimed = useRef(false);
  const widthRef = useRef(Dimensions.get('window').width);

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
        const max = widthRef.current;
        const clamped = Math.max(-max, Math.min(max, g.dx));
        dx.setValue(clamped);
      },
      onPanResponderRelease: (_, g) => {
        const threshold = widthRef.current * ACTIVATION_THRESHOLD;
        const action = g.dx > 0 ? rightAction : leftAction;
        const triggered = Math.abs(g.dx) > threshold && action !== 'none';
        if (triggered) {
          Animated.timing(dx, {
            toValue: g.dx > 0 ? widthRef.current : -widthRef.current,
            duration: 160,
            useNativeDriver: true,
          }).start(() => {
            onAction(action);
            dx.setValue(0);
          });
        } else {
          Animated.spring(dx, {
            toValue: 0,
            useNativeDriver: true,
            speed: 24,
            bounciness: 4,
          }).start();
        }
        claimed.current = false;
      },
      onPanResponderTerminate: () => {
        Animated.spring(dx, { toValue: 0, useNativeDriver: true, speed: 24, bounciness: 4 }).start();
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
    return (
      <View
        style={[
          styles.band,
          side === 'left' ? { left: 0, alignItems: 'flex-start' } : { right: 0, alignItems: 'flex-end' },
          { backgroundColor: meta.bg },
        ]}
        pointerEvents="none"
      >
        <View style={styles.bandInner}>
          <Icon size={20} color="#fff" />
          <Text style={styles.bandLabel}>{label}</Text>
        </View>
      </View>
    );
  };

  const onLayout = (e: { nativeEvent: { layout: { width: number } } }) => {
    widthRef.current = e.nativeEvent.layout.width;
  };

  return (
    <View style={styles.wrap} onLayout={onLayout} {...responder.panHandlers}>
      {renderBand(rightAction, 'left')}
      {renderBand(leftAction, 'right')}
      <Animated.View style={{ transform: [{ translateX: dx }] }}>
        {children}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'relative' },
  band: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: '100%',
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  bandInner: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  bandLabel: { color: '#fff', fontWeight: '600', ...typography.caption },
});
