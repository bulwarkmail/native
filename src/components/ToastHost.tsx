import React from 'react';
import {
  View, Text, StyleSheet, Pressable, Animated, Easing, PanResponder, useWindowDimensions,
  type AccessibilityActionEvent, type LayoutChangeEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlertCircle, AlertTriangle, CheckCircle2, Info } from 'lucide-react-native';
import { spacing, radius, fontPx, type ThemePalette } from '../theme/tokens';
import { useColors, useResolvedTheme } from '../theme/colors';
import { useShouldAnimate } from '../theme/dynamic';
import { useToastStore, type Toast } from '../stores/toast-store';
import { useLocaleStore } from '../stores/locale-store';
import { shouldClaimToastSwipe, toastSwipeRelease } from './toast-swipe';

/**
 * Renders the toast queue above the tab bar. App.tsx gives every stack screen
 * one and only the focused screen's renders; the email undo snackbar keeps
 * its own component because it is bound to the email store's pending-undo
 * entry.
 */
export function ToastHost(): React.ReactElement | null {
  const toasts = useToastStore((s) => s.toasts);
  const insets = useSafeAreaInsets();
  if (toasts.length === 0) return null;
  return (
    <View pointerEvents="box-none" style={[styles.wrap, { bottom: insets.bottom + 64 }]}>
      {toasts.map((t) => <ToastCard key={t.id} toast={t} />)}
    </View>
  );
}

const ENTER_MS = 200;
const EXIT_MS = 160;

// Icons and text in a status colour (repos/branding/APP.md): the palette's
// error and warning fills are too light for an icon on a light ground.
const STATUS_ICON = {
  light: { error: '#dc2626', warning: '#d97706' },
  dark: { error: '#f87171', warning: '#fbbf24' },
} as const;

/**
 * The toast card from repos/branding/APP.md: a plain floating card whose icon
 * and countdown line carry the status. No close button on the phone; a
 * sideways swipe dismisses it.
 */
function ToastCard({ toast }: { toast: Toast }) {
  const c = useColors();
  const scheme = useResolvedTheme();
  const cardStyles = React.useMemo(() => makeStyles(c, scheme), [c, scheme]);
  const t = useLocaleStore((s) => s.t);
  const removeToast = useToastStore((s) => s.removeToast);
  const animate = useShouldAnimate();
  const { width: screenWidth } = useWindowDimensions();

  const opacity = React.useRef(new Animated.Value(0)).current;
  const translateY = React.useRef(new Animated.Value(24)).current;
  const translateX = React.useRef(new Animated.Value(0)).current;
  // Share of the countdown line still filled, 1 → 0.
  const remainingShare = React.useRef(new Animated.Value(1)).current;
  const cardWidth = React.useRef(0);

  React.useEffect(() => {
    const duration = animate ? ENTER_MS : 0;
    const enter = Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]);
    enter.start();
    return () => enter.stop();
  }, [animate, opacity, translateY]);

  // Leave after the toast's duration, counted from when it was queued (a
  // screen change remounts the card). The countdown line runs out with it;
  // with animations off it stays full instead of moving.
  React.useEffect(() => {
    const remaining = Math.max(0, toast.duration - (Date.now() - toast.createdAt));
    const timer = setTimeout(() => removeToast(toast.id), remaining);
    if (!animate) {
      remainingShare.setValue(1);
      return () => clearTimeout(timer);
    }
    remainingShare.setValue(toast.duration > 0 ? remaining / toast.duration : 0);
    const countdown = Animated.timing(remainingShare, {
      toValue: 0,
      duration: remaining,
      easing: Easing.linear,
      useNativeDriver: true,
    });
    countdown.start();
    return () => {
      clearTimeout(timer);
      countdown.stop();
    };
  }, [toast, animate, remainingShare, removeToast]);

  // The PanResponder is built once; its handlers read these through a ref.
  const latest = React.useRef({ animate, screenWidth, id: toast.id, removeToast });
  latest.current = { animate, screenWidth, id: toast.id, removeToast };

  const responder = React.useMemo(
    () => {
      const springBack = () => {
        if (!latest.current.animate) {
          translateX.setValue(0);
          return;
        }
        Animated.spring(translateX, { toValue: 0, useNativeDriver: true, speed: 24, bounciness: 4 }).start();
      };
      return PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, g) => shouldClaimToastSwipe(g),
        onPanResponderGrant: () => translateX.stopAnimation(),
        onPanResponderMove: (_, g) => translateX.setValue(g.dx),
        onPanResponderRelease: (_, g) => {
          const direction = toastSwipeRelease(g, cardWidth.current);
          if (direction === 0) {
            springBack();
            return;
          }
          const { animate: animated, screenWidth: width, id, removeToast: remove } = latest.current;
          Animated.timing(translateX, {
            toValue: direction * width,
            duration: animated ? EXIT_MS : 0,
            useNativeDriver: true,
          }).start(() => remove(id));
        },
        onPanResponderTerminate: springBack,
        onPanResponderTerminationRequest: () => false,
      });
    },
    [translateX],
  );

  // Fades as it is dragged away.
  const cardOpacity = React.useMemo(
    () => Animated.multiply(
      opacity,
      translateX.interpolate({
        inputRange: [-screenWidth, 0, screenWidth],
        outputRange: [0, 1, 0],
        extrapolate: 'clamp',
      }),
    ),
    [opacity, translateX, screenWidth],
  );

  const onLayout = (e: LayoutChangeEvent) => {
    cardWidth.current = e.nativeEvent.layout.width;
  };

  const statusIcon = STATUS_ICON[scheme];
  const iconColor = toast.type === 'error'
    ? statusIcon.error
    : toast.type === 'warning'
      ? statusIcon.warning
      : c.mutedForeground;
  const countdownColor = toast.type === 'error'
    ? c.error
    : toast.type === 'warning'
      ? c.warning
      : c.mutedForeground;
  const Icon = toast.type === 'success'
    ? CheckCircle2
    : toast.type === 'error'
      ? AlertCircle
      : toast.type === 'warning'
        ? AlertTriangle
        : Info;

  // Without a close button, screen readers dismiss through an action.
  const dismissActions = React.useMemo(
    () => [{ name: 'dismiss', label: t('common.dismiss', 'Dismiss') }, { name: 'escape' }],
    [t],
  );
  const onAccessibilityAction = (e: AccessibilityActionEvent) => {
    if (e.nativeEvent.actionName === 'dismiss' || e.nativeEvent.actionName === 'escape') {
      removeToast(toast.id);
    }
  };

  return (
    <Animated.View
      style={[cardStyles.shadow, { opacity: cardOpacity, transform: [{ translateY }, { translateX }] }]}
      onLayout={onLayout}
      {...responder.panHandlers}
    >
      <View style={cardStyles.card} accessibilityRole="alert" accessibilityLiveRegion="polite">
        <Icon size={18} color={iconColor} style={cardStyles.icon} />
        <View
          style={cardStyles.body}
          accessible
          accessibilityActions={dismissActions}
          onAccessibilityAction={onAccessibilityAction}
        >
          <Text style={cardStyles.title} numberOfLines={2}>{toast.title}</Text>
          {toast.message ? <Text style={cardStyles.message} numberOfLines={3}>{toast.message}</Text> : null}
        </View>
        {toast.action || toast.secondaryAction ? (
          <View style={cardStyles.actions}>
            {[toast.action, toast.secondaryAction].map((action, index) => action ? (
              <Pressable
                key={index}
                onPress={() => { action.onPress(); removeToast(toast.id); }}
                hitSlop={8}
                accessibilityRole="button"
                style={({ pressed }) => [cardStyles.action, pressed && cardStyles.actionPressed]}
              >
                {/* The underline is a border so it can sit 3px under the
                    baseline; textDecorationLine has no offset in RN. */}
                <View style={cardStyles.actionUnderline}>
                  <Text style={cardStyles.actionText} numberOfLines={1}>{action.label}</Text>
                </View>
              </Pressable>
            ) : null)}
          </View>
        ) : null}
        <View pointerEvents="none" style={cardStyles.countdownTrack} />
        <Animated.View
          pointerEvents="none"
          style={[
            cardStyles.countdownFill,
            { backgroundColor: countdownColor, transform: [{ scaleX: remainingShare }] },
          ]}
        />
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    gap: spacing.sm,
    zIndex: 60,
  },
});

const COUNTDOWN_HEIGHT = 2;

function makeStyles(c: ThemePalette, scheme: 'light' | 'dark') {
  return StyleSheet.create({
    // Carries the shadow; the card inside clips the countdown line to the
    // rounded corners, which would clip an iOS shadow on the same view.
    shadow: {
      borderRadius: radius.sm,
      backgroundColor: c.popover,
      shadowColor: '#000',
      shadowOpacity: scheme === 'dark' ? 0.4 : 0.1,
      shadowRadius: 16,
      shadowOffset: { width: 0, height: 6 },
      elevation: 6,
    },
    card: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.sm,
      paddingTop: 12,
      paddingLeft: 14,
      paddingRight: 14,
      // Room for the countdown line.
      paddingBottom: 14,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.popover,
      overflow: 'hidden',
    },
    // Centred on the title's first line.
    icon: { marginTop: 1 },
    body: { flex: 1 },
    title: { fontSize: fontPx(14.5), lineHeight: fontPx(20), fontWeight: '500', color: c.text },
    message: { fontSize: fontPx(13), lineHeight: fontPx(18), color: c.mutedForeground, marginTop: 2 },
    // One action sits beside the text; two stack so neither label is cut.
    actions: { alignSelf: 'center', alignItems: 'flex-end', gap: spacing.sm },
    action: {},
    actionPressed: { opacity: 0.6 },
    actionUnderline: { borderBottomWidth: 1, borderBottomColor: c.text },
    actionText: { fontSize: fontPx(13), lineHeight: fontPx(16), fontWeight: '600', color: c.text },
    countdownTrack: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      height: COUNTDOWN_HEIGHT,
      backgroundColor: c.text,
      opacity: 0.06,
    },
    countdownFill: {
      position: 'absolute',
      left: 0,
      right: 0,
      bottom: 0,
      height: COUNTDOWN_HEIGHT,
      opacity: 0.6,
      transformOrigin: 'left',
    },
  });
}
