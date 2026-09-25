import { jmapClient } from './jmap-client';
import { CAPABILITIES } from './types';
import type { Calendar, CalendarEvent, CalendarRights } from './types';
import { JMAPMethodError, assertSetResult, batched, jmapErrorType, requireMethodResult } from './jmap-result';
import { getEffectiveTimeZone } from '../lib/calendar-timezone';
import { SCAN_PROPERTIES, type ScannedCalendarObject } from '../lib/calendar-component-detection';
import {
  RECURRENCE_BASE_PROPERTIES,
  SYNTHETIC_ID_PROBE,
  hydrateRecurrenceInstances,
  isServerRecurrenceInstance,
  parseDurationSeconds,
} from '../lib/recurrence-instances';

const USING = [CAPABILITIES.CORE, CAPABILITIES.CALENDARS];

/**
 * IANA time zone of the user — their calendar time-zone setting when set
 * (#755), otherwise the device's. Stalwart interprets LocalDateTime filter
 * values and computes utcStart/utcEnd for floating events in the `timeZone`
 * argument of CalendarEvent/query and CalendarEvent/get, defaulting to UTC
 * when absent — which shifts range boundaries and floating-event times for
 * any user not in UTC. A zone the server's time zone database lacks is read
 * as UTC by 0.16 and refused by 1.0, which fails the whole call;
 * calendarTimeZone decides what is actually sent.
 */
function getUserTimeZone(): string | undefined {
  try {
    return getEffectiveTimeZone() || undefined;
  } catch {
    return undefined;
  }
}

// ─── Time zone check ─────────────────────────────────────
// Stalwart 1.0 answers a CalendarEvent/get or /query whose `timeZone` it
// does not know with invalidArguments "Invalid timeZone \"X\"". Its database
// holds the IANA names, matched case-sensitively, and no offsets, so a
// "+01:00" or "europe/berlin" that Intl may accept is refused.

const TIME_ZONE_PROBE_CALL_ID = 'time-zone-probe';
// Per server and zone: the check of the zone, settled or in flight.
const timeZoneProbes = new Map<string, Promise<void>>();
// Per server and zone: refused by the server.
const refusedTimeZones = new Set<string>();

function timeZoneKey(timeZone: string): string {
  return `${jmapClient.currentSession?.apiUrl ?? ''}|${timeZone}`;
}

function isTimeZoneRefusal(type: string | undefined, description: string | undefined): boolean {
  return type === 'invalidArguments' && /invalid timeZone/i.test(description ?? '');
}

/** A get of no events, which the server only answers if it knows `timeZone`. */
function timeZoneProbeCall(accountId: string, timeZone: string): [string, Record<string, unknown>, string] {
  return ['CalendarEvent/get', { accountId, ids: [], properties: ['id'], timeZone }, TIME_ZONE_PROBE_CALL_ID];
}

function refuseTimeZone(key: string, timeZone: string): void {
  if (refusedTimeZones.has(key)) return;
  refusedTimeZones.add(key);
  console.warn(
    `[calendar] The server does not know the time zone "${timeZone}"; asking it for UTC times instead. `
    + 'Events without a time zone of their own may show shifted.',
  );
}

/**
 * Take the verdict on `timeZone` from a response that carried its probe. A
 * request that failed outright is not remembered, so the next calendar list
 * checks again.
 */
function rememberTimeZoneProbe(key: string, timeZone: string, pending: Promise<any>): void {
  const probe: Promise<void> = pending.then(
    (res) => {
      const entry = ((res?.methodResponses ?? []) as [string, any, string][]).find(
        (r) => r[2] === TIME_ZONE_PROBE_CALL_ID,
      );
      if (entry?.[0] === 'error' && isTimeZoneRefusal(entry[1]?.type, entry[1]?.description)) {
        refuseTimeZone(key, timeZone);
      }
    },
    () => {
      if (timeZoneProbes.get(key) === probe) timeZoneProbes.delete(key);
    },
  );
  timeZoneProbes.set(key, probe);
}

/**
 * The `timeZone` argument for CalendarEvent/get and /query: the user's zone,
 * or UTC once the server refused it. The first calendar list checks the zone
 * on the way (getCalendars); a read that starts without that answer sends
 * the user's zone and is repeated in UTC if refused (withCalendarTimeZone).
 */
async function calendarTimeZone(): Promise<string | undefined> {
  const timeZone = getUserTimeZone();
  if (!timeZone) return undefined;
  const key = timeZoneKey(timeZone);
  await timeZoneProbes.get(key);
  return refusedTimeZones.has(key) ? 'UTC' : timeZone;
}

/** Run a calendar read in calendarTimeZone, and once more in UTC when the server refuses that zone. */
async function withCalendarTimeZone<T>(read: (timeZone: string | undefined) => Promise<T>): Promise<T> {
  const timeZone = await calendarTimeZone();
  try {
    return await read(timeZone);
  } catch (error) {
    if (!timeZone || timeZone === 'UTC') throw error;
    if (!isTimeZoneRefusal(jmapErrorType(error), error instanceof Error ? error.message : undefined)) throw error;
    refuseTimeZone(timeZoneKey(timeZone), timeZone);
    return read('UTC');
  }
}

/** Forget the time zone checks: a new session may reach an upgraded server. */
export function resetTimeZoneChecks(): void {
  timeZoneProbes.clear();
  refusedTimeZones.clear();
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
  const type = jmapErrorType(err);
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
//
// No `recurrenceOverrides`: Stalwart 1.0 fails a CalendarEvent/get that asks
// for them together with `utcStart` or `utcEnd` (invalidArguments, before any
// id is read). getEvents reads them with a get of their own.
const CALENDAR_EVENT_PROPERTIES = [
  'id', '@type', 'uid', 'calendarIds', 'title', 'description',
  'start', 'duration', 'timeZone', 'showWithoutTime',
  'utcStart', 'utcEnd', 'status', 'freeBusyStatus',
  'participants', 'alerts', 'useDefaultAlerts', 'recurrenceRule',
  'excludedRecurrenceRule', 'recurrenceId',
  'replyTo', 'organizerCalendarAddress', 'sequence',
  'locations', 'virtualLocations',
  'progress', 'due', 'priority', 'percentComplete',
  'links', 'created', 'updated',
];

/** The second get of getEvents: the overrides, by id. */
const OVERRIDE_PROPERTIES = ['id', 'recurrenceOverrides'];

// Asked for only on server-expanded ranges: servers that expand recurrences
// for the app (see supportsSyntheticCalendarIds) know these. An occurrence
// gets its series' overrides from hydrateExpandedOccurrences instead.
const EXPANDED_EVENT_PROPERTIES = [...CALENDAR_EVENT_PROPERTIES, 'baseEventId', 'recurrenceIdTimeZone'];

// What a UID look-up compares (import de-duplication, iCal subscription sync):
// reading whole events of a whole account for it would be wasted.
const EVENT_IDENTITY_PROPERTIES = ['id', 'uid', 'calendarIds'];

// Client-side fields that must never reach CalendarEvent/set.
const CLIENT_ONLY_EVENT_KEYS = [
  'originalId', 'baseEventId', 'originalCalendarIds', 'accountId', 'isShared', 'localAccountId',
];

function stripClientOnlyFields(payload: Record<string, unknown>): void {
  for (const key of CLIENT_ONLY_EVENT_KEYS) delete payload[key];
}

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

/**
 * The answer to call `callId` (the first call when omitted). A method error
 * throws a JMAPMethodError with the JMAP type, so callers can tell an
 * expected access rejection (forbidden / accountNotFound on a shared
 * account) apart from a genuine failure.
 */
function methodResult<T = any>(res: any, callId?: string): T {
  return requireMethodResult<T>(res, callId);
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

// ─── Synthetic ids ───────────────────────────────────────
// Whether CalendarEvent/set accepts the synthetic ids that
// CalendarEvent/query?expandRecurrences=true hands out (Stalwart >= 0.16.20),
// per server and account. Mirrors the webmail's supportsSyntheticCalendarIds.

const SYNTHETIC_ID_PROBE_CALL_ID = 'synthetic-id-probe';
const syntheticIdSupport = new Map<string, Promise<boolean>>();

function syntheticIdProbeKey(): string | null {
  try {
    return `${jmapClient.currentSession?.apiUrl ?? ''}|${jmapClient.accountId}`;
  } catch {
    return null;
  }
}

function syntheticIdProbeCall(accountId: string): [string, Record<string, unknown>, string] {
  return ['CalendarEvent/set', { accountId, update: { [SYNTHETIC_ID_PROBE]: {} } }, SYNTHETIC_ID_PROBE_CALL_ID];
}

/**
 * Derive (and cache) the probe verdict from a response that carried the
 * probe call. A server that still rejects synthetic ids answers
 * `invalidProperties` before looking the event up, one that supports them
 * answers `notFound`; anything else counts as unsupported. A request that
 * failed outright is not remembered, so the next range load probes again.
 */
function rememberSyntheticIdProbe(key: string, pending: Promise<any>): void {
  const verdict: Promise<boolean> = pending.then(
    (res) => {
      const entry = ((res?.methodResponses ?? []) as [string, any, string][]).find(
        (r) => r[2] === SYNTHETIC_ID_PROBE_CALL_ID,
      );
      if (!entry || entry[0] !== 'CalendarEvent/set') return false;
      return entry[1]?.notUpdated?.[SYNTHETIC_ID_PROBE]?.type === 'notFound';
    },
    () => {
      if (syntheticIdSupport.get(key) === verdict) syntheticIdSupport.delete(key);
      return false;
    },
  );
  syntheticIdSupport.set(key, verdict);
}

/**
 * Whether the server expands recurring events for the app: it accepts the
 * synthetic occurrence ids in CalendarEvent/set, so each occurrence can be
 * edited through its own id. Probed once per server and account with a
 * side-effect-free update of an id that cannot exist; the first Calendar/get
 * carries the probe along (getCalendars), so the usual start-up pays no
 * extra round trip.
 */
export function supportsSyntheticCalendarIds(): Promise<boolean> {
  const key = syntheticIdProbeKey();
  if (!key) return Promise.resolve(false);
  if (!syntheticIdSupport.has(key)) {
    rememberSyntheticIdProbe(
      key,
      jmapClient.request([syntheticIdProbeCall(jmapClient.accountId)], USING),
    );
  }
  return syntheticIdSupport.get(key)!;
}

export function resetSyntheticIdSupport(): void {
  syntheticIdSupport.clear();
}

export async function getCalendars(): Promise<Calendar[]> {
  const accountId = jmapClient.accountId;
  const probeKey = syntheticIdProbeKey();
  const carriesProbe = !!probeKey && !syntheticIdSupport.has(probeKey);
  const methodCalls: [string, Record<string, unknown>, string][] = [['Calendar/get', { accountId }, '0']];
  if (carriesProbe) methodCalls.push(syntheticIdProbeCall(accountId));
  // The user's time zone is checked on the way too (calendarTimeZone).
  const timeZone = getUserTimeZone();
  const zoneKey = timeZone && timeZone !== 'UTC' ? timeZoneKey(timeZone) : null;
  const checksTimeZone = !!zoneKey && !timeZoneProbes.has(zoneKey);
  if (checksTimeZone) methodCalls.push(timeZoneProbeCall(accountId, timeZone!));
  const pending = jmapClient.request(methodCalls, USING);
  if (carriesProbe) rememberSyntheticIdProbe(probeKey!, pending);
  if (checksTimeZone) rememberTimeZoneProbe(zoneKey!, timeZone!, pending);
  const res = await pending;
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
  return withCalendarTimeZone(async (timeZone) => {
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
  });
}

// ─── Expanded ranges ─────────────────────────────────────
// Stalwart 1.0 refuses an expanded CalendarEvent/query that spans more than
// the account's `maxExpandedQueryDuration` (expandDurationTooLarge), and
// one that expands to more occurrences than it allows
// (cannotCalculateOccurrences; 0.16 said invalidArguments). The loaded
// window of a freely scrolling view grows well past a year, so a range is
// queried in chunks within the limit.

const DAY_SECONDS = 86_400;
// Chunks stay a day below maxExpandedQueryDuration: the server measures the
// span in UTC after resolving the bounds in the request time zone, so a DST
// change or an ambiguous local time moves it.
const EXPANDED_CHUNK_SLACK = DAY_SECONDS;
// A chunk that still expands to too many occurrences is halved down to about
// a week, one the server finds too long down to an hour; past that, and past
// this many queries for one range, the range is expanded on the device.
const MIN_OCCURRENCE_CHUNK = 7 * DAY_SECONDS;
const MIN_DURATION_CHUNK = 3600;
const MAX_EXPANDED_CHUNKS = 64;

/**
 * Part of an expanded range, in seconds of the request time zone's wall
 * clock (the LocalDateTime bounds counted as if they were UTC).
 */
interface RangeChunk {
  start: number;
  end: number;
  /** Where the next page of this chunk starts. */
  position: number;
}

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;

/** A LocalDateTime such as "2026-09-01T00:00:00" as wall-clock seconds, or null. */
function wallClockSeconds(value: string): number | null {
  const match = LOCAL_DATE_TIME.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  return date.getTime() / 1000;
}

function localDateTimeOf(seconds: number): string {
  const date = new Date(seconds * 1000);
  const pad = (n: number, length = 2) => String(n).padStart(length, '0');
  return `${pad(date.getUTCFullYear(), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
    + `T${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

/**
 * [start, end] cut into chunks of at most `span` seconds, or null when that
 * takes more than MAX_EXPANDED_CHUNKS. Neighbours share a second: the server
 * counts an occurrence in a range only when it overlaps it strictly, so one
 * that sits exactly on a border would belong to neither chunk.
 */
function chunkRange(start: number, end: number, span: number): RangeChunk[] | null {
  if (span < 2) return null;
  const chunks: RangeChunk[] = [];
  for (let from = start; chunks.length < MAX_EXPANDED_CHUNKS; from = chunks[chunks.length - 1].end - 1) {
    const to = Math.min(from + span, end);
    chunks.push({ start: from, end: to, position: 0 });
    if (to >= end) return chunks;
  }
  return null;
}

/**
 * Whether an expanded query failed on the server's cap on occurrences per
 * query: `cannotCalculateOccurrences` on Stalwart 1.0, `invalidArguments`
 * ("The number of expanded recurrences exceeds the server limit") on 0.16.
 */
function isOccurrenceLimitError(error: unknown): boolean {
  const type = jmapErrorType(error);
  if (type === 'cannotCalculateOccurrences') return true;
  return type === 'invalidArguments' && /exceeds/i.test(error instanceof Error ? error.message : '');
}

/**
 * What to query instead of a chunk the server refused: its two halves, or
 * null when it is already as small as it gets and the range has to be
 * expanded on the device. Any other refusal is rethrown.
 */
function splitRefusedChunk(chunk: RangeChunk, error: unknown): RangeChunk[] | null {
  let minimum: number;
  if (jmapErrorType(error) === 'expandDurationTooLarge') minimum = MIN_DURATION_CHUNK;
  else if (isOccurrenceLimitError(error)) minimum = MIN_OCCURRENCE_CHUNK;
  else throw error;
  if (chunk.end - chunk.start <= minimum) return null;
  const middle = Math.floor((chunk.start + chunk.end) / 2);
  return [
    { start: chunk.start, end: middle, position: 0 },
    { start: middle - 1, end: chunk.end, position: 0 },
  ];
}

/**
 * The longest range an expanded query may span, in seconds:
 * `maxExpandedQueryDuration` of the account's calendars capability (the
 * primary account's when the account has none), an iCalendar duration such
 * as "P52W1D". Every 0.16 advertises 365 days without enforcing it.
 */
function maxExpandedQuerySeconds(accountId: string): number | null {
  const accounts = jmapClient.currentSession?.accounts;
  for (const id of [accountId, jmapClient.accountId]) {
    const capability = accounts?.[id]?.accountCapabilities?.[CAPABILITIES.CALENDARS] as
      | { maxExpandedQueryDuration?: unknown }
      | undefined;
    const duration = capability?.maxExpandedQueryDuration;
    const seconds = typeof duration === 'string' ? parseDurationSeconds(duration) : null;
    if (seconds) return seconds;
  }
  return null;
}

/**
 * Occurrence ids in a date window, with recurring series expanded by the
 * server into one synthetic id per occurrence (CalendarEvent/query
 * `expandRecurrences`). Only for servers that accept those ids in
 * CalendarEvent/set (supportsSyntheticCalendarIds).
 *
 * Each query's filter is one FilterCondition of the two bounds - Stalwart
 * 1.0 refuses operators in an expanded query - so the caller keeps the
 * calendars it asked for. The window goes out in chunks within the server's
 * maxExpandedQueryDuration, as many per request as maxCallsInRequest
 * allows; a synthetic id does not depend on the chunk it was found in, so
 * an occurrence two chunks share is kept once. A chunk the server still
 * refuses is halved: when it is too long, or when it expands to too many
 * occurrences, down to about a week. `null` when even that is refused: the
 * caller then expands the whole window on the device (mixing in occurrences
 * found so far would show series twice).
 */
export async function queryExpandedEvents(
  after: string,
  before: string,
  accountId?: string,
): Promise<string[] | null> {
  const account = accountId || jmapClient.accountId;
  return withCalendarTimeZone((timeZone) => queryExpandedEventsIn(account, after, before, timeZone));
}

/** queryExpandedEvents with the bounds and the request in `timeZone`. */
async function queryExpandedEventsIn(
  account: string,
  after: string,
  before: string,
  timeZone: string | undefined,
): Promise<string[] | null> {
  const bounds = { after: toLocalDateTime(after, timeZone), before: toLocalDateTime(before, timeZone) };
  const baseArgs: Record<string, unknown> = { accountId: account, expandRecurrences: true };
  if (timeZone) baseArgs.timeZone = timeZone;

  const start = wallClockSeconds(bounds.after);
  const end = wallClockSeconds(bounds.before);
  if (start === null || end === null || end <= start) return queryExpandedRange(baseArgs, bounds);
  const maxSeconds = maxExpandedQuerySeconds(account);
  const span = maxSeconds === null
    ? end - start
    : maxSeconds - Math.min(EXPANDED_CHUNK_SLACK, Math.floor(maxSeconds / 2));
  const chunks = chunkRange(start, end, span);
  if (!chunks) return null;

  const ids = new Set<string>();
  let pending = chunks;
  let chunksSent = 0;
  while (pending.length > 0) {
    const batch = pending.splice(0, Math.max(1, jmapClient.getMaxCallsInRequest()));
    // Pages are bounded below; splitting is what has to stop somewhere.
    chunksSent += batch.filter((chunk) => chunk.position === 0).length;
    if (chunksSent > MAX_EXPANDED_CHUNKS) return null;
    const res = await jmapClient.request(batch.map((chunk, i): [string, Record<string, unknown>, string] => [
      'CalendarEvent/query',
      {
        ...baseArgs,
        filter: { after: localDateTimeOf(chunk.start), before: localDateTimeOf(chunk.end) },
        position: chunk.position,
        limit: QUERY_PAGE_SIZE,
      },
      String(i),
    ]), USING);

    // The halves of a refused chunk, and the next page of a full one, go to
    // the front of the queue.
    const again: RangeChunk[] = [];
    for (const [i, chunk] of batch.entries()) {
      let page: string[];
      try {
        page = methodResult<{ ids?: string[] }>(res, String(i)).ids ?? [];
      } catch (error) {
        const halves = splitRefusedChunk(chunk, error);
        if (!halves) return null;
        again.push(...halves);
        continue;
      }
      for (const id of page) ids.add(id);
      // A server that keeps returning full pages stops after QUERY_MAX_PAGES.
      const next = chunk.position + page.length;
      if (page.length === QUERY_PAGE_SIZE && next < QUERY_MAX_PAGES * QUERY_PAGE_SIZE) {
        again.push({ ...chunk, position: next });
      }
    }
    pending = [...again, ...pending];
  }
  return [...ids];
}

/**
 * One expanded query for `filter`, paged: for bounds that cannot be cut into
 * chunks. `null` when the server will not expand it.
 */
async function queryExpandedRange(
  baseArgs: Record<string, unknown>,
  filter: Record<string, string>,
): Promise<string[] | null> {
  const ids: string[] = [];
  for (let page = 0; page < QUERY_MAX_PAGES; page++) {
    const res = await jmapClient.request([['CalendarEvent/query', {
      ...baseArgs, filter, position: ids.length, limit: QUERY_PAGE_SIZE,
    }, '0']], USING);
    let batch: string[];
    try {
      batch = methodResult<{ ids?: string[] }>(res).ids ?? [];
    } catch (error) {
      if (jmapErrorType(error) === 'expandDurationTooLarge' || isOccurrenceLimitError(error)) return null;
      throw error;
    }
    ids.push(...batch);
    if (batch.length < QUERY_PAGE_SIZE) break;
  }
  return ids;
}

/**
 * Server-expanded occurrences come back without their series' recurrence
 * rule / overrides (and all-day ones without showWithoutTime). Fetch those
 * from the base events in one batched get and merge them in, so an
 * occurrence carries the same series context the device-side expansion
 * copies from its master.
 */
export async function hydrateExpandedOccurrences(
  events: CalendarEvent[],
  accountId?: string,
): Promise<CalendarEvent[]> {
  const baseIds = Array.from(new Set(
    events
      .filter((event) => isServerRecurrenceInstance(event) && event.recurrenceId)
      .map((event) => event.baseEventId as string),
  ));
  if (baseIds.length === 0) return events;
  const account = accountId || jmapClient.accountId;
  const bases = new Map<string, Partial<CalendarEvent>>();
  const list = await withCalendarTimeZone((timeZone) =>
    fetchEventsById(account, baseIds, RECURRENCE_BASE_PROPERTIES, { timeZone }));
  for (const base of list as Partial<CalendarEvent>[]) {
    if (base.id) bases.set(base.id, normalizeRecurrenceProperties(base));
  }
  return hydrateRecurrenceInstances(events, bases);
}

/**
 * CalendarEvent/get of `ids`, batched by maxObjectsInGet. With
 * `withOverrides`, every request carries a second get of OVERRIDE_PROPERTIES
 * and its overrides are merged in by id: Stalwart 1.0 refuses
 * `recurrenceOverrides` in the same get as `utcStart`/`utcEnd`. An error
 * answer to either get fails the whole read - taken as an empty list, it
 * would pass for "no events".
 */
async function fetchEventsById(
  accountId: string,
  ids: string[],
  properties: readonly string[],
  options: { withOverrides?: boolean; timeZone?: string } = {},
): Promise<Record<string, unknown>[]> {
  const { withOverrides = false, timeZone } = options;
  const objects: Record<string, unknown>[] = [];
  for (const batch of batched(ids, jmapClient.getMaxObjectsInGet())) {
    const args = { accountId, ids: batch, ...(timeZone ? { timeZone } : {}) };
    const calls: [string, Record<string, unknown>, string][] = [
      ['CalendarEvent/get', { ...args, properties: [...properties] }, '0'],
    ];
    if (withOverrides) {
      calls.push(['CalendarEvent/get', { ...args, properties: [...OVERRIDE_PROPERTIES] }, '1']);
    }
    const res = await jmapClient.request(calls, USING);
    const list = methodResult<{ list?: Record<string, unknown>[] }>(res, '0').list ?? [];
    if (withOverrides) {
      const overrides = new Map<unknown, unknown>();
      for (const entry of methodResult<{ list?: Record<string, unknown>[] }>(res, '1').list ?? []) {
        if ('recurrenceOverrides' in entry) overrides.set(entry.id, entry.recurrenceOverrides);
      }
      for (const object of list) {
        if (overrides.has(object.id)) object.recurrenceOverrides = overrides.get(object.id);
      }
    }
    objects.push(...list);
  }
  return objects;
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

/**
 * Events (or tasks) by id. A stored event comes with its recurrence
 * overrides, read by a second get in the same request (fetchEventsById).
 */
export async function getEvents(
  ids: string[],
  accountId?: string,
  // `expanded`: the ids are server-expanded occurrences (queryExpandedEvents),
  // which get their series' overrides from hydrateExpandedOccurrences.
  options?: { expanded?: boolean },
): Promise<CalendarEvent[]> {
  if (ids.length === 0) return [];
  const account = accountId || jmapClient.accountId;
  const list = await withCalendarTimeZone((timeZone) => fetchEventsById(
    account,
    ids,
    options?.expanded ? EXPANDED_EVENT_PROPERTIES : CALENDAR_EVENT_PROPERTIES,
    { withOverrides: !options?.expanded, timeZone },
  ));
  return (list as unknown as CalendarEvent[]).map((e) => normalizeTaskProgress(normalizeRecurrenceProperties(e)));
}

export type EventIdentityFields = Pick<CalendarEvent, 'id' | 'uid' | 'calendarIds'>;

/** Just the id, uid and calendars of `ids`: what a UID look-up compares. */
export async function getEventIdentities(ids: string[], accountId?: string): Promise<EventIdentityFields[]> {
  if (ids.length === 0) return [];
  const account = accountId || jmapClient.accountId;
  return (await fetchEventsById(account, ids, EVENT_IDENTITY_PROPERTIES)) as unknown as EventIdentityFields[];
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
  stripClientOnlyFields(payload);
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

/** A JMAP /set error as one line: its description, else its type and the properties it names. */
export function describeSetError(
  err: { type?: string; description?: string; properties?: string[] } | null | undefined,
): string {
  if (err?.description) return err.description;
  const type = err?.type || 'unknown error';
  return err?.properties?.length ? `${type} (${err.properties.join(', ')})` : type;
}

export interface BatchCreateResult {
  created: number;
  /** The events the server refused, by their index in the submitted list. */
  refused: { index: number; reason: string }[];
}

// Batch-create many events in one CalendarEvent/set. Per-event refusals come
// back in `refused` so the caller can report them; a method-level error
// (unknown calendar, missing capability) throws.
export async function batchCreateEvents(
  events: Partial<CalendarEvent>[],
  calendarId: string,
  targetAccountId?: string,
): Promise<BatchCreateResult> {
  if (events.length === 0) return { created: 0, refused: [] };
  const accountId = targetAccountId || jmapClient.accountId;
  const create: Record<string, Partial<CalendarEvent>> = {};
  events.forEach((e, i) => {
    const payload: Record<string, unknown> = { ...e, calendarIds: { [calendarId]: true } };
    stripClientOnlyFields(payload);
    cleanRecurrenceRules(payload);
    create[`evt-${i}`] = payload as Partial<CalendarEvent>;
  });
  const res = await jmapClient.request(
    [['CalendarEvent/set', { accountId, create }, '0']],
    USING,
  );
  const result = methodResult<{
    created?: Record<string, unknown>;
    notCreated?: Record<string, { description?: string; type?: string; properties?: string[] }>;
  }>(res);
  const refused: BatchCreateResult['refused'] = [];
  events.forEach((_, i) => {
    const err = result.notCreated?.[`evt-${i}`];
    if (err) refused.push({ index: i, reason: describeSetError(err) });
  });
  return { created: result.created ? Object.keys(result.created).length : 0, refused };
}

export async function updateEvent(
  id: string,
  changes: Partial<CalendarEvent> | Record<string, unknown>,
  sendSchedulingMessages?: boolean,
  targetAccountId?: string,
): Promise<void> {
  const accountId = targetAccountId || jmapClient.accountId;
  const patch: Record<string, unknown> = { ...changes };
  stripClientOnlyFields(patch);
  cleanRecurrenceRules(patch);
  const res = await jmapClient.request(
    [['CalendarEvent/set', setArgs(accountId, { update: { [id]: patch } }, sendSchedulingMessages), '0']],
    USING,
  );
  const result = methodResult<{ notUpdated?: Record<string, { description?: string; type?: string }> }>(res);
  const err = result.notUpdated?.[id];
  // Keep the SetError type: the store retries some refusals differently
  // (isOverrideSeriesKeyRejection).
  if (err) throw new JMAPMethodError(err.type ?? 'setError', err.description || err.type || 'Failed to update event');
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

/**
 * The name of the user's calendar `id`, or null when the account has no
 * calendar by that id.
 */
export async function getCalendarName(id: string): Promise<string | null> {
  const accountId = jmapClient.accountId;
  const res = await jmapClient.request(
    [['Calendar/get', { accountId, ids: [id], properties: ['id', 'name'] }, '0']],
    USING,
  );
  const list = methodResult<{ list?: Calendar[] }>(res).list ?? [];
  return list.find((cal) => cal.id === id)?.name ?? null;
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
