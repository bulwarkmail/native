import { useShareNotificationStore } from '../stores/share-notification-store';
import { useEmailStore } from '../stores/email-store';
import { useCalendarStore } from '../stores/calendar-store';
import { useContactsStore } from '../stores/contacts-store';
import { useLocaleStore } from '../stores/locale-store';
import { freeToastSlots, toast, useToastStore } from '../stores/toast-store';
import { shareNotificationMessage } from './share-notification-toast';
import { selectNoticeToasts } from './calendar-event-notification-toast';
import { activeAppAccountId, clientServesActiveAccount } from './active-client-account';
import { hasCalendarCapability } from './capabilities';

/**
 * Shows queued ShareNotifications as toasts, refreshes the collection lists
 * they touched so a newly shared folder, calendar or address book appears,
 * then acknowledges them. Returns the unsubscribe.
 */
export function startShareNotificationToasts(): () => void {
  // Adding a toast notifies the toast subscription below synchronously.
  let presenting = false;
  const present = () => {
    if (presenting) return;
    const store = useShareNotificationStore.getState();
    const batch = store.pending;
    if (batch.length === 0) return;
    const { t } = useLocaleStore.getState();
    // The store resets on every switch, so a notice of another app account
    // should not be here; if one is, it is not shown and the acknowledge
    // below leaves it on its server (its destroy guard fails).
    const activeApp = clientServesActiveAccount() ? activeAppAccountId() : null;
    const shown = batch.filter((n) => activeApp !== null && n.appAccountId === activeApp);
    if (shown.length > 0) {
      // Never push the user's Undo or an error out of the three-slot host:
      // with no room, wait for a toast to leave (the toast subscription).
      const room = freeToastSlots(useToastStore.getState().toasts);
      if (room === 0) return;
      const messages = shown.map((n) => shareNotificationMessage(n, t));
      const { individual, overflow } = selectNoticeToasts(messages, room);
      presenting = true;
      try {
        if (overflow > 0) {
          toast.info(t(
            'share_notifications.more',
            '{count, plural, one {# more sharing change} other {# more sharing changes}}',
            { count: overflow },
          ));
        }
        for (const m of individual) toast[m.level](m.text);
      } finally {
        presenting = false;
      }
    }
    const touched = new Set(shown.map((n) => n.objectType));
    if (touched.has('Mailbox')) void useEmailStore.getState().fetchMailboxes();
    if (touched.has('Calendar') && hasCalendarCapability()) {
      void useCalendarStore.getState().fetchCalendars().catch(() => undefined);
    }
    if (touched.has('AddressBook')) void useContactsStore.getState().refresh().catch(() => undefined);
    // FileNode: the files screen loads on open, nothing held to refresh.
    // Removes them from the store before anything else can see them again.
    void store.acknowledge(batch.map((n) => n.id));
  };
  present();
  const unsubscribeNotices = useShareNotificationStore.subscribe(present);
  const unsubscribeToasts = useToastStore.subscribe(present);
  return () => {
    unsubscribeNotices();
    unsubscribeToasts();
  };
}
