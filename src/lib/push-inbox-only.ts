import { jmapClient } from '../api/jmap-client';
import { useSettingsStore } from '../stores/settings-store';
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
        const relayBaseUrl = await getStoredRelayBaseUrl();
        if (!relayBaseUrl) return;
        // The resync asks for the permission when it's missing; a settings
        // toggle never prompts.
        if (!(await hasNotificationPermission())) return;
        await resyncPushNotifications({ relayBaseUrl, accountLabel: jmapClient.username ?? undefined });
        const username = jmapClient.username;
        const serverUrl = jmapClient.serverUrl;
        if (username && serverUrl) markPushRenewed(generateAccountId(username, serverUrl));
      } catch (error) {
        console.warn('[push] inbox-only re-sync failed:', error instanceof Error ? error.message : error);
      }
    })();
  });
}
