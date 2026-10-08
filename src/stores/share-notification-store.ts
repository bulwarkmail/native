import { destroyShareNotifications, getShareNotifications } from '../api/share-notifications';
import type { ShareNotification } from '../api/types';
import { createPendingNotificationStore, type PendingNotification } from './pending-notification-store';

/** A share notice tagged with its JMAP and app account. */
export type PendingShareNotification = PendingNotification<ShareNotification>;

/**
 * ShareNotification (RFC 9670 §3) inbox: the server records every change to
 * this user's rights on someone else's collection. The presenter shows them
 * and acknowledges them, which destroys them on the server.
 */
export const useShareNotificationStore = createPendingNotificationStore<ShareNotification>({
  name: 'share notifications',
  list: getShareNotifications,
  destroy: destroyShareNotifications,
});
