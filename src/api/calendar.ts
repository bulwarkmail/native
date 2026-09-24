import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { Calendar, CalendarEvent, CalendarRights } from './types';
import { assertSetResult } from './jmap-result';
import { getEffectiveTimeZone } from '../lib/calendar-timezone';
import { SCAN_PROPERTIES, type ScannedCalendarObject } from '../lib/calendar-component-detection';

const USING = [CAPABILITIES.CORE, CAPABILITIES.CALENDARS];

/**
 * IANA time zone of the user — their calendar time-zone setting when set
 * (#755), otherwise the device's — sent as the `timeZone` argument on
 * CalendarEvent/query and CalendarEvent/get. Stalwart interprets LocalDateTime
 * filter values and computes utcStart/utcEnd for floating events in this zone,
 * defaulting to UTC when absent — which shifts range boundaries and
 * floating-event times for any user not in UTC. Stalwart ignores unparseable
 * values, so sending it is always safe.
 */
function getUserTimeZone(): string | undefined {
  try {
    return getEffectiveTimeZone() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Render an instant as the LocalDateTime ("yyyy-MM-ddTHH:mm:ss") wall-clock
 * in `timeZone` — the form CalendarEvent/query's `after`/`before` expect, and
 * which Stalwart interprets in the query's `timeZone`. Accepts ISO strings
 * (with or without a zone) so callers can pass `Date.toISOString()` output.
 */
export function toLocalDateTime(value: string | Date, timeZone?: string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (isNaN(date.getTime())) return typeof value === 'string' ? value.replace(/(\.\d+)?Z$/, '') : '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(date);
    const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
    const hour = get('hour') === '24' ? '00' : get('hour');
    return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}:${get('second')}`;
  } catch {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
      `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }
}

// Shared accounts the server rejected calendar access for — probed once, then
// skipped for the rest of the session (the session lists every account with
// the calendars capability, including ones that only share mail with us).
const calendarAccessDenied = new Set<string>();

export function isCalendarAccessDenied(accountId: string): boolean {
  return calendarAccessDenied.has(accountId);
}

export function resetCalendarAccessDenied(): void {
  calendarAccessDenied.clear();
}

function isAccessDeniedError(err: unknown): boolean {
  const type = (err as { jmapErrorType?: string } | null)?.jmapErrorType;
  return type === 'forbidden' || type === 'accountNotFound';
}

/** Remember an access rejection for a shared account; returns true when it was one. */
export function noteCalendarAccessError(accountId: string, err: unknown): boolean {
  if (!isAccessDeniedError(err)) return false;
  calendarAccessDenied.add(accountId);
  return true;
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

// Stalwart's calcard crate implements JSCalendar 2.0 (jscalendarbis) property
// names: singular `recurrenceRule` / `excludedRecurrenceRule` holding a single
// object, not RFC 8984's plural array forms. Requesting the plural names
// returns no recurrence data at all, so recurring events silently render as
// one-off events (#13). Request the singular names and normalize below.
const CALENDAR_EVENT_PROPERTIES = [
  'id', '@type', 'uid', 'calendarIds', 'title', 'description',
  'start', 'duration', 'timeZone', 'showWithoutTime',
  'utcStart', 'utcEnd', 'status', 'freeBusyStatus',
  'participants', 'alerts', 'useDefaultAlerts', 'recurrenceRule',
  'recurrenceOverrides', 'excludedRecurrenceRule', 'recurrenceId',
  'replyTo', 'organizerCalendarAddress', 'sequence',
  'locations', 'virtualLocations',
  'progress', 'due', 'priority', 'percentComplete',
  'links', 'created', 'updated',
];

/**
 * Normalize Stalwart's singular recurrence property names to the RFC 8984
 * plural array forms the client uses internally. JSCalendar 2.0 defines
 * recurrenceRule as a single object, but Stalwart may also return an array
 * (for events created via JMAP), so both forms are handled. Mirrors webmail's
 * normalizeStalwartPropertyNames.
 */
export function normalizeRecurrenceProperties<T extends Partial<CalendarEvent>>(event: T): T {
  const raw = event as Record<string, unknown>;
  let patched = false;
  const updates: Partial<CalendarEvent> = {};

  if ('recurrenceRule' in raw && !('recurrenceRules' in raw)) {
    const val = raw.recurrenceRule;
    if (val != null && !Array.isArray(val) && typeof val === 'object') {
      updates.recurrenceRules = [val] as CalendarEvent['recurrenceRules'];
    } else {
      updates.recurrenceRules = val as CalendarEvent['recurrenceRules'];
    }
    patched = true;
  }
  if ('excludedRecurrenceRule' in raw && !('excludedRecurrenceRules' in raw)) {
    const val = raw.excludedRecurrenceRule;
    if (val != null && !Array.isArray(val) && typeof val === 'object') {
      updates.excludedRecurrenceRules = [val] as CalendarEvent['excludedRecurrenceRules'];
    } else {
      updates.excludedRecurrenceRules = val as CalendarEvent['excludedRecurrenceRules'];
    }
    patched = true;
  }

  if (!patched) return event;

  const result = { ...event, ...updates } as T;
  delete (result as Record<string, unknown>).recurrenceRule;
  delete (result as Record<string, unknown>).excludedRecurrenceRule;
  return result;
}

const TASK_PROGRESS_NORMALIZATION = new Map<string, string>([
  ['needs-action', 'needs-action'],
  ['needs_action', 'needs-action'],
  ['in-process', 'in-process'],
  ['in_process', 'in-process'],
  ['completed', 'completed'],
  ['cancelled', 'cancelled'],
  ['canceled', 'cancelled'],
]);

/**
 * CalDAV-created tasks can come back with their iCalendar STATUS spelling
 * (`COMPLETED`, `NEEDS_ACTION`) or as `canceled` (stalwartlabs/calcard#20).
 * Map the known spellings onto the JSCalendar values the task filters, the
 * checkbox and the reminders compare against; leave unknown values alone.
 * Mirrors webmail's normalizeCalendarTask.
 */
export function normalizeTaskProgress<T extends Partial<CalendarEvent>>(event: T): T {
  const progress = (event as { progress?: unknown }).progress;
  if (typeof progress !== 'string') return event;
  const normalized = TASK_PROGRESS_NORMALIZATION.get(progress.toLowerCase());
  return normalized === undefined || normalized === progress
    ? event
    : { ...event, progress: normalized };
}

/**
 * Convert the client's plural recurrence arrays to the singular JSCalendar 2.0
 * properties Stalwart expects on write, dropping null rule fields. An empty
 * array (or null) becomes an explicit null so "remove recurrence" round-trips.
 * Mirrors webmail's cleanRecurrenceRules.
 */
function cleanRecurrenceRules(event: Record<string, unknown>): void {
  const keyMap: Record<string, string> = {
    recurrenceRules: 'recurrenceRule',
    excludedRecurrenceRules: 'excludedRecurrenceRule',
  };
  for (const [pluralKey, singularKey] of Object.entries(keyMap)) {
    const rules = event[pluralKey];
    if (rules === undefined) continue;
    delete event[pluralKey];
    if (!Array.isArray(rules)) {
      event[singularKey] = rules;
      continue;
    }
    if (rules.length === 0) {
      event[singularKey] = null;
      continue;
    }
    const rule = rules[0] as Record<string, unknown>;
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(rule)) {
      if (v !== null) cleaned[k] = v;
    }
    event[singularKey] = cleaned;
  }
}

function methodResult<T = any>(res: any, index = 0): T {
  const entry = res?.methodResponses?.[index];
  if (!entry) throw new Error('JMAP: empty method response');
  if (entry[0] === 'error') {
    const err = entry[1] || {};
    // Keep the JMAP error type so callers can tell an expected access
    // rejection (forbidden / accountNotFound on a shared account) apart from
    // a genuine failure.
    throw Object.assign(
      new Error(err.description || err.type || 'JMAP method error'),
      { jmapErrorType: err.type as string | undefined },
    );
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
      // Don't re-probe an account the server already rejected this session.
      if (calendarAccessDenied.has(sharedAccountId)) return [];
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
      } catch (err) {
        noteCalendarAccessError(sharedAccountId, err);
        return [];
      }
    }),
  );
  return [...own, ...shared.flat()];
}

const QUERY_PAGE_SIZE = 1000;
// Backstop against a server that keeps returning full pages; 20 pages is far
// beyond any real calendar window and keeps a bug from looping forever.
const QUERY_MAX_PAGES = 20;

/**
 * Query event ids in a date window. `after`/`before` are instants (ISO, as
 * from `Date.toISOString()`) or LocalDateTime strings; they're sent as
 * LocalDateTime in the query's `timeZone` so Stalwart interprets the bounds
 * in the user's zone. Calendars are restricted via the singular `inCalendar`
 * condition (the plural `inCalendars` fails the whole query with
 * unsupportedFilter on Stalwart); the range and calendar conditions are
 * combined with an AND operator. Without bounds every object is returned.
 * The result set is paged: a window can hold more events than one page, and
 * a truncated page must never pass for a complete answer.
 */
export async function queryEvents(
  calendarIds: string[],
  after: string,
  before: string,
  accountId?: string,
): Promise<string[]> {
  const account = accountId || jmapClient.accountId;
  const timeZone = getUserTimeZone();
  const conditions: Record<string, unknown>[] = [];
  if (calendarIds.length > 0) conditions.push(buildInCalendarFilter(calendarIds));
  const range: Record<string, string> = {};
  if (after) range.after = toLocalDateTime(after, timeZone);
  if (before) range.before = toLocalDateTime(before, timeZone);
  if (Object.keys(range).length > 0) conditions.push(range);
  const filter = conditions.length === 1
    ? conditions[0]
    : conditions.length > 1
      ? { operator: 'AND', conditions }
      : undefined;
  const ids: string[] = [];
  for (let page = 0; page < QUERY_MAX_PAGES; page++) {
    const args: Record<string, unknown> = {
      accountId: account,
      limit: QUERY_PAGE_SIZE,
      position: ids.length,
    };
    if (timeZone) args.timeZone = timeZone;
    if (filter) args.filter = filter;
    const res = await jmapClient.request(
      [['CalendarEvent/query', args, '0']],
      USING,
    );
    const batch = methodResult<{ ids: string[] }>(res).ids ?? [];
    ids.push(...batch);
    if (batch.length < QUERY_PAGE_SIZE) break;
  }
  return ids;
}

/**
 * Every calendar object of an account with just the properties needed to tell
 * tasks from events (see lib/calendar-component-detection). Used to find
 * tasks-only calendars and the task ids; pages through the query so accounts
 * with more than 1000 objects are covered.
 */
export async function scanCalendarObjects(accountId?: string): Promise<ScannedCalendarObject[]> {
  const account = accountId || jmapClient.accountId;
  const pageSize = 1000;
  const ids: string[] = [];
  for (let position = 0; ; position += pageSize) {
    const res = await jmapClient.request(
      [['CalendarEvent/query', { accountId: account, position, limit: pageSize }, '0']],
      USING,
    );
    const page = methodResult<{ ids: string[] }>(res).ids ?? [];
    ids.push(...page);
    if (page.length < pageSize) break;
  }
  if (ids.length === 0) return [];
  const batchSize = jmapClient.getMaxObjectsInGet();
  const all: ScannedCalendarObject[] = [];
  for (let i = 0; i < ids.length; i += batchSize) {
    const res = await jmapClient.request(
      [['CalendarEvent/get', {
        accountId: account,
        ids: ids.slice(i, i + batchSize),
        properties: SCAN_PROPERTIES,
      }, '0']],
      USING,
    );
    all.push(...(methodResult<{ list: ScannedCalendarObject[] }>(res).list ?? []));
  }
  return all;
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
    all.push(...list.map((e) => normalizeTaskProgress(normalizeRecurrenceProperties(e))));
  }
  return all;
}

/**
 * The calendar objects carrying an iCalendar UID, found on the server with a
 * `uid` filter — unlike the store, not limited to the loaded date window.
 * Mirrors webmail's `queryCalendarEvents({ uid })`.
 */
export async function findEventsByUid(uid: string, accountId?: string): Promise<CalendarEvent[]> {
  const account = accountId || jmapClient.accountId;
  const res = await jmapClient.request(
    [['CalendarEvent/query', { accountId: account, filter: { uid } }, '0']],
    USING,
  );
  const ids = methodResult<{ ids: string[] }>(res).ids ?? [];
  return getEvents(ids, accountId);
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
  const payload: Record<string, unknown> = { ...event, calendarIds: { [calendarId]: true } };
  cleanRecurrenceRules(payload);
  const res = await jmapClient.request(
    [['CalendarEvent/set', setArgs(accountId, {
      create: { 'new-event': payload },
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
  // The /set response echoes only server-set properties; merge them over the
  // submitted payload so the store's optimistic insert keeps recurrence data.
  return normalizeRecurrenceProperties({ ...payload, ...created } as CalendarEvent);
}

// Batch-create many events in one CalendarEvent/set. Returns the number
// created; throws when the server refused every one of them, so a refusal
// doesn't read as "nothing new to import".
export async function batchCreateEvents(
  events: Partial<CalendarEvent>[],
  calendarId: string,
  targetAccountId?: string,
): Promise<number> {
  if (events.length === 0) return 0;
  const accountId = targetAccountId || jmapClient.accountId;
  const create: Record<string, Partial<CalendarEvent>> = {};
  events.forEach((e, i) => {
    const payload: Record<string, unknown> = { ...e, calendarIds: { [calendarId]: true } };
    cleanRecurrenceRules(payload);
    create[`evt-${i}`] = payload as Partial<CalendarEvent>;
  });
  const res = await jmapClient.request(
    [['CalendarEvent/set', { accountId, create }, '0']],
    USING,
  );
  const result = methodResult<{
    created?: Record<string, unknown>;
    notCreated?: Record<string, { description?: string; type?: string }>;
  }>(res);
  const count = result.created ? Object.keys(result.created).length : 0;
  if (count === 0) assertSetResult(result, undefined, 'event');
  return count;
}

export async function updateEvent(
  id: string,
  changes: Partial<CalendarEvent> | Record<string, unknown>,
  sendSchedulingMessages?: boolean,
  targetAccountId?: string,
): Promise<void> {
  const accountId = targetAccountId || jmapClient.accountId;
  const patch: Record<string, unknown> = { ...changes };
  cleanRecurrenceRules(patch);
  const res = await jmapClient.request(
    [['CalendarEvent/set', setArgs(accountId, { update: { [id]: patch } }, sendSchedulingMessages), '0']],
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
  const res = await jmapClient.request(
    [['CalendarEvent/set', setArgs(accountId, { destroy: ids }, sendSchedulingMessages), '0']],
    USING,
  );
  assertSetResult(methodResult(res), ids, 'event');
}

// RSVP to an invitation: patch the participant's participationStatus via a JSON
// Pointer (RFC 6901) and let Stalwart send the iTIP REPLY (sendSchedulingMessages).
// Stalwart routes the REPLY to the stored ORGANIZER (organizerCalendarAddress);
// the RFC 8984 replyTo property is retired in jscalendarbis and ignored. The
// caller passes `repairOrganizerAddress` only for events that lack an
// organizer (e.g. imported ones) — attendees may not modify an existing one.
export async function rsvpEvent(
  eventId: string,
  participantId: string,
  status: 'accepted' | 'declined' | 'tentative',
  repairOrganizerAddress?: string | null,
  targetAccountId?: string,
): Promise<void> {
  const accountId = targetAccountId || jmapClient.accountId;
  // Escape per RFC 6901: ~ → ~0, / → ~1.
  const escaped = participantId.replace(/~/g, '~0').replace(/\//g, '~1');
  const patch: Record<string, unknown> = {
    [`participants/${escaped}/participationStatus`]: status,
  };
  if (repairOrganizerAddress) patch.organizerCalendarAddress = repairOrganizerAddress;
  const res = await jmapClient.request(
    [['CalendarEvent/set', { accountId, update: { [eventId]: patch }, sendSchedulingMessages: true }, '0']],
    USING,
  );
  const result = methodResult<{ notUpdated?: Record<string, { description?: string; type?: string }> }>(res);
  const err = result.notUpdated?.[eventId];
  if (err) throw new Error(err.description || err.type || 'Failed to send RSVP');
}

// Parse an uploaded .ics blob into one or more JSCalendar events (server-side).
// `targetAccountId` routes the parse to the account that owns the blob (an
// email in a shared mailbox lives in the sharer's account).
export async function parseCalendarBlob(
  blobId: string,
  targetAccountId?: string,
): Promise<Partial<CalendarEvent>[]> {
  const accountId = targetAccountId || jmapClient.accountId;
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
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list.map(normalizeRecurrenceProperties);
}

// Download the raw text of a calendar blob (the .ics itself) so the iTIP
// METHOD line can be read — JMAP strips the `method=` Content-Type parameter.
// Best-effort: returns null when the download fails.
export async function fetchCalendarBlobText(
  blobId: string,
  targetAccountId?: string,
): Promise<string | null> {
  try {
    await jmapClient.ensureFreshToken();
    // Lazy: blob/client-cert pull in native Expo modules, which the pure
    // JMAP layer (and its node tests) must not load eagerly.
    const [{ getDownloadUrl }, { secureFetch }] = await Promise.all([
      import('./blob'),
      import('../lib/client-cert'),
    ]);
    const url = getDownloadUrl(blobId, 'invite.ics', 'text/calendar', targetAccountId);
    const res = await secureFetch(url, { headers: { Authorization: jmapClient.authHeader } });
    if (!res.ok) return null;
    const text = await res.text();
    return text.length > 2 * 1024 * 1024 ? null : text;
  } catch {
    return null;
  }
}

export async function createCalendar(
  name: string,
  color?: string,
  description?: string,
): Promise<Calendar> {
  const accountId = jmapClient.accountId;
  const props: Record<string, unknown> = { name, color, isVisible: true, isSubscribed: true };
  if (description?.trim()) props.description = description.trim();
  const res = await jmapClient.request(
    [['Calendar/set', {
      accountId,
      create: { 'new-cal': props },
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

// Destroy a calendar. `onDestroyRemoveEvents` removes its events too —
// Stalwart otherwise refuses to delete a non-empty calendar.
export async function deleteCalendar(id: string, targetAccountId?: string): Promise<void> {
  const accountId = targetAccountId || jmapClient.accountId;
  const res = await jmapClient.request(
    [['Calendar/set', { accountId, destroy: [id], onDestroyRemoveEvents: true }, '0']],
    USING,
  );
  const result = methodResult<{ notDestroyed?: Record<string, { description?: string; type?: string }> }>(res);
  const err = result.notDestroyed?.[id];
  if (err) throw new Error(err.description || err.type || 'Failed to delete calendar');
}

export interface CalendarUpdates {
  name?: string;
  color?: string | null;
  description?: string | null;
  sortOrder?: number;
  isSubscribed?: boolean;
}

// Rename / recolour / describe a calendar (Calendar/set update).
export async function updateCalendar(
  id: string,
  updates: CalendarUpdates,
  targetAccountId?: string,
): Promise<void> {
  const accountId = targetAccountId || jmapClient.accountId;
  const res = await jmapClient.request(
    [['Calendar/set', { accountId, update: { [id]: updates } }, '0']],
    USING,
  );
  const result = methodResult<{ notUpdated?: Record<string, { description?: string; type?: string }> }>(res);
  const err = result.notUpdated?.[id];
  if (err) throw new Error(err.description || err.type || 'Failed to update calendar');
}

// Add, update, or remove a principal's rights on an owned calendar via a
// `shareWith/{principalId}` patch (null removes the share).
export async function setCalendarShare(
  calendarId: string,
  principalId: string,
  rights: CalendarRights | null,
  targetAccountId?: string,
): Promise<void> {
  const accountId = targetAccountId || jmapClient.accountId;
  const res = await jmapClient.request(
    [['Calendar/set', {
      accountId,
      update: { [calendarId]: { [`shareWith/${principalId}`]: rights } },
    }, '0']],
    USING,
  );
  const result = methodResult<{ notUpdated?: Record<string, { description?: string; type?: string }> }>(res);
  const err = result.notUpdated?.[calendarId];
  if (err) throw new Error(err.description || err.type || 'Failed to update sharing');
}

/**
 * Remove every event from a calendar. Events that live ONLY in this calendar
 * are destroyed; events also linked to another calendar are unlinked instead
 * (their `calendarIds` loses this calendar) so the user's copy elsewhere is
 * not cascade-deleted. Returns the number of events removed.
 */
export async function clearCalendarEvents(
  calendarId: string,
  targetAccountId?: string,
): Promise<number> {
  const accountId = targetAccountId || jmapClient.accountId;
  let removed = 0;
  // Loop for accounts with more than one query page of objects.
  for (let pass = 0; pass < 20; pass++) {
    const ids = await queryEvents([calendarId], '', '', accountId);
    if (ids.length === 0) break;
    const batchSize = jmapClient.getMaxObjectsInGet();
    const objects: Array<{ id: string; calendarIds?: Record<string, boolean> }> = [];
    for (let i = 0; i < ids.length; i += batchSize) {
      const res = await jmapClient.request(
        [['CalendarEvent/get', {
          accountId,
          ids: ids.slice(i, i + batchSize),
          properties: ['id', 'calendarIds'],
        }, '0']],
        USING,
      );
      objects.push(...(methodResult<{ list: typeof objects }>(res).list ?? []));
    }
    const toDestroy: string[] = [];
    const toUnlink: Array<{ id: string; calendarIds: Record<string, boolean> }> = [];
    for (const obj of objects) {
      const others = { ...(obj.calendarIds || {}) };
      delete others[calendarId];
      if (Object.keys(others).length === 0) toDestroy.push(obj.id);
      else toUnlink.push({ id: obj.id, calendarIds: others });
    }
    if (toDestroy.length > 0) {
      const res = await jmapClient.request(
        [['CalendarEvent/set', { accountId, destroy: toDestroy }, '0']],
        USING,
      );
      const result = methodResult<{ destroyed?: string[] }>(res);
      assertSetResult(result, toDestroy, 'event');
      removed += (result.destroyed ?? []).length;
    }
    if (toUnlink.length > 0) {
      const update: Record<string, unknown> = {};
      for (const { id, calendarIds } of toUnlink) update[id] = { calendarIds };
      const res = await jmapClient.request(
        [['CalendarEvent/set', { accountId, update }, '0']],
        USING,
      );
      const result = methodResult<{ updated?: Record<string, unknown> }>(res);
      assertSetResult(result, Object.keys(update), 'event');
      removed += Object.keys(result.updated ?? {}).length;
    }
    if (toDestroy.length === 0 && toUnlink.length === 0) break;
    if (ids.length < 1000) break;
  }
  return removed;
}
