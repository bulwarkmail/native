import {
  destroyCalendarEventNotifications,
  getCalendarEventNotifications,
} from '../api/calendar-event-notifications';
import type { CalendarEventNotification } from '../api/types';
import { createPendingNotificationStore, type PendingNotification } from './pending-notification-store';

/** A calendar event notice tagged with its JMAP and app account. */
export type PendingCalendarEventNotification = PendingNotification<CalendarEventNotification>;

export const useCalendarEventNotificationStore = createPendingNotificationStore<CalendarEventNotification>({
  name: 'calendar event notifications',
  list: getCalendarEventNotifications,
  destroy: destroyCalendarEventNotifications,
});
