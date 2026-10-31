import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import { batched } from './jmap-result';

// CalendarEventNotification (draft-ietf-jmap-calendars §7): the server
// records every invitation, update and cancellation another participant made
// to an event this user takes part in. Ported from the webmail's
// getCalendarEventNotifications / destroyCalendarEventNotifications in
// lib/jmap/client.ts.

export interface CalendarEventNotification {
  id: string;
  created: string;
  changedBy?: {
    name?: string | null;
    email?: string | null;
    principalId?: string | null;
  } | null;
  comment?: string | null;
  type: 'created' | 'updated' | 'destroyed';
  calendarEventId: string;
  isDraft?: boolean;
  /** The event before the change on 1.0 (as created for an invitation); 0.16 leaves it out. */
  event?: { title?: string | null } | null;
  /**
   * What changed, for an `updated` one: a JSCalendar patch on 1.0, the whole
   * event as it is now on 0.16. An organizer's cancellation reaches the
   * attendee as an update that sets `status` to `cancelled` (iTIP CANCEL
   * keeps the attendee's copy), never as `destroyed`.
   */
  eventPatch?: { status?: string | null; title?: string | null } | null;
}

/** An organizer cancelled the event: the change sets its status to cancelled. */
export function isCancellation(n: Pick<CalendarEventNotification, 'type' | 'eventPatch'>): boolean {
  return n.type === 'destroyed' || (n.type === 'updated' && n.eventPatch?.status === 'cancelled');
}

const USING = [CAPABILITIES.CORE, CAPABILITIES.CALENDARS];

/**
 * Pending event notifications, oldest first. `event` is asked for its title
 * only; Stalwart 0.16 doesn't return it, so the titles it lacks are read from
 * the events themselves (a cancelled event is gone and stays untitled).
 * Throws when the server refuses the listing.
 */
export async function getCalendarEventNotifications(): Promise<CalendarEventNotification[]> {
  const accountId = jmapClient.accountId;
  const response = await jmapClient.request([
    ['CalendarEventNotification/query', {
      accountId,
      sort: [{ property: 'created', isAscending: true }],
    }, '0'],
    ['CalendarEventNotification/get', {
      accountId,
      '#ids': { resultOf: '0', name: 'CalendarEventNotification/query', path: '/ids' },
      properties: ['id', 'created', 'changedBy', 'comment', 'type', 'calendarEventId', 'isDraft', 'event', 'eventPatch'],
    }, '1'],
  ], USING);
  const responses = (response.methodResponses ?? []) as [string, any, string][];
  const getResp = responses.find((r) => r[0] === 'CalendarEventNotification/get');
  if (!getResp) {
    const error = responses.find((r) => r[0] === 'error')?.[1] as { description?: string } | undefined;
    throw new Error(error?.description || 'Failed to load calendar event notifications');
  }
  const list = (getResp[1]?.list ?? []) as CalendarEventNotification[];
  await fillMissingTitles(accountId, list);
  return list;
}

async function fillMissingTitles(accountId: string, list: CalendarEventNotification[]): Promise<void> {
  const ids = Array.from(new Set(
    list.filter((n) => !n.isDraft && n.type !== 'destroyed' && !n.event?.title && n.calendarEventId)
      .map((n) => n.calendarEventId),
  ));
  if (ids.length === 0) return;
  try {
    const response = await jmapClient.request(
      [['CalendarEvent/get', { accountId, ids, properties: ['id', 'title'] }, '0']],
      USING,
    );
    const [method, result] = response.methodResponses?.[0] ?? [];
    if (method !== 'CalendarEvent/get') return;
    const titles = new Map<string, string>();
    for (const event of (result?.list ?? []) as { id: string; title?: string | null }[]) {
      if (event.title) titles.set(event.id, event.title);
    }
    for (const n of list) {
      const title = titles.get(n.calendarEventId);
      if (title && !n.event?.title) n.event = { ...(n.event ?? {}), title };
    }
  } catch {
    // Untitled it is.
  }
}

/** Acknowledges (destroys) event notifications that have been shown. */
export async function destroyCalendarEventNotifications(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const accountId = jmapClient.accountId;
  for (const batch of batched(ids, jmapClient.getMaxObjectsInSet())) {
    await jmapClient.request([
      ['CalendarEventNotification/set', { accountId, destroy: batch }, '0'],
    ], USING);
  }
}
