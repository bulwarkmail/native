import React from 'react';
import { View, Text, StyleSheet, Pressable, Animated, Easing } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { BellRing, X } from 'lucide-react-native';
import Button from './Button';
import { spacing, radius, typography, type ThemePalette } from '../theme/tokens';
import { useColors } from '../theme/colors';
import { useAnimDuration } from '../theme/dynamic';
import { useAuthStore } from '../stores/auth-store';
import { useLocaleStore } from '../stores/locale-store';
import { useSettingsStore } from '../stores/settings-store';
import {
  DEFAULT_RELAY_BASE_URL,
  dismissPushPrompt,
  getEffectiveRelayBaseUrl,
  isPushEnabledForAccount,
  isPushSupported,
  PushSetupError,
  setStoredRelayBaseUrl,
  setupPushNotifications,
  wasPushPromptDismissed,
} from '../lib/push-notifications';

// Mirrors the webmail's push-notification-prompt: a short delay after login
// so the inbox renders first, and never again for an account once dismissed.
const PROMPT_DELAY_MS = 1500;
// Clears the tab bar, like the toasts (ToastHost).
const TAB_BAR_CLEARANCE = 64;

/**
 * Once-per-account invitation to turn on background notifications. Shown
 * only where push can actually work (Android with Play services), when the
 * user has not disabled mail notifications, and until either "Enable" or
 * "Not now" has been tapped for the active account.
 *
 * It floats above the tab bar and slides in, like the webmail's card, rather
 * than taking space at the top: arriving 1.5 s into a launch it used to push
 * the whole mail list down, and it drew under the status bar.
 */
export function PushOnboardingPrompt(): React.ReactElement | null {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const client = useAuthStore((s) => s.client);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const username = useAuthStore((s) => s.username);
  const emailNotificationsEnabled = useSettingsStore((s) => s.emailNotificationsEnabled);

  const [visible, setVisible] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const insets = useSafeAreaInsets();
  const duration = useAnimDuration(200);
  const appear = React.useRef(new Animated.Value(0)).current;

  React.useEffect(() => {
    setVisible(false);
    setError(null);
    if (!isAuthenticated || !client || !activeAccountId || !emailNotificationsEnabled) return;
    if (!isPushSupported()) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      void (async () => {
        if (await wasPushPromptDismissed(activeAccountId)) return;
        if (await isPushEnabledForAccount(activeAccountId)) return;
        if (!cancelled) setVisible(true);
      })();
    }, PROMPT_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [isAuthenticated, client, activeAccountId, emailNotificationsEnabled]);

  React.useEffect(() => {
    if (!visible) return;
    appear.setValue(0);
    Animated.timing(appear, {
      toValue: 1,
      duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible, appear, duration]);

  if (!visible || !activeAccountId) return null;

  const handleDismiss = () => {
    setVisible(false);
    void dismissPushPrompt(activeAccountId);
  };

  const handleEnable = async () => {
    setBusy(true);
    setError(null);
    try {
      const relayBaseUrl = (await getEffectiveRelayBaseUrl()) || DEFAULT_RELAY_BASE_URL;
      await setStoredRelayBaseUrl(relayBaseUrl);
      await setupPushNotifications({ relayBaseUrl, accountLabel: username ?? undefined });
      await dismissPushPrompt(activeAccountId);
      setVisible(false);
    } catch (err) {
      const message = err instanceof PushSetupError || err instanceof Error
        ? err.message
        : t('settings.notifications.push.setup_failed', 'Setup failed');
      setError(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.wrap,
        {
          bottom: insets.bottom + TAB_BAR_CLEARANCE,
          opacity: appear,
          transform: [{ translateY: appear.interpolate({ inputRange: [0, 1], outputRange: [24, 0] }) }],
        },
      ]}
    >
      <View style={styles.card} accessibilityRole="summary" accessibilityLiveRegion="polite">
        <View style={styles.iconWrap}>
          <BellRing size={18} color={c.primary} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>
            {t('push_prompt.title', 'Get notified about new mail')}
          </Text>
          <Text style={styles.body}>
            {t(
              'push_prompt.body',
              'Turn on background notifications so new messages reach you while the app is closed.',
            )}
          </Text>
          {error && <Text style={styles.error}>{error}</Text>}
          <View style={styles.actions}>
            <Button size="sm" onPress={() => void handleEnable()} loading={busy}>
              {t('push_prompt.enable', 'Enable')}
            </Button>
            <Button size="sm" variant="ghost" onPress={handleDismiss} disabled={busy}>
              {t('push_prompt.dismiss', 'Not now')}
            </Button>
          </View>
        </View>
        <Pressable
          onPress={handleDismiss}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('settings.notifications.push.dismiss_aria', 'Dismiss notification prompt')}
          style={styles.close}
        >
          <X size={16} color={c.mutedForeground} />
        </Pressable>
      </View>
    </Animated.View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    wrap: {
      position: 'absolute',
      left: spacing.md,
      right: spacing.md,
      zIndex: 50,
    },
    card: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: spacing.md,
      padding: spacing.md,
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: c.border,
      backgroundColor: c.card,
      shadowColor: '#000',
      shadowOpacity: 0.25,
      shadowRadius: 10,
      shadowOffset: { width: 0, height: 4 },
      elevation: 6,
    },
    iconWrap: {
      width: 36,
      height: 36,
      borderRadius: radius.full,
      backgroundColor: c.primaryBg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    title: { ...typography.bodyMedium, color: c.text },
    body: { ...typography.caption, color: c.mutedForeground, marginTop: 2 },
    error: { ...typography.caption, color: c.error, marginTop: spacing.xs },
    actions: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.sm },
    close: { padding: 2 },
  });
}
