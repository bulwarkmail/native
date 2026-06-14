import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { Calendar, CalendarEvent } from './types';

const USING = [CAPABILITIES.CORE, CAPABILITIES.CALENDARS];

/**
 * IANA time zone of the device, sent as the `timeZone` argument on
 * CalendarEvent/query and CalendarEvent/get. Stalwart interprets LocalDateTime
 * filter values and computes utcStart/utcEnd for floating events in this zone,
 * defaulting to UTC when absent — which shifts range boundaries and
 * floating-event times for any user not in UTC. Stalwart ignores unparseable
 * values, so sending it is always safe.
 */
function getUserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build a CalendarEvent/query filter restricting results to the given
 * calendars. Stalwart implements the singular `inCalendar` condition (one
 * calendar id per condition), not the draft's plural `inCalendars` array —
 * sending the plural form fails the whole query with `unsupportedFilter`.
 * Multiple calendars are expressed as an OR of singular conditions.
 */
function buildInCalendarFilter(calendarIds: string[]): Record<string, unknown> {
  if (calendarIds.length === 1) {
    return { inCalendar: calendarIds[0] };
  }
  return {
    operator: 'OR',
    conditions: calendarIds.map((id) => ({ inCalendar: id })),
  };
}

const CALENDAR_EVENT_PROPERTIES = [
  'id', '@type', 'uid', 'calendarIds', 'title', 'description',
  'start', 'duration', 'timeZone', 'showWithoutTime',
  'utcStart', 'utcEnd', 'status', 'freeBusyStatus',
  'participants', 'alerts', 'useDefaultAlerts', 'recurrenceRules',
  'recurrenceOverrides', 'excludedRecurrenceRules',
  'replyTo', 'organizerCalendarAddress', 'sequence',
  'locations', 'virtualLocations',
  'progress', 'due', 'priority', 'percentComplete',
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

// Other session accounts that expose the calendars capability hold calendars
// shared with the user (JMAP surfaces shared data under the sharer's account).
function sharedCalendarAccountIds(): string[] {
  const session = jmapClient.currentSession;
  const primary = jmapClient.accountId;
  return Object.entries(session?.accounts ?? {})
    .filter(([id, info]) =>
      id !== primary && !!info.accountCapabilities?.[CAPABILITIES.CALENDARS])
    .map(([id]) => id);
}

export async function getCalendars(): Promise<Calendar[]> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['Calendar/get', { accountId }, '0']],
    USING,
  );
  const own = methodResult<{ list: Calendar[] }>(res).list ?? [];

  // Calendars shared with the user live in other session accounts. Failures
  // there (revoked share, transient error) must not hide the user's own
  // calendars, so each shared account is fetched best-effort.
  const shared = await Promise.all(
    sharedCalendarAccountIds().map(async (sharedAccountId) => {
      try {
        const sharedRes = await jmapClient.request(
          [['Calendar/get', { accountId: sharedAccountId }, '0']],
          USING,
        );
        const list = methodResult<{ list: Calendar[] }>(sharedRes).list ?? [];
        // JMAP calendar ids are only unique within an account, so a shared
        // "default" calendar collides with the user's own "default". Namespace
        // the id (keeping the real id in originalId) so visibility toggles,
        // event-query routing, and create/default mutations don't cross wires.
        // Mirrors webmail's getAllCalendars.
        return list.map((cal) => ({
          ...cal,
          id: `${sharedAccountId}:${cal.id}`,
          originalId: cal.id,
          accountId: sharedAccountId,
          isShared: true,
        }));
      } catch {
        return [];
      }
    }),
  );
  return [...own, ...shared.flat()];
}

export async function queryEvents(
  calendarIds: string[],
  _after: string,
  _before: string,
  accountId?: string,
): Promise<string[]> {
  // Stalwart rejects after/before filters on CalendarEvent/query; date
  // filtering is done client-side. Calendars are restricted via the singular
  // `inCalendar` condition (the plural `inCalendars` fails the whole query
  // with unsupportedFilter on Stalwart).
  const account = accountId || jmapClient.accountId;
  const args: Record<string, unknown> = { accountId: account, limit: 1000 };
  const timeZone = getUserTimeZone();
  if (timeZone) args.timeZone = timeZone;
  if (calendarIds.length > 0) args.filter = buildInCalendarFilter(calendarIds);
  const res = await jmapClient.request(
    [['CalendarEvent/query', args, '0']],
    USING,
  );
  return methodResult<{ ids: string[] }>(res).ids ?? [];
}

export async function getEvents(ids: string[], accountId?: string): Promise<CalendarEvent[]> {
  if (ids.length === 0) return [];
  const account = accountId || jmapClient.accountId;
  const timeZone = getUserTimeZone();
  const batchSize = jmapClient.getMaxObjectsInGet();
  const all: CalendarEvent[] = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const batch = ids.slice(i, i + batchSize);
    const res = await jmapClient.request(
      [['CalendarEvent/get', {
        accountId: account,
        ids: batch,
        properties: CALENDAR_EVENT_PROPERTIES,
        ...(timeZone ? { timeZone } : {}),
      }, '0']],
      USING,
    );
    const list = methodResult<{ list: CalendarEvent[] }>(res).list ?? [];
    all.push(...list);
  }
  return all;
}

// `sendSchedulingMessages` asks Stalwart to deliver iMIP (RFC 6047) invitation
// / reply / cancellation emails to participants. We pass it whenever an event
// has participants so creating/updating/deleting a meeting notifies attendees.
function setArgs(
  accountId: string,
  payload: Record<string, unknown>,
  sendSchedulingMessages?: boolean,
): Record<string, unknown> {
  const args: Record<string, unknown> = { accountId, ...payload };
  if (sendSchedulingMessages !== undefined) {
    args.sendSchedulingMessages = sendSchedulingMessages;
  }
  return args;
}

export async function createEvent(
  event: Partial<CalendarEvent>,
  calendarId: string,
  sendSchedulingMessages?: boolean,
  targetAccountId?: string,
): Promise<CalendarEvent> {
  const accountId = targetAccountId || jmapClient.accountId;
  const res = await jmapClient.request(
    [['CalendarEvent/set', setArgs(accountId, {
      create: {
        'new-event': { ...event, calendarIds: { [calendarId]: true } },
      },
    }, sendSchedulingMessages), '0']],
    USING,
  );
  const result = methodResult<{
    created?: Record<string, CalendarEvent>;
    notCreated?: Record<string, { description?: string; type?: string }>;
  }>(res);
  const created = result.created?.['new-event'];
  if (!created) {
    const err = result.notCreated?.['new-event'];
    throw new Error(err?.description || err?.type || 'Failed to create event');
  }
  return created;
}

// Batch-create many events in one CalendarEvent/set. Returns the number created.
export async function batchCreateEvents(
  events: Partial<CalendarEvent>[],
  calendarId: string,
  targetAccountId?: string,
): Promise<number> {
  if (events.length === 0) return 0;
  const accountId = targetAccountId || jmapClient.accountId;
  const create: Record<string, Partial<CalendarEvent>> = {};
  events.forEach((e, i) => {
    create[`evt-${i}`] = { ...e, calendarIds: { [calendarId]: true } };
  });
  const res = await jmapClient.request(
    [['CalendarEvent/set', { accountId, create }, '0']],
    USING,
  );
  const result = methodResult<{ created?: Record<string, unknown> }>(res);
  return result.created ? Object.keys(result.created).length : 0;
}

export async function updateEvent(
  id: string,
  changes: Partial<CalendarEvent> | Record<string, unknown>,
  sendSchedulingMessages?: boolean,
  targetAccountId?: string,
): Promise<void> {
  const accountId = targetAccountId || jmapClient.accountId;
  const res = await jmapClient.request(
    [['CalendarEvent/set', setArgs(accountId, { update: { [id]: changes } }, sendSchedulingMessages), '0']],
    USING,
  );
  const result = methodResult<{ notUpdated?: Record<string, { description?: string; type?: string }> }>(res);
  const err = result.notUpdated?.[id];
  if (err) throw new Error(err.description || err.type || 'Failed to update event');
}

export async function deleteEvents(
  ids: string[],
  sendSchedulingMessages?: boolean,
  targetAccountId?: string,
): Promise<void> {
  const accountId = targetAccountId || jmapClient.accountId;
  await jmapClient.request(
    [['CalendarEvent/set', setArgs(accountId, { destroy: ids }, sendSchedulingMessages), '0']],
    USING,
  );
}

// RSVP to an invitation: patch the participant's participationStatus via a JSON
// Pointer (RFC 6901) and let Stalwart send the iTIP REPLY (sendSchedulingMessages).
export async function rsvpEvent(
  eventId: string,
  participantId: string,
  status: 'accepted' | 'declined' | 'tentative',
  replyTo?: Record<string, string> | null,
  targetAccountId?: string,
): Promise<void> {
  const accountId = targetAccountId || jmapClient.accountId;
  // Escape per RFC 6901: ~ → ~0, / → ~1.
  const escaped = participantId.replace(/~/g, '~0').replace(/\//g, '~1');
  const patch: Record<string, unknown> = {
    [`participants/${escaped}/participationStatus`]: status,
  };
  if (replyTo) patch.replyTo = replyTo;
  const res = await jmapClient.request(
    [['CalendarEvent/set', { accountId, update: { [eventId]: patch }, sendSchedulingMessages: true }, '0']],
    USING,
  );
  const result = methodResult<{ notUpdated?: Record<string, { description?: string; type?: string }> }>(res);
  const err = result.notUpdated?.[eventId];
  if (err) throw new Error(err.description || err.type || 'Failed to send RSVP');
}

// Parse an uploaded .ics blob into one or more JSCalendar events (server-side).
export async function parseCalendarBlob(blobId: string): Promise<Partial<CalendarEvent>[]> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['CalendarEvent/parse', { accountId, blobIds: [blobId] }, '0']],
    USING,
  );
  const result = methodResult<{
    parsed?: Record<string, CalendarEvent | CalendarEvent[]>;
    notParsable?: string[];
    notFound?: string[];
  }>(res);
  if (result.notParsable?.includes(blobId)) throw new Error('Invalid calendar file format');
  if (result.notFound?.includes(blobId)) throw new Error('Uploaded file not found');
  const parsed = result.parsed?.[blobId];
  if (!parsed) return [];
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function createCalendar(
  name: string,
  color?: string,
): Promise<Calendar> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['Calendar/set', {
      accountId,
      create: { 'new-cal': { name, color, isVisible: true, isSubscribed: true } },
    }, '0']],
    USING,
  );
  const result = methodResult<{
    created?: Record<string, Calendar>;
    notCreated?: Record<string, { description?: string; type?: string }>;
  }>(res);
  const created = result.created?.['new-cal'];
  if (!created) {
    const err = result.notCreated?.['new-cal'];
    throw new Error(err?.description || err?.type || 'Failed to create calendar');
  }
  return created;
}

/**
 * Mark a calendar as the account default. `isDefault` is read-only in
 * Stalwart's Calendar/set — the default is changed via the
 * `onSuccessSetIsDefault` request argument instead.
 */
export async function setDefaultCalendar(
  calendarId: string,
  targetAccountId?: string,
): Promise<void> {
  const accountId = targetAccountId || jmapClient.accountId;
  const res = await jmapClient.request(
    [['Calendar/set', { accountId, onSuccessSetIsDefault: calendarId }, '0']],
    USING,
  );
  methodResult(res);
}

// Destroy a calendar. `onDestroyEvents: 'destroy'` removes its events too —
// Stalwart otherwise refuses to delete a non-empty calendar.
export async function deleteCalendar(id: string): Promise<void> {
  const accountId = jmapClient.accountId;
  await jmapClient.request(
    [['Calendar/set', { accountId, destroy: [id], onDestroyRemoveEvents: true }, '0']],
    USING,
  );
}
