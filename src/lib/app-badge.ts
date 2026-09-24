import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { Mailbox } from '../api/types';

/**
 * The number on the app icon: the unread count of the active account's own
 * inbox, like the webmail's tab/app-icon badge (`FaviconBadge`). `role ===
 * 'inbox'` alone is not enough: shared and group inboxes sit in the same list,
 * so the first match can be somebody else's. 0 (no badge) when the setting is
 * off.
 */
export function appBadgeCount(mailboxes: readonly Mailbox[], enabled: boolean): number {
  if (!enabled) return 0;
  const inbox = mailboxes.find((m) => m.role === 'inbox' && !m.isShared);
  return Math.max(0, inbox?.unreadEmails ?? 0);
}

/**
 * Whether this platform can badge the app icon without side effects.
 *
 * iOS only. On Android expo-notifications badges through ShortcutBadger,
 * which only a few launchers honour (Android 8+ launchers derive their badge
 * from the notifications on display instead), and it implements a count of 0
 * as `NotificationManager.cancelAll()`: clearing the badge would also dismiss
 * every notification the app shows, including other accounts' new mail and
 * calendar reminders.
 */
export function canBadgeAppIcon(): boolean {
  return Platform.OS === 'ios';
}

/**
 * Show `count` on the app icon (0 clears it). A silent no-op where the
 * platform can't badge or the user denied badge permission.
 */
export async function setAppBadge(count: number): Promise<void> {
  if (!canBadgeAppIcon()) return;
  try {
    await Notifications.setBadgeCountAsync(Math.max(0, Math.floor(count)));
  } catch {
    // Badging is cosmetic; never let it surface as an error.
  }
}
