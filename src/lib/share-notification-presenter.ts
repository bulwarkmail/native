import { useShareNotificationStore } from '../stores/share-notification-store';
import { useEmailStore } from '../stores/email-store';
import { useCalendarStore } from '../stores/calendar-store';
import { useContactsStore } from '../stores/contacts-store';
import { useLocaleStore } from '../stores/locale-store';
import { toast } from '../stores/toast-store';
import { shareNotificationMessage } from './share-notification-toast';
import { activeAppAccountId, clientServesActiveAccount } from './active-client-account';
import { hasCalendarCapability } from './capabilities';

/**
 * Shows queued ShareNotifications as toasts, refreshes the collection lists
 * they touched so a newly shared folder, calendar or address book appears,
 * then acknowledges them. Returns the unsubscribe.
 */
export function startShareNotificationToasts(): () => void {
  const present = () => {
    const store = useShareNotificationStore.getState();
    const batch = store.pending;
    if (batch.length === 0) return;
    const { t } = useLocaleStore.getState();
    // The store resets on every switch, so a notice of another app account
    // should not be here; if one is, it is not shown and the acknowledge
    // below leaves it on its server (its destroy guard fails).
    const activeApp = clientServesActiveAccount() ? activeAppAccountId() : null;
    const shown = batch.filter((n) => activeApp !== null && n.appAccountId === activeApp);
    const touched = new Set<string>();
    for (const n of shown) {
      touched.add(n.objectType);
      const { level, text } = shareNotificationMessage(n, t);
      toast[level](text);
    }
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
  return useShareNotificationStore.subscribe(present);
}
