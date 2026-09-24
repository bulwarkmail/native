import { useEffect } from 'react';
import { useEmailStore } from '../stores/email-store';
import { useSettingsStore } from '../stores/settings-store';
import { appBadgeCount, setAppBadge } from '../lib/app-badge';

/**
 * Keeps the app icon badge on the active account's inbox unread count (see
 * `lib/app-badge`). Mounted with the signed-in UI; unmounting means the last
 * account signed out, so the badge is cleared then. Renders nothing.
 */
export function AppIconBadge() {
  const enabled = useSettingsStore((s) => s.appIconUnreadBadge);
  const count = useEmailStore((s) => appBadgeCount(s.mailboxes, enabled));

  useEffect(() => {
    void setAppBadge(count);
  }, [count]);

  useEffect(() => () => { void setAppBadge(0); }, []);

  return null;
}
