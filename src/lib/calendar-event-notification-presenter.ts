import { jmapClient } from '../api/jmap-client';
import { useCalendarEventNotificationStore } from '../stores/calendar-event-notification-store';
import { useCalendarStore } from '../stores/calendar-store';
import { useLocaleStore } from '../stores/locale-store';
import { freeToastSlots, toast, useToastStore } from '../stores/toast-store';
import { setPendingCalendarOpen } from '../navigation/pending-calendar-open';
import {
  buildNoticeToasts,
  createNoticeWaiter,
  selectNoticeToasts,
  type NoticeToast,
} from './calendar-event-notification-toast';
import { activeAppAccountId, clientServesActiveAccount } from './active-client-account';

function activeJmapAccountId(): string | undefined {
  try {
    return jmapClient.accountId;
  } catch {
    return undefined;
  }
}

/**
 * Shows queued CalendarEventNotifications as toasts, refreshes the calendar so
 * the change is visible, and acknowledges them. Returns the unsubscribe.
 * `openCalendar` navigates to the Calendar tab.
 */
export function startCalendarEventNotificationToasts(openCalendar: () => void): () => void {
  // Adding a toast notifies the toast subscription below synchronously.
  let presenting = false;
  const present = () => {
    if (presenting) return;
    const store = useCalendarEventNotificationStore.getState();
    const batch = store.pending;
    if (batch.length === 0) {
      waiter.reset();
      return;
    }
    // Never push the user's Undo or an error out of the toast host: with no
    // room, wait for a toast to leave (the toast subscription), but no longer
    // than the cap; then the batch goes without a toast.
    const room = freeToastSlots(useToastStore.getState().toasts);
    const step = waiter.step(room);
    if (step === 'wait') return;
    if (step === 'drop') {
      console.warn('[calendar-notices] no room for a toast within the wait cap; acknowledging', batch.length, 'without one');
    } else {
      showToasts(batch, room);
    }
    void useCalendarStore.getState().refresh().catch(() => undefined);
    // Removes them from the store before anything else can see them again.
    void store.acknowledge(batch.map((n) => n.id));
  };
  const showToasts = (batch: ReturnType<typeof useCalendarEventNotificationStore.getState>['pending'], room: number) => {
    const { t } = useLocaleStore.getState();
    // Only offered while the client really serves the active app account:
    // JMAP account ids repeat across servers, so they alone can't tell.
    const serves = clientServesActiveAccount();
    const active = serves ? activeJmapAccountId() : undefined;
    const activeApp = serves ? activeAppAccountId() : null;
    const { individual, overflow } = selectNoticeToasts(buildNoticeToasts(batch, t, active, activeApp), room);
    const show = (n: NoticeToast) => {
      const eventId = n.openEventId;
      const action = eventId
        ? {
            label: t('calendar_event_notifications.open', 'Open'),
            onPress: () => {
              // Only for the account it was delivered to, like a deep link.
              if (!clientServesActiveAccount() || activeAppAccountId() !== activeApp
                || activeJmapAccountId() !== active) return;
              setPendingCalendarOpen({ kind: 'event', eventId, serverId: eventId });
              openCalendar();
            },
          }
        : undefined;
      toast[n.level](n.title, { message: n.message, action });
    };
    presenting = true;
    try {
      // A backlog would evict the toast host's other toasts: one summary instead.
      if (overflow > 0) {
        toast.info(
          t(
            'calendar_event_notifications.more',
            '{count, plural, one {# more calendar update} other {# more calendar updates}}',
            { count: overflow },
          ),
          { action: { label: t('calendar_event_notifications.open', 'Open'), onPress: openCalendar } },
        );
      }
      for (const n of individual) show(n);
    } finally {
      presenting = false;
    }
  };
  const waiter = createNoticeWaiter(present);
  present();
  const unsubscribeNotices = useCalendarEventNotificationStore.subscribe(present);
  const unsubscribeToasts = useToastStore.subscribe(present);
  return () => {
    unsubscribeNotices();
    unsubscribeToasts();
    waiter.reset();
  };
}
