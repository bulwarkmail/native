import React from 'react';
import { View, Text, StyleSheet, Pressable, Animated, Easing } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react-native';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { useAnimDuration } from '../theme/dynamic';
import { useToastStore, type Toast } from '../stores/toast-store';
import { useLocaleStore } from '../stores/locale-store';

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

function ToastCard({ toast }: { toast: Toast }) {
  const c = useColors();
  const cardStyles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const removeToast = useToastStore((s) => s.removeToast);
  const duration = useAnimDuration(200);
  const opacity = React.useRef(new Animated.Value(0)).current;
  const translateY = React.useRef(new Animated.Value(24)).current;

  React.useEffect(() => {
    Animated.parallel([
      Animated.timing(opacity, { toValue: 1, duration, useNativeDriver: true }),
      Animated.timing(translateY, { toValue: 0, duration, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
    ]).start();
    const remaining = Math.max(0, toast.duration - (Date.now() - toast.createdAt));
    const timer = setTimeout(() => removeToast(toast.id), remaining);
    return () => clearTimeout(timer);
  }, [toast, opacity, translateY, duration, removeToast]);

  const accent = toast.type === 'success'
    ? c.success
    : toast.type === 'error'
      ? c.error
      : toast.type === 'warning'
        ? c.warning
        : c.info;
  const Icon = toast.type === 'success'
    ? CheckCircle2
    : toast.type === 'error'
      ? XCircle
      : toast.type === 'warning'
        ? AlertTriangle
        : Info;

  return (
    <Animated.View
      style={[cardStyles.card, { borderLeftColor: accent, opacity, transform: [{ translateY }] }]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
    >
      <Icon size={18} color={accent} />
      <View style={{ flex: 1 }}>
        <Text style={cardStyles.title} numberOfLines={2}>{toast.title}</Text>
        {toast.message ? <Text style={cardStyles.message} numberOfLines={3}>{toast.message}</Text> : null}
      </View>
      {toast.action ? (
        <Pressable
          onPress={() => { toast.action?.onPress(); removeToast(toast.id); }}
          hitSlop={8}
          accessibilityRole="button"
          style={({ pressed }) => [cardStyles.actionBtn, pressed && cardStyles.actionBtnPressed]}
        >
          <Text style={[cardStyles.actionText, { color: accent }]}>{toast.action.label}</Text>
        </Pressable>
      ) : null}
      <Pressable
        onPress={() => removeToast(toast.id)}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('common.dismiss', 'Dismiss')}
        style={cardStyles.close}
      >
        <X size={14} color={c.mutedForeground} />
      </Pressable>
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

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    card: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      paddingVertical: spacing.sm + 2,
      paddingLeft: spacing.md,
      paddingRight: spacing.sm,
      borderRadius: radius.md,
      borderLeftWidth: 3,
      backgroundColor: c.popover,
      borderWidth: 1,
      borderColor: c.border,
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 4 },
      elevation: 6,
    },
    title: { ...typography.bodyMedium, color: c.text },
    message: { ...typography.caption, color: c.mutedForeground, marginTop: 2 },
    actionBtn: { paddingHorizontal: spacing.sm, paddingVertical: 6, borderRadius: radius.sm },
    actionBtnPressed: { backgroundColor: c.muted },
    actionText: { ...typography.captionMedium },
    close: { padding: 4 },
  });
}
