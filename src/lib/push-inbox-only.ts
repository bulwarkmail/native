import { jmapClient } from '../api/jmap-client';
import type { JMAPSession } from '../api/types';
import { useEmailStore } from '../stores/email-store';
import { useSettingsStore } from '../stores/settings-store';
import { activeAppAccountId, clientServesAccount } from './active-client-account';
import { generateAccountId } from './account-utils';
import { getStoredRelayBaseUrl, hasNotificationPermission, resyncPushNotifications } from './push-notifications';
import { markPushRenewed } from './push-renewal';

interface InboxOnlySlice {
  pushNotifyInboxOnly: boolean;
  emailNotificationsEnabled: boolean;
  hydrated: boolean;
}

/**
 * The delivery filter lives on the server subscription, so flipping the
 * setting has to re-run the push setup. Only when the value actually changed,
 * and never while email notifications are off (the account has no
 * subscription to update then; turning them back on runs a full setup). A
 * change seen while settings load (the persisted value replacing the default)
 * is no change: the store must have been hydrated before and after it.
 */
export function shouldResyncForInboxOnly(next: InboxOnlySlice, prev: InboxOnlySlice): boolean {
  return (
    prev.hydrated &&
    next.hydrated &&
    next.pushNotifyInboxOnly !== prev.pushNotifyInboxOnly &&
    next.emailNotificationsEnabled
  );
}

/**
 * Re-sync the active account's push subscription when "Inbox only" changes,
 * the way App.tsx sets it up. Other signed-in accounts pick the filter up when
 * they become active again. Returns the unsubscribe.
 */
export function watchInboxOnlyChange(): () => void {
  return useSettingsStore.subscribe((state, prev) => {
    if (!shouldResyncForInboxOnly(state, prev)) return;
    void (async () => {
      try {
        const username = jmapClient.username;
        const serverUrl = jmapClient.serverUrl;
        if (!username || !serverUrl) return;
        const accountId = generateAccountId(username, serverUrl);
        const relayBaseUrl = await getStoredRelayBaseUrl(accountId);
        if (!relayBaseUrl) return;
        // The resync asks for the permission when it's missing; a settings
        // toggle never prompts.
        if (!(await hasNotificationPermission())) return;
        await resyncPushNotifications({ relayBaseUrl, accountLabel: jmapClient.username ?? undefined });
        markPushRenewed(accountId);
      } catch (error) {
        console.warn('[push] inbox-only re-sync failed:', error instanceof Error ? error.message : error);
      }
    })();
  });
}

const MAIL_CAPABILITY = 'urn:ietf:params:jmap:mail';

/** Whether `next` names a mail account that `prev` did not (a new share). */
export function gainedMailAccounts(prev: JMAPSession | null, next: JMAPSession): boolean {
  const before = prev?.accounts ?? {};
  return Object.entries(next.accounts ?? {}).some(
    ([id, account]) => !(id in before) && !!account.accountCapabilities?.[MAIL_CAPABILITY],
  );
}

/**
 * Re-run the push setup for app account `appAccountId` after its session
 * gained a mail account, so the delivery filter covers the new share. Never
 * throws.
 */
export async function resyncPushAfterSessionChange(appAccountId: string): Promise<void> {
  // The resync acts on whatever the client serves: only while that is still
  // this account, and it is the one shown.
  const serves = () => activeAppAccountId() === appAccountId && clientServesAccount(appAccountId);
  try {
    // buildEmailPushConfig reads the loaded folder list, and an account
    // missing from it gets the server's unfiltered fallback; so the folders
    // load first (joining a load already running).
    await useEmailStore.getState().fetchMailboxes();
    if (!serves() || !useSettingsStore.getState().emailNotificationsEnabled) return;
    const relayBaseUrl = await getStoredRelayBaseUrl(appAccountId);
    if (!relayBaseUrl || !serves()) return;
    // A session refresh never prompts for the permission.
    if (!(await hasNotificationPermission()) || !serves()) return;
    await resyncPushNotifications({ relayBaseUrl, accountLabel: jmapClient.username ?? undefined });
    markPushRenewed(appAccountId);
  } catch (error) {
    console.warn('[push] re-sync after session change failed:', error instanceof Error ? error.message : error);
  }
}
