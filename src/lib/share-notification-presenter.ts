import { useShareNotificationStore } from '../stores/share-notification-store';
import { useEmailStore } from '../stores/email-store';
import { useCalendarStore } from '../stores/calendar-store';
import { useContactsStore } from '../stores/contacts-store';
import { useLocaleStore } from '../stores/locale-store';
import { useAuthStore } from '../stores/auth-store';
import { freeToastSlots, toast, useToastStore } from '../stores/toast-store';
import { needsSessionRefresh, shareNotificationMessage } from './share-notification-toast';
import { createNoticeWaiter, selectNoticeToasts } from './calendar-event-notification-toast';
import { coalesceByKey } from './session-retry';
import { activeAppAccountId, clientServesActiveAccount } from './active-client-account';
import { hasCalendarCapability } from './capabilities';

/**
 * Shows queued ShareNotifications as toasts, refreshes the collection lists
 * they touched so a newly shared folder, calendar or address book appears,
 * then acknowledges them. A share from an owner the session does not list
 * refreshes the session first. Returns the unsubscribe.
 */
export function startShareNotificationToasts(): () => void {
  // Adding a toast notifies the toast subscription below synchronously.
  let presenting = false;
  // One session refresh per app account at a time; the batches that came
  // during one share one more after it, since the one in flight may predate
  // their owner's share. Each batch fetches once the refresh it waits on
  // settles.
  const refreshSession = coalesceByKey((appAccountId: string) =>
    useAuthStore.getState().refreshSessionFor(appAccountId).catch(() => false));
  const present = () => {
    if (presenting) return;
    const store = useShareNotificationStore.getState();
    const batch = store.pending;
    if (batch.length === 0) {
      waiter.reset();
      return;
    }
    const { t } = useLocaleStore.getState();
    // The store resets on every switch, so a notice of another app account
    // should not be here; if one is, it is not shown and the acknowledge
    // below leaves it on its server (its destroy guard fails).
    const activeApp = clientServesActiveAccount() ? activeAppAccountId() : null;
    const shown = batch.filter((n) => activeApp !== null && n.appAccountId === activeApp);
    // Never push the user's Undo or an error out of the three-slot host:
    // with no room, wait for a toast to leave (the toast subscription), but
    // no longer than the cap; then the batch goes without a toast. A batch
    // with nothing to show never waits.
    const room = shown.length > 0 ? freeToastSlots(useToastStore.getState().toasts) : 1;
    const step = waiter.step(room);
    if (step === 'wait') return;
    if (step === 'drop') {
      console.warn('[share-notices] no room for a toast within the wait cap; acknowledging', batch.length, 'without one');
    } else if (shown.length > 0) {
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
    const fetchTouched = () => {
      if (touched.has('Mailbox')) void useEmailStore.getState().fetchMailboxes();
      if (touched.has('Calendar') && hasCalendarCapability()) {
        void useCalendarStore.getState().fetchCalendars().catch(() => undefined);
      }
      if (touched.has('AddressBook')) void useContactsStore.getState().refresh().catch(() => undefined);
      // FileNode: the files screen loads on open, nothing held to refresh.
    };
    // A first share from a new owner: the lists only include that owner's
    // collections once the session names its account. The refresh is for
    // the account these notices came to; after a switch nothing is fetched.
    const known = Object.keys(useAuthStore.getState().session?.accounts ?? {});
    if (activeApp !== null && needsSessionRefresh(shown, known)) {
      void refreshSession(activeApp).then(() => {
        if (activeAppAccountId() === activeApp && clientServesActiveAccount()) fetchTouched();
      });
    } else {
      fetchTouched();
    }
    // Removes them from the store before anything else can see them again.
    void store.acknowledge(batch.map((n) => n.id));
  };
  const waiter = createNoticeWaiter(present);
  present();
  const unsubscribeNotices = useShareNotificationStore.subscribe(present);
  const unsubscribeToasts = useToastStore.subscribe(present);
  return () => {
    unsubscribeNotices();
    unsubscribeToasts();
    waiter.reset();
  };
}
