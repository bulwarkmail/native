import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Button from './Button';
import { KeyRound } from './icons';
import { useColors } from '../theme/colors';
import { spacing, typography, type ThemePalette } from '../theme/tokens';
import { useLocaleStore } from '../stores/locale-store';
import { useAuthStore } from '../stores/auth-store';
import { useAccountStore } from '../stores/account-store';
import { useOutboxStore } from '../stores/outbox-store';
import { refusedDataGoesAt, useRefusedAccounts } from '../lib/refused-accounts';

/**
 * What the mail list shows instead of the cached mail of an account the
 * server refused (webmail lib/offline/device-wipe.ts, the account
 * switcher's "Needs sign-in"): its mail stays hidden on the device until
 * the user signs in again, with how many unsent messages wait and when the
 * device deletes them.
 */
export function RefusedAccountPrompt({ accountId }: { accountId: string }) {
  const c = useColors();
  const styles = React.useMemo(() => makeStyles(c), [c]);
  const t = useLocaleStore((s) => s.t);
  const locale = useLocaleStore((s) => s.locale);
  const requestReauth = useAuthStore((s) => s.requestReauth);
  const address = useAccountStore((s) => {
    const account = s.accounts.find((a) => a.id === accountId);
    return account?.email || account?.username || '';
  });
  const unsent = useOutboxStore((s) => (s.activeAccountId === accountId ? s.sends.length : 0));
  const goesAt = refusedDataGoesAt(useRefusedAccounts((s) => s.byAccount[accountId]));
  const date = goesAt ? new Date(goesAt).toLocaleDateString(locale || undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '';

  return (
    <View style={styles.container} testID="refused-account-prompt">
      <KeyRound size={28} color={c.textMuted} />
      <Text style={styles.title} accessibilityRole="header">{t('offlineWipe.needs_sign_in', 'Needs sign-in')}</Text>
      <Text style={styles.body}>
        {t('offlineWipe.hidden_until_sign_in', 'The server no longer accepts the saved sign-in for {account}. Its mail stays hidden on this device until you sign in again.', { account: address })}
      </Text>
      {date ? (
        <Text style={styles.body}>
          {unsent > 0
            ? t('offlineWipe.switcher_waiting', 'Unsent messages: {count}. Deleted from this device on {date}.', { count: unsent, date })
            : t('offlineWipe.switcher_kept', 'Its mail on this device is deleted on {date}.', { date })}
        </Text>
      ) : null}
      <Button onPress={() => { void requestReauth(accountId); }}>
        {t('sidebar.account_sign_in_again', 'Sign in again')}
      </Button>
    </View>
  );
}

function makeStyles(c: ThemePalette) {
  return StyleSheet.create({
    container: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: spacing.md, padding: spacing.xl },
    title: { ...typography.bodyMedium, color: c.text, textAlign: 'center' },
    body: { ...typography.body, color: c.textSecondary, textAlign: 'center', maxWidth: 420 },
  });
}
