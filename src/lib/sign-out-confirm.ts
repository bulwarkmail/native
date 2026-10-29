import { Alert } from 'react-native';

type Translate = (key: string, fallback: string, params?: Record<string, string | number>) => string;

/**
 * Asks before signing out: it drops the account's cached mail and push
 * registration on this device, and a stray tap in the account menu or at the
 * end of Settings did it straight away.
 */
export function confirmSignOut(
  t: Translate,
  { account, all = false }: { account?: string; all?: boolean },
  onConfirm: () => void,
): void {
  const title = all
    ? t('sidebar.sign_out_all_confirm_title', 'Sign out of all accounts?')
    : account
      ? t('sidebar.sign_out_confirm_title_account', 'Sign out of {account}?', { account })
      : t('sidebar.sign_out_confirm_title', 'Sign out?');
  const message = all
    ? t('sidebar.sign_out_all_confirm_message', 'Every account is removed from this device. You can sign in again at any time.')
    : t('sidebar.sign_out_confirm_message', 'The account is removed from this device. You can sign in again at any time.');
  Alert.alert(title, message, [
    { text: t('common.cancel', 'Cancel'), style: 'cancel' },
    {
      text: all ? t('sidebar.sign_out_all', 'Sign out of all accounts') : t('sidebar.sign_out', 'Sign out'),
      style: 'destructive',
      onPress: onConfirm,
    },
  ]);
}
