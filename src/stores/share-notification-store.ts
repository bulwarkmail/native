import { destroyShareNotifications, getShareNotifications } from '../api/share-notifications';
import type { ShareNotification } from '../api/types';
import { createPendingNotificationStore } from './pending-notification-store';

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
