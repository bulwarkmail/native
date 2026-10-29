import { useEffect } from 'react';
import { Platform } from 'react-native';
import { useEmailStore } from '../stores/email-store';
import { useSettingsStore } from '../stores/settings-store';
import { useLocaleStore } from '../stores/locale-store';
import { useAuthStore } from '../stores/auth-store';
import { appBadgeCount, setAppBadge } from '../lib/app-badge';
import { jmapClient } from '../api/jmap-client';
import { writeIosPushSettings } from '../lib/ios-push-shared';
import { shareAccountWithExtension } from '../lib/push-notifications';

/**
 * Keeps the app icon badge on the active account's inbox unread count (see
 * `lib/app-badge`). Mounted with the signed-in UI; unmounting means the last
 * account signed out, so the badge is cleared then. Renders nothing.
 *
 * On iOS it also tells the notification extension (plugins/ios-push) which
 * account the badge follows and the few texts it writes itself, so a push
 * that arrives while the app is closed updates the badge the same way.
 */
export function AppIconBadge() {
  const enabled = useSettingsStore((s) => s.appIconUnreadBadge);
  const count = useEmailStore((s) => appBadgeCount(s.mailboxes, enabled));
  const activeAccountId = useAuthStore((s) => s.activeAccountId);
  // The JMAP session comes up after the account is known (offline start).
  const haveSession = useAuthStore((s) => s.session != null);
  const t = useLocaleStore((s) => s.t);

  useEffect(() => {
    void setAppBadge(count);
  }, [count]);

  useEffect(() => {
    if (Platform.OS !== 'ios') return;
    let jmapAccountId: string | null = null;
    try {
      jmapAccountId = jmapClient.accountId;
    } catch {
      jmapAccountId = null;
    }
    // The extension learns how to reach the active account as soon as it is
    // signed in, so a push for it shows sender and subject even before (or
    // without) this device's own push setup, e.g. after a reinstall.
    if (activeAccountId) void shareAccountWithExtension(activeAccountId, jmapAccountId);
    void writeIosPushSettings({
      badge: enabled,
      activeAccountId: jmapAccountId,
      strings: {
        noSubject: t('push.ios.no_subject', '(no subject)'),
        more: t('push.ios.more_messages', 'and {count} more'),
      },
    }).catch(() => undefined);
  }, [enabled, activeAccountId, haveSession, t]);

  useEffect(() => () => { void setAppBadge(0); }, []);

  return null;
}
