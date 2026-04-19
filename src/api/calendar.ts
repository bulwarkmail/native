import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { Calendar, CalendarEvent } from './types';

const USING = [CAPABILITIES.CORE, CAPABILITIES.CALENDARS];

const CALENDAR_EVENT_PROPERTIES = [
  'id', '@type', 'uid', 'calendarIds', 'title', 'description',
  'start', 'duration', 'timeZone', 'showWithoutTime',
  'utcStart', 'utcEnd', 'status', 'freeBusyStatus',
  'participants', 'alerts', 'recurrenceRules',
  'recurrenceOverrides', 'excludedRecurrenceRules',
  'links', 'created', 'updated',
];

function methodResult<T = any>(res: any, index = 0): T {
  const entry = res?.methodResponses?.[index];
  if (!entry) throw new Error('JMAP: empty method response');
  if (entry[0] === 'error') {
    const err = entry[1] || {};
    throw new Error(err.description || err.type || 'JMAP method error');
  }
  return entry[1] as T;
}

export async function getCalendars(): Promise<Calendar[]> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['Calendar/get', { accountId }, '0']],
    USING,
  );
  return methodResult<{ list: Calendar[] }>(res).list ?? [];
}

export async function queryEvents(
  _calendarIds: string[],
  _after: string,
  _before: string,
): Promise<string[]> {
  // Stalwart rejects inCalendars/after/before filters on CalendarEvent/query.
  // Fetch all events in the account; calendar visibility + date filtering is
  // done client-side.
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['CalendarEvent/query', { accountId, limit: 1000 }, '0']],
    USING,
  );
  return methodResult<{ ids: string[] }>(res).ids ?? [];
}

export async function getEvents(ids: string[]): Promise<CalendarEvent[]> {
  if (ids.length === 0) return [];
  const accountId = jmapClient.accountId;
  const batchSize = jmapClient.getMaxObjectsInGet();
  const all: CalendarEvent[] = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const res = await jmapClient.request(
      [['CalendarEvent/get', {
        accountId,
        ids: batch,
        properties: CALENDAR_EVENT_PROPERTIES,
      }, '0']],
      USING,
    );
    const list = methodResult<{ list: CalendarEvent[] }>(res).list ?? [];
    all.push(...list);
  }
  return all;
}

export async function createEvent(
  event: Partial<CalendarEvent>,
  calendarId: string,
): Promise<CalendarEvent> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['CalendarEvent/set', {
      accountId,
      create: {
        'new-event': { ...event, calendarIds: { [calendarId]: true } },
      },
    }, '0']],
    USING,
  );
  return res.methodResponses[0][1].created['new-event'];
}

export async function updateEvent(
  id: string,
  changes: Partial<CalendarEvent>,
): Promise<void> {
  const accountId = jmapClient.accountId;
  await jmapClient.request(
    [['CalendarEvent/set', { accountId, update: { [id]: changes } }, '0']],
    USING,
  );
}

export async function deleteEvents(ids: string[]): Promise<void> {
  const accountId = jmapClient.accountId;
  await jmapClient.request(
    [['CalendarEvent/set', { accountId, destroy: ids }, '0']],
    USING,
  );
}
