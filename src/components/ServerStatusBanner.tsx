import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AlertTriangle } from './icons';
import { useColors } from '../theme/colors';
import { radius, spacing, typography, type ThemePalette } from '../theme/tokens';
import { useLocaleStore } from '../stores/locale-store';
import { useAuthStore } from '../stores/auth-store';
import { useAccountStore } from '../stores/account-store';
import { useNetworkStore } from '../stores/network-store';
import { useServerStatusStore } from '../stores/server-status-store';
import { clearRefreshBackoff } from '../lib/oauth';
import { serverHostLabel } from '../lib/account-utils';
import { jmapClient } from '../api/jmap-client';

interface ServerStatusBannerProps {
  /** Loads the list again, once a session is up. */
  onRetry: () => void;
}

/**
 * Says so when requests to the active account's server keep failing while
 * the phone is online (#167): the mail list otherwise looks normal and new
 * mail just stops coming. Offline, the offline banner says it instead.
 */
export function ServerStatusBanner({ onRetry }: ServerStatusBannerProps) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const online = useNetworkStore((s) => s.online);
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  const signInAgain = useAuthStore((s) => s.signInAgain);
  const retrySession = useAuthStore((s) => s.retrySession);
  const serverUrl = useAccountStore((s) => (activeAccountId ? s.getAccountById(activeAccountId)?.serverUrl : undefined));
  const shown = useServerStatusStore((s) => s.shown && s.accountId === activeAccountId);
  const problem = useServerStatusStore((s) => s.problem);
  if (!online || !shown || !problem || !activeAccountId) return null;

  const host = serverUrl ? serverHostLabel(serverUrl) : '';
  const text = {
    unreachable: t('server_status.unreachable', "Can't reach {host}. New mail may not arrive.", { host }),
    server_error: t('server_status.server_error', '{host} is having problems. New mail may not arrive.', { host }),
    rate_limited: t('server_status.rate_limited', '{host} is limiting requests. New mail may be late.', { host }),
    sign_in_failing: t('server_status.sign_in_failing', "Your sign-in to {host} can't be renewed. New mail won't arrive until it is.", { host }),
  }[problem];

  return (
    <View style={styles.bar} accessibilityRole="alert" accessibilityLiveRegion="polite" testID="server-status-banner">
      <AlertTriangle size={14} color={c.error} />
      <Text style={styles.text} numberOfLines={3}>{text}</Text>
      {problem === 'sign_in_failing' && (
        <Pressable onPress={() => { void signInAgain(activeAccountId); }} style={styles.button} hitSlop={6} accessibilityRole="button">
          <Text style={styles.buttonText}>{t('sidebar.account_sign_in_again', 'Sign in again')}</Text>
        </Pressable>
      )}
      <Pressable
        onPress={() => {
          clearRefreshBackoff();
          // Started while the server was failing: no session yet, so no list
          // to reload. Bring the session up instead.
          if (jmapClient.isConnected) onRetry();
          else void retrySession();
        }}
        style={styles.button}
        hitSlop={6}
        accessibilityRole="button"
      >
        <Text style={styles.buttonText}>{t('common.retry', 'Retry')}</Text>
      </Pressable>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: spacing.sm,
      marginHorizontal: spacing.lg,
      marginBottom: spacing.sm,
      paddingHorizontal: spacing.md,
      paddingVertical: spacing.sm,
      borderRadius: radius.sm,
      borderWidth: 1,
      borderColor: c.error,
    },
    text: { ...typography.caption, color: c.textSecondary, flex: 1 },
    button: { paddingHorizontal: spacing.sm, paddingVertical: 4 },
    buttonText: { ...typography.captionMedium, color: c.primary },
  });
}
