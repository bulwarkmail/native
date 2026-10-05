// Asks before a sign-out or account removal throws away queued sends.
// Counting reads storage by key prefix, so accounts whose queue was never
// hydrated this session still count. Every state counts: `queued` and
// `failed` were never sent, `uncertain` and `sending` may or may not have been.

import { Alert } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { t } from '../stores/locale-store';

const KEY_PREFIX = 'webmail:sendqueue:v1:';

/** True only when at least one account has something queued. */
export function signOutNeedsConfirm(counts: readonly number[]): boolean {
  return counts.some((n) => n > 0);
}

/** Queued sends per account id, from the persisted rows. A storage error counts as 1: ask rather than risk it. */
export async function countQueuedSends(appAccountIds: readonly string[]): Promise<number[]> {
  let keys: readonly string[];
  try {
    keys = await AsyncStorage.getAllKeys();
  } catch {
    return appAccountIds.map(() => 1);
  }
  return appAccountIds.map((id) => {
    const prefix = `${KEY_PREFIX}${id}:`;
    return keys.filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes(':')).length;
  });
}

/**
 * Resolves true when the sign-out may go ahead: nothing is queued, or the user
 * chose "Sign out". "Open Outbox" and Cancel resolve false.
 */
export async function confirmSignOutWithQueue(
  appAccountIds: readonly string[],
  openOutbox: () => void,
): Promise<boolean> {
  const counts = await countQueuedSends(appAccountIds);
  if (!signOutNeedsConfirm(counts)) return true;
  const count = counts.reduce((a, b) => a + b, 0);
  return new Promise<boolean>((resolve) => {
    Alert.alert(
      t('outbox.title', 'Outbox'),
      t(
        'outbox.signout_confirm',
        '{count, plural, one {# unsent message will be deleted. Sign out anyway?} other {# unsent messages will be deleted. Sign out anyway?}}',
        { count },
      ),
      [
        { text: t('common.cancel', 'Cancel'), style: 'cancel', onPress: () => resolve(false) },
        { text: t('outbox.open', 'Open Outbox'), onPress: () => { resolve(false); openOutbox(); } },
        { text: t('sidebar.sign_out', 'Sign out'), style: 'destructive', onPress: () => resolve(true) },
      ],
      { cancelable: true, onDismiss: () => resolve(false) },
    );
  });
}
