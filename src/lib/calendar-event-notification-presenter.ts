import { jmapClient } from '../api/jmap-client';
import { useCalendarEventNotificationStore } from '../stores/calendar-event-notification-store';
import { useCalendarStore } from '../stores/calendar-store';
import { useLocaleStore } from '../stores/locale-store';
import { toast } from '../stores/toast-store';
import { setPendingCalendarOpen } from '../navigation/pending-calendar-open';
import { buildNoticeToasts } from './calendar-event-notification-toast';

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
  const present = () => {
    const store = useCalendarEventNotificationStore.getState();
    const batch = store.pending;
    if (batch.length === 0) return;
    const { t } = useLocaleStore.getState();
    const active = activeJmapAccountId();
    for (const n of buildNoticeToasts(batch, t, active)) {
      const eventId = n.openEventId;
      const action = eventId
        ? {
            label: t('calendar_event_notifications.open', 'Open'),
            onPress: () => {
              // Only for the account it was delivered to, like a deep link.
              if (activeJmapAccountId() !== active) return;
              setPendingCalendarOpen({ kind: 'event', eventId, serverId: eventId });
              openCalendar();
            },
          }
        : undefined;
      toast[n.level](n.title, { message: n.message, action });
    }
    void useCalendarStore.getState().refresh().catch(() => undefined);
    // Removes them from the store before anything else can see them again.
    void store.acknowledge(batch.map((n) => n.id));
  };
  present();
  return useCalendarEventNotificationStore.subscribe(present);
}
