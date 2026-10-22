import { useEffect } from 'react';
import { Platform } from 'react-native';
import { useEmailStore } from '../stores/email-store';
import { useSettingsStore } from '../stores/settings-store';
import { useLocaleStore } from '../stores/locale-store';
import { useAuthStore } from '../stores/auth-store';
import { appBadgeCount, setAppBadge } from '../lib/app-badge';
import { jmapClient } from '../api/jmap-client';
import { writeIosPushSettings } from '../lib/ios-push-shared';

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
    void writeIosPushSettings({
      badge: enabled,
      activeAccountId: jmapAccountId,
      strings: {
        noSubject: t('push.ios.no_subject', '(no subject)'),
        more: t('push.ios.more_messages', 'and {count} more'),
      },
    }).catch(() => undefined);
  }, [enabled, activeAccountId, t]);

  useEffect(() => () => { void setAppBadge(0); }, []);

  return null;
}
