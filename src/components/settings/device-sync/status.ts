// The status line of one account's device sync in Settings: off, paused in
// Android settings, syncing, when it last synced, or what went wrong and what
// the user can do about it (docs/device-sync.md, "Settings sections",
// "Failure matrix").
import { CONTACTS_AUTHORITY, type Authority, type RunStatus } from '../../../device-sync/types';
import type { TranslateFn } from '../../../stores/locale-store';

/** What the status line offers to do. */
export type StatusAction = 'signIn' | 'grantAccess' | 'reviewDeletions';

export interface StatusLine {
  text: string;
  tone: 'muted' | 'warning' | 'error';
  action?: StatusAction;
}

export interface StatusInput {
  authority: Authority;
  /** The switch: Android syncs this authority automatically. */
  on: boolean;
  /** On in the app but off in Android's settings for the account. */
  paused: boolean;
  /** The Android account was removed in Android Settings. */
  removed: boolean;
  /** The runtime permissions; null while unknown. */
  permitted: boolean | null;
  syncing: boolean;
  lastRun?: RunStatus;
  now: number;
}

/** "just now", "5 min ago", … */
export function relativeTime(at: number, now: number, t: TranslateFn): string {
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return t('settings.offline.just_now', 'just now');
  if (diff < 60 * 60_000) return t('settings.offline.minutes_ago', '{count} min ago', { count: Math.round(diff / 60_000) });
  if (diff < 24 * 60 * 60_000) {
    return t('settings.offline.hours_ago', '{count} h ago', { count: Math.round(diff / (60 * 60_000)) });
  }
  return t('settings.offline.days_ago', '{count} d ago', { count: Math.round(diff / (24 * 60 * 60_000)) });
}

function permissionLine(authority: Authority, t: TranslateFn): StatusLine {
  return {
    text: authority === CONTACTS_AUTHORITY
      ? t('settings.device_sync.status_permission_contacts', 'Access to contacts was turned off, so nothing syncs.')
      : t('settings.device_sync.status_permission_calendar', 'Access to calendars was turned off, so nothing syncs.'),
    tone: 'error',
    action: 'grantAccess',
  };
}

function runLine(run: RunStatus, input: StatusInput, t: TranslateFn): StatusLine | null {
  const when = relativeTime(run.at, input.now, t);
  switch (run.outcome) {
    case 'ok': {
      const synced = t('settings.device_sync.status_synced', 'Synced {when}', { when });
      if (run.itemErrors <= 0) return { text: synced, tone: 'muted' };
      const skipped = t(
        'settings.device_sync.status_item_errors',
        '{count, plural, one {# item could not be synced.} other {# items could not be synced.}}',
        { count: run.itemErrors },
      );
      return { text: `${synced} · ${skipped}`, tone: 'warning' };
    }
    case 'auth':
      return {
        text: t('settings.device_sync.status_auth', 'The server no longer accepts the sign-in. Sign in again to keep syncing.'),
        tone: 'error',
        action: 'signIn',
      };
    case 'permission':
      return permissionLine(input.authority, t);
    case 'tooManyDeletions':
      return {
        text: t(
          'settings.device_sync.status_too_many_deletions',
          'Many items were deleted on this device. They are not deleted on the server until you confirm.',
        ),
        tone: 'warning',
        action: 'reviewDeletions',
      };
    case 'io':
      return {
        text: t('settings.device_sync.status_io', 'Could not reach the server {when}. Android tries again.', { when }),
        tone: 'warning',
      };
    case 'unsupported':
      return {
        text: input.authority === CONTACTS_AUTHORITY
          ? t('settings.device_sync.status_unsupported_contacts', 'The server offers no address books for this account.')
          : t('settings.device_sync.status_unsupported_calendar', 'The server offers no calendars for this account.'),
        tone: 'error',
      };
    case 'safetyAbort':
      return {
        text: t(
          'settings.device_sync.status_safety_abort',
          'Stopped: the server returned nothing while this device still holds items. Check the server, then sync again.',
        ),
        tone: 'error',
      };
    case 'cancelled':
      return { text: t('settings.device_sync.status_cancelled', 'The last sync stopped early. It continues next time.'), tone: 'muted' };
    case 'internal':
      return {
        text: run.message
          ? t('settings.device_sync.status_failed', 'The last sync failed: {message}', { message: run.message })
          : t('settings.device_sync.status_failed_plain', 'The last sync failed.'),
        tone: 'error',
      };
    case 'disabled':
    default:
      return null;
  }
}

export function describeSyncStatus(input: StatusInput, t: TranslateFn): StatusLine {
  if (!input.on && !input.paused) {
    return input.removed
      ? {
        text: t('settings.device_sync.status_removed', 'Removed in Android settings. Turn on to add the account again.'),
        tone: 'warning',
      }
      : { text: t('settings.device_sync.status_off', 'Off'), tone: 'muted' };
  }
  if (input.permitted === false) return permissionLine(input.authority, t);
  if (input.paused) return { text: t('settings.device_sync.status_paused', 'Paused in Android settings'), tone: 'warning' };
  if (input.syncing) return { text: t('settings.device_sync.status_syncing', 'Syncing…'), tone: 'muted' };
  if (!input.lastRun) return { text: t('settings.device_sync.status_waiting', 'Waiting for the first sync'), tone: 'muted' };
  return runLine(input.lastRun, input, t)
    ?? { text: t('settings.device_sync.status_waiting_next', 'Waiting for the next sync'), tone: 'muted' };
}
