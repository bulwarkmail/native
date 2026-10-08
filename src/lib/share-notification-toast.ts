import type { ShareNotification } from '../api/types';
import type { TranslateFn } from '../stores/locale-store';
import type { Toast } from '../stores/toast-store';
import { TOAST_HOST_SLOTS } from './calendar-event-notification-toast';
import { plainDisplayText as plain } from './display-text';

// The sharer controls their name and the collection name: shown as one line
// of plain text, with format characters and line breaks dropped (so a name
// cannot fake a second line) and cut to a sane length.
const MAX_NAME = 100;
const MAX_OBJECT = 100;

/** What happened to the user's rights, for the wording. */
export function shareNotificationKind(n: ShareNotification): 'shared' | 'changed' | 'revoked' {
  if (!n.oldRights || Object.keys(n.oldRights).length === 0) return 'shared';
  if (!n.newRights || Object.keys(n.newRights).length === 0) return 'revoked';
  return 'changed';
}

/** "Dana shared the calendar "Team" with you"; a removal is a warning. */
export function shareNotificationMessage(
  n: ShareNotification,
  t: TranslateFn,
): { level: 'info' | 'warning'; text: string } {
  const kind = shareNotificationKind(n);
  const name = plain(n.changedBy?.name, MAX_NAME)
    || plain(n.changedBy?.email, MAX_NAME)
    || t('share_notifications.someone', 'Someone');
  const object = plain(n.name, MAX_OBJECT) || plain(n.objectId, MAX_OBJECT);
  let what: string;
  switch (n.objectType) {
    case 'Mailbox': what = t('share_notifications.object.folder', 'folder'); break;
    case 'Calendar': what = t('share_notifications.object.calendar', 'calendar'); break;
    case 'AddressBook': what = t('share_notifications.object.address_book', 'address book'); break;
    case 'FileNode': what = t('share_notifications.object.files', 'file folder'); break;
    default: what = plain(n.objectType, MAX_OBJECT);
  }
  const params = { name, object, kind: what };
  if (kind === 'shared') {
    return { level: 'info', text: t('share_notifications.shared', '{name} shared the {kind} "{object}" with you', params) };
  }
  if (kind === 'revoked') {
    return { level: 'warning', text: t('share_notifications.revoked', '{name} removed your access to the {kind} "{object}"', params) };
  }
  return { level: 'info', text: t('share_notifications.changed', '{name} changed your access to the {kind} "{object}"', params) };
}

/** A toast the user may still need: an error, or one with a button (Undo). */
function mustKeep(toast: Toast): boolean {
  return toast.type === 'error' || !!toast.action || !!toast.secondaryAction;
}

/**
 * How many toasts can be added without evicting one the user may still need.
 * The host keeps the newest three, so everything from the oldest such toast
 * onwards has to stay inside them.
 */
export function freeToastSlots(toasts: Toast[]): number {
  const first = toasts.findIndex(mustKeep);
  if (first < 0) return TOAST_HOST_SLOTS;
  return Math.max(0, TOAST_HOST_SLOTS - (toasts.length - first));
}
