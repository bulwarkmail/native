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

export async function getCalendars(): Promise<Calendar[]> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['Calendar/get', { accountId }, '0']],
    USING,
  );
  return res.methodResponses[0][1].list;
}

export async function queryEvents(
  calendarIds: string[],
  after: string,
  before: string,
): Promise<string[]> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['CalendarEvent/query', {
      accountId,
      filter: { inCalendars: calendarIds, after, before, types: ['Event'] },
      sort: [{ property: 'start', isAscending: true }],
      limit: 500,
    }, '0']],
    USING,
  );
  return res.methodResponses[0][1].ids;
}

export async function getEvents(ids: string[]): Promise<CalendarEvent[]> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['CalendarEvent/get', {
      accountId,
      ids,
      properties: CALENDAR_EVENT_PROPERTIES,
    }, '0']],
    USING,
  );
  return res.methodResponses[0][1].list;
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
