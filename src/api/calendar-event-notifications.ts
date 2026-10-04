import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { CalendarEventNotification } from './types';
import { batched } from './jmap-result';
import { hasCalendarCapability } from '../lib/capabilities';

const USING = [CAPABILITIES.CORE, CAPABILITIES.CALENDARS];

/**
 * Pending event notifications (invitations, updates and cancellations made by
 * other participants), oldest first. `event` is requested for its title; the
 * default property set omits it.
 */
export async function getCalendarEventNotifications(): Promise<CalendarEventNotification[]> {
  if (!hasCalendarCapability()) return [];
  const accountId = jmapClient.accountId;
  const response = await jmapClient.request(
    [
      ['CalendarEventNotification/query', {
        accountId,
        sort: [{ property: 'created', isAscending: true }],
      }, '0'],
      ['CalendarEventNotification/get', {
        accountId,
        '#ids': { resultOf: '0', name: 'CalendarEventNotification/query', path: '/ids' },
        properties: ['id', 'created', 'changedBy', 'comment', 'type', 'calendarEventId', 'isDraft', 'event'],
      }, '1'],
    ],
    USING,
  );
  const getResp = response.methodResponses?.find((r) => r[0] === 'CalendarEventNotification/get');
  if (!getResp) {
    const error = response.methodResponses?.find((r) => r[0] === 'error')?.[1] as { description?: string } | undefined;
    throw new Error(error?.description || 'Failed to load calendar event notifications');
  }
  return ((getResp[1] as { list?: CalendarEventNotification[] }).list ?? []);
}

/**
 * Acknowledges (destroys) notifications that were shown. `accountId` is the
 * account they were fetched for; when the client has since moved to another
 * account nothing is sent, so an id is never destroyed on the wrong one.
 */
export async function destroyCalendarEventNotifications(ids: string[], accountId: string): Promise<void> {
  if (ids.length === 0 || !hasCalendarCapability()) return;
  for (const batch of batched(ids, jmapClient.getMaxObjectsInSet())) {
    // Re-checked per batch: the account can switch while an earlier one runs.
    if (jmapClient.accountId !== accountId) {
      console.warn('[calendar-event-notifications] destroy skipped: the active account changed');
      return;
    }
    await jmapClient.request(
      [['CalendarEventNotification/set', { accountId, destroy: batch }, '0']],
      USING,
    );
  }
}
