import AsyncStorage from '@react-native-async-storage/async-storage';
import { lastNotifiedKey, notifiedIdsKey } from '../push-notifications';

/**
 * BulwarkFcm.showNotification as far as the notified ids go (BulwarkFcmModule,
 * NotifiedOnce.kt): a notification for messages of an account is posted
 * unless all of them were notified before, and they are recorded, newest
 * first, once it is. Resolves whether it posted.
 */
export async function showNotificationOnce(opts: {
  accountId?: string;
  emailId?: string;
  notified?: { accountId: string; ids: string[] };
}): Promise<boolean> {
  const accountId = opts.notified?.accountId ?? opts.accountId;
  const ids = (opts.notified?.ids ?? [opts.emailId ?? '']).filter((id) => id !== '');
  if (!accountId || ids.length === 0) return true;
  const key = notifiedIdsKey(accountId);
  const ring = JSON.parse((await AsyncStorage.getItem(key)) ?? '[]') as string[];
  if (ids.every((id) => ring.includes(id))) return false;
  await AsyncStorage.setItem(key, JSON.stringify([...ids, ...ring.filter((id) => !ids.includes(id))]));
  return true;
}

/** BulwarkFcm.forgetNotifiedIds: the account's ring and its legacy single id go. */
export async function forgetNotifiedIds(accountId: string): Promise<void> {
  await AsyncStorage.multiRemove([notifiedIdsKey(accountId), lastNotifiedKey(accountId)]);
}
