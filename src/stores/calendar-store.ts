import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createPersistStorage } from './persist-storage';
import { t } from './locale-store';
import type { Calendar, CalendarEvent, CalendarRights, Participant, StateChange } from '../api/types';
import { getEventStartDate, normalizeAllDayDuration } from '../lib/calendar-utils';
import { withOwnAlertIds } from '../lib/calendar-alerts';
import { hasAnsweredAttendees } from '../lib/calendar-participants';
import {
  type CalendarUpdates,
  type EventIdentityFields,
  updateCalendar as apiUpdateCalendar,
  deleteCalendar as apiDeleteCalendar,
  clearCalendarEvents as apiClearCalendarEvents,
  setCalendarShare as apiSetCalendarShare,
  getCalendars as fetchCalendars,
  queryEvents,
  getEvents as fetchEvents,
  getEventIdentities,
  scanCalendarObjects,
  isCalendarAccessDenied,
  noteCalendarAccessError,
  resetCalendarAccessDenied,
  createEvent as apiCreateEvent,
  updateEvent as apiUpdateEvent,
  deleteEvents as apiDeleteEvents,
  batchCreateEvents as apiBatchCreateEvents,
  rsvpEvent as apiRsvpEvent,
  createCalendar as apiCreateCalendar,
  setDefaultCalendar as apiSetDefaultCalendar,
  supportsSyntheticCalendarIds,
  queryExpandedEvents,
  hydrateExpandedOccurrences,
  resetSyntheticIdSupport,
  resetTimeZoneChecks,
} from '../api/calendar';
import { jmapClient } from '../api/jmap-client';
import { expandRecurringEvents } from '../lib/recurrence-expansion';
import { isRecurringSeriesMember } from '../lib/recurrence-overrides';
import {
  baseEventStoreId,
  buildFallbackExcludePatch,
  buildFallbackOverridePatch,
  buildOccurrencePatch,
  buildOccurrenceRsvpPatch,
  buildOverrideInTwoSteps,
  createsOverride,
  isBrowserExpandedOccurrence,
  isOverrideSeriesKeyRejection,
  isServerRecurrenceInstance,
  isSyntheticIdMutationUnsupported,
  seriesIdOf,
  withNewOverrideDetails,
  withoutOverrideSeriesKeys,
  type OverridePatchOptions,
} from '../lib/recurrence-instances';
import { findTasksOnlyCalendarIds, isTaskLikeObject } from '../lib/calendar-component-detection';
import { mergeRangeEvents, mergedSpanLimit, planRangeLoad, sameRange } from '../lib/calendar-range-cache';
import { requestDeviceSync } from '../device-sync/app/request';
import { sortCalendars, sortOrderUpdates } from '../lib/calendar-sort';
import { CALENDAR_AUTHORITY } from '../device-sync/types';

// extendRange merges up to twice the requested range (at least half a year,
// at most about three years); past that it starts over with the request.
const DAY_MS = 24 * 60 * 60 * 1000;
const MIN_MERGED_RANGE_MS = 183 * DAY_MS;
const MAX_MERGED_RANGE_MS = 3 * 366 * DAY_MS;

// Does the event carry attendees the server should notify over iMIP? Used to
// decide whether to set sendSchedulingMessages on create/update/delete.
function hasSchedulingParticipants(event?: Partial<CalendarEvent> | null): boolean {
  return !!event?.participants && Object.keys(event.participants).length > 0;
}

const HIDDEN_CALENDARS_STORAGE_KEY = 'webmail:calendar:hidden:v1';

// Map a server CalendarEvent onto its store representation. For events from a
// shared/group account the JMAP id is only unique within that account, so we
// namespace `id` (stashing the real id in originalId) and remap the event's
// `calendarIds` from raw server ids onto the namespaced store calendar ids so
// visibility filtering and per-calendar colour lookup line up. Events from the
// primary account are returned unchanged. Mirrors webmail's
// mapServerEventToStoreEvent.
export function mapServerEventToStoreEvent(
  event: CalendarEvent,
  calendars: Calendar[],
  accountId?: string,
): CalendarEvent {
  if (!accountId) return event;
  const mapped: Record<string, boolean> = {};
  for (const [calId, included] of Object.entries(event.calendarIds || {})) {
    const cal = calendars.find(
      (c) => (c.originalId || c.id) === calId && c.accountId === accountId,
    );
    mapped[cal?.id || calId] = included;
  }
  return {
    ...event,
    id: `${accountId}:${event.id}`,
    originalId: event.id,
    originalCalendarIds: event.calendarIds,
    calendarIds: Object.keys(mapped).length > 0 ? mapped : event.calendarIds,
    accountId,
    isShared: true,
  };
}

// Whitelist the JSCalendar properties an imported (parsed) event may carry:
// drop server-computed / identity fields (utcStart, utcEnd, isOrigin, created,
// updated, id) that CalendarEvent/set rejects, rewrite participants onto
// `calendarAddress` and normalise all-day duration / time zone. Mirrors the
// webmail's import preparation (#113).
export function prepareImportedEvent(event: Partial<CalendarEvent>): Partial<CalendarEvent> {
  const src = event as Record<string, unknown> & Partial<CalendarEvent>;
  let participants: Record<string, Participant> | undefined;
  if (src.participants) {
    participants = {};
    for (const [key, p] of Object.entries(src.participants)) {
      const cleaned: Record<string, unknown> = {
        '@type': 'Participant',
        name: p.name,
        email: p.email,
        calendarAddress: p.calendarAddress || p.sendTo?.imip,
        description: p.description,
        kind: p.kind,
        roles: p.roles,
        participationStatus: p.participationStatus,
        participationComment: p.participationComment,
        expectReply: p.expectReply,
        scheduleAgent: p.scheduleAgent,
      };
      for (const k of Object.keys(cleaned)) {
        if (cleaned[k] === undefined || cleaned[k] === null) delete cleaned[k];
      }
      participants[key] = cleaned as Participant;
    }
  }
  const data: Record<string, unknown> = {
    uid: src.uid,
    title: src.title,
    description: src.description,
    start: src.start,
    // A timed event without a duration lasts zero seconds. CalendarEvent/parse
    // drops a DTEND equal to DTSTART, and stored without a duration Stalwart
    // ends the event at 23:59:59 (#837). Tasks have no duration.
    duration: src.showWithoutTime
      ? normalizeAllDayDuration(src.duration)
      : src.duration || (src['@type'] !== 'Task' && src.start ? 'PT0S' : undefined),
    timeZone: src.showWithoutTime ? null : src.timeZone,
    showWithoutTime: src.showWithoutTime,
    status: src.status,
    freeBusyStatus: src.freeBusyStatus,
    color: src.color,
    keywords: src.keywords,
    // Stalwart derives the iCalendar ORGANIZER solely from
    // organizerCalendarAddress; dropping it would strip the ORGANIZER from
    // imported invites and break RSVP replies afterwards.
    organizerCalendarAddress: src.organizerCalendarAddress || src.replyTo?.imip,
    locations: src.locations,
    virtualLocations: src.virtualLocations,
    links: src.links,
    recurrenceRules: src.recurrenceRules,
    recurrenceOverrides: src.recurrenceOverrides,
    excludedRecurrenceRules: src.excludedRecurrenceRules,
    alerts: src.alerts,
    useDefaultAlerts: src.useDefaultAlerts,
    participants,
    '@type': src['@type'],
    due: src.due,
    progress: src.progress,
    priority: src.priority,
    percentComplete: src.percentComplete,
  };
  for (const k of Object.keys(data)) {
    if (data[k] === undefined || data[k] === null) delete data[k];
  }
  return data as Partial<CalendarEvent>;
}

/** An event the server wouldn't import, with its reason. */
export interface RefusedImport {
  event: Partial<CalendarEvent>;
  reason: string;
}

export interface ImportResult {
  /** Events created in (or linked into) the target calendar. */
  imported: number;
  refused: RefusedImport[];
}

/** Nothing was imported: the server refused every event that was new. */
export class ImportRefusedError extends Error {
  refused: RefusedImport[];
  constructor(refused: RefusedImport[]) {
    super(t(
      'calendar.import.refused_message',
      '{count, plural, =1 {The event could not be imported: {reason}} one {# event could not be imported: {reason}} other {# events could not be imported: {reason}}}',
      { count: refused.length, reason: refused[0]?.reason ?? unknownReason() },
    ));
    this.name = 'ImportRefusedError';
    this.refused = refused;
  }
}

function unknownReason(): string {
  return t('identities.validation_errors.unknown_error', 'Unknown error');
}

function errorReason(err: unknown): string {
  return err instanceof Error && err.message ? err.message : unknownReason();
}

export interface LoadedRange {
  after: string;
  before: string;
}

export interface CalendarState {
  calendars: Calendar[];
  events: CalendarEvent[];
  tasks: CalendarEvent[];
  // Store ids of calendars that hold only Task objects (VTODO-only CalDAV
  // collections, e.g. Thunderbird/Todoist task lists). JMAP Calendar/get
  // doesn't expose the CalDAV supported-calendar-component-set, so the
  // collection kind is inferred from contents: ≥1 task and no events.
  // Empty calendars are treated as ordinary event calendars. (#28)
  taskOnlyCalendarIds: string[];
  hiddenCalendarIds: string[];
  loadedRange: LoadedRange | null;
  loading: boolean;
  error: string | null;
  hydrated: boolean;

  hydrate: () => Promise<void>;
  fetchCalendars: () => Promise<void>;
  fetchEvents: (calendarIds: string[], after: string, before: string) => Promise<void>;
  // Scan every calendar object (all accounts) to list tasks and find the
  // tasks-only calendars; independent of the visible date range.
  fetchTasks: () => Promise<void>;
  ensureRange: (after: string, before: string) => Promise<void>;
  // Grow the loaded window to [after, before]: only the parts outside it are
  // fetched and merged in (the freely scrolling views, #759). A range that
  // doesn't touch the loaded one, or would make it too large, is loaded
  // afresh like ensureRange.
  extendRange: (after: string, before: string) => Promise<void>;
  refresh: () => Promise<void>;
  handleStateChange: (change: StateChange) => Promise<void>;
  // `options.sendSchedulingMessages` overrides the default (send iMIP when
  // the event has participants) — the editor's "send invitations" switch.
  createEvent: (
    event: Partial<CalendarEvent>,
    calendarId: string,
    options?: { sendSchedulingMessages?: boolean },
  ) => Promise<CalendarEvent>;
  // `changes` may be a plain partial or a JMAP patch with JSON-pointer keys
  // (e.g. `recurrenceOverrides/<recurrenceId>`).
  updateEvent: (
    id: string,
    changes: Partial<CalendarEvent> | Record<string, unknown>,
    options?: { sendSchedulingMessages?: boolean },
  ) => Promise<void>;
  deleteEvent: (id: string) => Promise<void>;
  // Resolve an expanded occurrence (or a master) to its master event, read
  // from the server: a copy the app holds may be older.
  getMasterEvent: (event: CalendarEvent) => Promise<CalendarEvent | null>;
  // Invitations / scheduling
  rsvpEvent: (
    eventId: string,
    participantId: string,
    status: 'accepted' | 'declined' | 'tentative',
    replyTo?: Record<string, string> | null,
    // The event itself, for one that isn't in the loaded window.
    event?: CalendarEvent,
    // 'occurrence': answer just this occurrence of a series (the server
    // stores it as an override and replies with its RECURRENCE-ID).
    scope?: 'occurrence' | 'series',
  ) => Promise<void>;
  // Resolves with what got in and what the server refused; rejects with an
  // ImportRefusedError when nothing got in because everything was refused.
  importEvents: (events: Partial<CalendarEvent>[], calendarId: string) => Promise<ImportResult>;
  createCalendar: (name: string, color?: string, description?: string) => Promise<Calendar>;
  updateCalendar: (id: string, updates: CalendarUpdates) => Promise<void>;
  // Store `orderedIds` in that order by renumbering their sortOrder.
  reorderCalendars: (orderedIds: string[]) => Promise<void>;
  removeCalendar: (id: string) => Promise<void>;
  clearCalendarEvents: (id: string) => Promise<number>;
  shareCalendar: (id: string, principalId: string, rights: CalendarRights | null) => Promise<void>;
  setDefaultCalendar: (id: string) => Promise<void>;
  // Tasks
  createTask: (task: Partial<CalendarEvent>, calendarId: string) => Promise<void>;
  updateTask: (id: string, changes: Partial<CalendarEvent>) => Promise<void>;
  toggleTaskComplete: (id: string) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  toggleCalendarVisibility: (id: string) => void;
  setCalendarHidden: (id: string, hidden: boolean) => void;
  /**
   * Show every calendar again. The hidden ids are kept for all accounts
   * together, and a server that was replaced may have given one of them to
   * another calendar (see lib/server-change).
   */
  forgetHiddenCalendars: () => Promise<void>;
  reset: () => void;
}

// In-flight dedupe for the two whole-account loads (see loadCalendarList).
let calendarsInFlight: Promise<boolean> | null = null;
let tasksInFlight: Promise<void> | null = null;

// One up with every reset (an account switch, a sign-out). A load still under
// way from before keeps its answer to itself: landing after the reset, it put
// the previous account's calendars, events or tasks under the next account
// until the next refresh, and that account's own task load was handed the old
// one still in flight.
let storeGeneration = 0;

/** The store's reset count: work started under an earlier one is the previous account's. */
export function calendarStoreGeneration(): number {
  return storeGeneration;
}

/**
 * A load or write the store's reset overtook: what it read belongs to the
 * account before, and what it had still to write would reach the next one.
 */
export class CalendarAccountChangedError extends Error {
  constructor() {
    super(t('calendar.account_changed', 'The account changed while the calendar was loading or saving.'));
    this.name = 'CalendarAccountChangedError';
  }
}

/**
 * The account a write is made for, taken when it starts: the store
 * generation and the primary JMAP account the client serves. Calendar and
 * event ids repeat across accounts, so a write still under way after an
 * account switch must not send its next step, which would reach the next
 * account, nor change the store, which shows that account by then.
 */
interface WriteScope {
  generation: number;
  primaryAccountId: string | null;
}

function connectedAccountId(): string | null {
  return jmapClient.isConnected ? jmapClient.accountId : null;
}

function writeScope(): WriteScope {
  return { generation: storeGeneration, primaryAccountId: connectedAccountId() };
}

function inScope(scope: WriteScope): boolean {
  return scope.generation === storeGeneration && connectedAccountId() === scope.primaryAccountId;
}

function assertInScope(scope: WriteScope): void {
  if (!inScope(scope)) throw new CalendarAccountChangedError();
}

/**
 * The JMAP account a write goes to, named on every request: a shared
 * calendar's owner, else the primary account the write started in.
 */
function writeAccount(scope: WriteScope, accountId: string | undefined): string | undefined {
  return accountId ?? scope.primaryAccountId ?? undefined;
}

/**
 * fetchCalendars: load the calendar list into the store. True when it did;
 * false without a session, when the request failed, or when a reset overtook
 * it - the range loads then leave their range unloaded, so the next one
 * tries again.
 */
function loadCalendarList(): Promise<boolean> {
  // CalendarScreen fires this on mount; on cold start that happens before
  // restoreSession has connected jmapClient. Bail rather than surfacing
  // a "Not authenticated" error - the refetch driven by the auth-store
  // will run this again once the session is live.
  if (!jmapClient.isConnected) return Promise.resolve(false);
  // First-touch gate (#907): the screen mount, ensureRange and the
  // auth-store all kick this off at once, and on a clustered Stalwart
  // concurrent first Calendar/* requests can each lazily create a default
  // calendar. Share one in-flight request instead.
  if (calendarsInFlight) return calendarsInFlight;
  const generation = storeGeneration;
  const set = useCalendarStore.setState;
  calendarsInFlight = (async () => {
    try {
      const calendars = sortCalendars((await fetchCalendars()) ?? []);
      if (generation !== storeGeneration) return false;
      set({ calendars });
      return true;
    } catch (err) {
      if (generation === storeGeneration) set({ error: err instanceof Error ? err.message : 'Failed to load calendars' });
      return false;
    } finally {
      // After a reset the slot belongs to the next account's load.
      if (generation === storeGeneration) calendarsInFlight = null;
    }
  })();
  return calendarsInFlight;
}

function persistHidden(ids: string[]): void {
  void AsyncStorage.setItem(HIDDEN_CALENDARS_STORAGE_KEY, JSON.stringify(ids)).catch(
    (err) => console.warn('[calendar-store] persist hidden failed', err),
  );
}

// Are [a1, b1] ⊇ [a2, b2]?
function rangeCovers(loaded: LoadedRange, after: string, before: string): boolean {
  return loaded.after <= after && loaded.before >= before;
}

function unionRange(loaded: LoadedRange, after: string, before: string): LoadedRange {
  return {
    after: loaded.after < after ? loaded.after : after,
    before: loaded.before > before ? loaded.before : before,
  };
}

/**
 * The events of the given calendars (store ids) that overlap [after, before],
 * mapped to store ids and with recurring series expanded over the window:
 * by the server when it accepts the synthetic occurrence ids that gives
 * (Stalwart >= 0.16.20, see lib/recurrence-instances), else on the device.
 * Doesn't touch the store: fetchEvents keeps the result as the visible
 * window, the reminders load their own upcoming window with it. Throws when
 * the primary account fails, or when the store was reset meanwhile
 * (CalendarAccountChangedError); a failing shared account is skipped.
 */
export async function loadEventsInRange(
  calendars: Calendar[],
  calendarIds: string[],
  after: string,
  before: string,
): Promise<CalendarEvent[]> {
  // Group the requested calendars by owning account: the primary account
  // (calendars without an accountId tag) plus one group per shared
  // account, since CalendarEvent/query is scoped to a single account. The
  // incoming ids are store ids (shared calendars are namespaced
  // `${accountId}:${id}`); map them back to the raw server ids the query
  // filter expects.
  const byId = new Map(calendars.map((c) => [c.id, c]));
  const groups = new Map<string | undefined, string[]>();
  for (const id of calendarIds) {
    const cal = byId.get(id);
    const accountId = cal?.accountId;
    const serverId = cal?.originalId || id;
    const group = groups.get(accountId);
    if (group) group.push(serverId);
    else groups.set(accountId, [serverId]);
  }
  if (groups.size === 0) groups.set(undefined, []);

  const generation = storeGeneration;
  const expand = !!after && !!before
    && await supportsSyntheticCalendarIds().catch(() => false);
  const raw: CalendarEvent[] = [];
  for (const [accountId, ids] of groups) {
    // The client serves another account now: the rest would be read there.
    if (generation !== storeGeneration) throw new CalendarAccountChangedError();
    if (accountId && isCalendarAccessDenied(accountId)) continue;
    try {
      let fetched: CalendarEvent[] | null = null;
      if (expand) {
        // null: the server won't expand the range even in small pieces
        // (too many occurrences); the series are then fetched whole and
        // expanded below.
        const expandedIds = await queryExpandedEvents(after, before, accountId);
        if (expandedIds) {
          const occurrences = expandedIds.length > 0
            ? (await fetchEvents(expandedIds, accountId, { expanded: true })) ?? []
            : [];
          // The expanded query spans the account; keep the asked-for calendars.
          const wanted = new Set(ids);
          const inCalendars = wanted.size === 0
            ? occurrences
            : occurrences.filter((e) => Object.keys(e.calendarIds || {}).some((id) => wanted.has(id)));
          fetched = await hydrateExpandedOccurrences(inCalendars, accountId);
        }
      }
      if (!fetched) {
        // The window is sent as after/before so accounts with more than
        // 1000 objects don't silently lose events and navigating past the
        // loaded range doesn't re-download everything.
        const eventIds = (await queryEvents(ids, after, before, accountId)) ?? [];
        if (eventIds.length === 0) continue;
        fetched = (await fetchEvents(eventIds, accountId)) ?? [];
      }
      raw.push(...fetched.map((e) => mapServerEventToStoreEvent(e, calendars, accountId)));
    } catch (err) {
      // A failing shared account must not hide the user's own events;
      // remember an access rejection so it isn't re-probed every fetch.
      if (!accountId) throw err;
      // Not for the account the client serves since a reset.
      if (generation === storeGeneration) noteCalendarAccessError(accountId, err);
    }
  }
  if (generation !== storeGeneration) throw new CalendarAccountChangedError();
  // Stalwart returns both Events and Tasks from CalendarEvent/query. Tasks
  // (also CalDAV ones without an `@type`) are surfaced by fetchTasks so
  // they don't pollute the grid.
  const onlyEvents = raw.filter((e) => !isTaskLikeObject(e) && !!e.start);
  return expandRecurringEvents(onlyEvents, after, before);
}

// Masters fetched by getMasterEvent: an expanded series has no master in
// `events`, so a mutation addressed at one looks up its account and raw id
// here.
const knownMasters = new Map<string, CalendarEvent>();

export interface MutationTarget {
  storeEvent?: CalendarEvent;
  /** Raw JMAP id the change is sent to. */
  realId: string;
  /** Owning account of a shared calendar's event. */
  accountId?: string;
  /** `realId` is the synthetic id of one server-expanded occurrence. */
  isOccurrence: boolean;
  /** `storeEvent` is one occurrence the device expanded, `realId` its base event. */
  isBrowserOccurrence?: boolean;
}

/**
 * Where a change to the event with store id `id` has to go. Mirrors the
 * webmail's resolveMutationTarget.
 *
 * With scope 'occurrence', a server-expanded occurrence is written through
 * its synthetic id (the server turns the patch into a recurrence override),
 * unless it is the single instance of a non-recurring event, where the base
 * event is the same thing and works on every server version; an occurrence
 * the device expanded resolves to its base event, to be written as a
 * recurrence override on it. Scope 'series' (an answer for the whole
 * series) always targets the stored event. A master fetched by
 * getMasterEvent resolves to itself, and a base event that is not in the
 * store borrows the account routing of a server occurrence of it in view.
 */
export function resolveMutationTarget(
  events: CalendarEvent[],
  id: string,
  scope: 'occurrence' | 'series',
): MutationTarget {
  const storeEvent = events.find((e) => e.id === id) ?? knownMasters.get(id);
  if (storeEvent) {
    const context = { storeEvent, accountId: storeEvent.accountId };
    if (isServerRecurrenceInstance(storeEvent) && storeEvent.baseEventId) {
      if (scope === 'series' || !storeEvent.recurrenceId) {
        return { ...context, realId: storeEvent.baseEventId, isOccurrence: false };
      }
      return { ...context, realId: storeEvent.originalId ?? storeEvent.id, isOccurrence: true };
    }
    if (scope === 'occurrence' && isBrowserExpandedOccurrence(storeEvent)) {
      return { ...context, realId: seriesIdOf(storeEvent), isOccurrence: false, isBrowserOccurrence: true };
    }
    return { ...context, realId: seriesIdOf(storeEvent), isOccurrence: false };
  }
  const instance = events.find((e) => baseEventStoreId(e) === id);
  if (instance?.baseEventId) {
    return { realId: instance.baseEventId, accountId: instance.accountId, isOccurrence: false };
  }
  return { realId: id, isOccurrence: false };
}

// Set once CalendarEvent/set rejected a synthetic id although the probe
// said it would take them: go straight to the base-event override then.
let syntheticIdRejected = false;

// Set once the server refused series keys inside a recurrence override
// (Stalwart 1.0): override writes leave them out from then on.
let overrideSeriesKeysRejected = false;

/**
 * Update a stored event. Recurrence overrides it writes carry the series keys
 * 0.16 has always been sent (the organizer; see buildFallbackOverridePatch).
 * Stalwart 1.0 refuses those inside an override ("organizerCalendarAddress
 * cannot be set inside recurrenceOverrides."): the update then goes out once
 * more without them, and so does every later one.
 */
async function updateBaseEvent(
  id: string,
  updates: Record<string, unknown>,
  sendSchedulingMessages: boolean | undefined,
  accountId: string | undefined,
  scope: WriteScope,
): Promise<void> {
  const writesOverrides = Object.keys(updates).some((key) => key.split('/', 1)[0] === 'recurrenceOverrides');
  if (writesOverrides && overrideSeriesKeysRejected) {
    await apiUpdateEvent(id, withoutOverrideSeriesKeys(updates), sendSchedulingMessages, accountId);
    return;
  }
  try {
    await apiUpdateEvent(id, updates, sendSchedulingMessages, accountId);
  } catch (err) {
    if (!writesOverrides || !isOverrideSeriesKeyRejection(err)) throw err;
    overrideSeriesKeysRejected = true;
    assertInScope(scope);
    await apiUpdateEvent(id, withoutOverrideSeriesKeys(updates), sendSchedulingMessages, accountId);
  }
}

/**
 * Patch one server-expanded occurrence through its synthetic id, with only
 * what one occurrence may carry (`buildOccurrencePatch`). A server that
 * predates synthetic-id writes rejects it; the same change is then written
 * as a recurrence override on the base event instead, and that is
 * remembered. `patchFor` builds the change; the base-event override asks it
 * for the series keys as well.
 */
async function updateOccurrence(
  instance: CalendarEvent,
  syntheticId: string,
  patchFor: (options: OverridePatchOptions) => Partial<CalendarEvent>,
  sendSchedulingMessages: boolean | undefined,
  accountId: string | undefined,
  scope: WriteScope,
): Promise<void> {
  if (!syntheticIdRejected) {
    try {
      await apiUpdateEvent(syntheticId, buildOccurrencePatch(patchFor({})), sendSchedulingMessages, accountId);
      return;
    } catch (err) {
      if (!isSyntheticIdMutationUnsupported(err)) throw err;
      syntheticIdRejected = true;
    }
    assertInScope(scope);
  }
  const fallback = buildFallbackOverridePatch(instance, patchFor({ seriesKeys: true }));
  if (!fallback || !instance.baseEventId) throw new Error('Cannot resolve the occurrence to override');
  await updateBaseEvent(instance.baseEventId, fallback, sendSchedulingMessages, accountId, scope);
}

/**
 * The server occurrence of `instance`'s series at the same recurrence id, read
 * again: a new override can give an occurrence another synthetic id. Null
 * when the series lists none there, or more than one.
 */
async function findServerOccurrence(
  instance: CalendarEvent,
  accountId: string | undefined,
): Promise<CalendarEvent | null> {
  if (!instance.baseEventId || !instance.recurrenceId) return null;
  const at = getEventStartDate(instance).getTime();
  if (isNaN(at)) return null;
  const ids = await queryExpandedEvents(new Date(at - DAY_MS).toISOString(), new Date(at + DAY_MS).toISOString(), accountId);
  if (!ids?.length) return null;
  const found = await fetchEvents(ids, accountId, { expanded: true });
  const matches = found.filter((e) => e.baseEventId === instance.baseEventId && e.recurrenceId === instance.recurrenceId);
  return matches.length === 1 ? matches[0] : null;
}

/**
 * A first change to one occurrence could not be sent: after its quiet
 * override was written, the occurrence was not found again (see
 * updateOccurrenceInTwoSteps). That override changes nothing that shows, and
 * a retry updates it, which reaches every attendee.
 */
export class OccurrenceNotFoundAgainError extends Error {
  constructor() {
    super(t(
      'calendar.occurrence_not_found_again',
      'The change was not saved: the occurrence could not be found again on the server. Please try again.',
    ));
    this.name = 'OccurrenceNotFoundAgainError';
  }
}

/**
 * A first change to one server occurrence that keeps its attendees' answers.
 * Stalwart delivers a new override only to attendees who have not answered
 * (organizer.rs, 0.16 and 1.0 alike), and one who has would never hear of the
 * change; an update of an existing override reaches everyone. So the override
 * is written first as the occurrence stands, without scheduling, and the
 * change then goes out as an update of it. The occurrence is looked up again
 * in between: the new override can give it another synthetic id. When that
 * fails, the change is not sent to the old id: up to 0.16.20 Stalwart's
 * synthetic ids are positions in the series' expansion (calendar_event/
 * mod.rs), and after the new override the old one can name the next
 * occurrence, which would get the change and its scheduling messages.
 * 0.16.21 and 1.0 key them by recurrence id, and the id stays (live).
 */
async function updateOccurrenceInTwoSteps(
  instance: CalendarEvent,
  syntheticId: string,
  patch: Partial<CalendarEvent>,
  sendSchedulingMessages: boolean | undefined,
  accountId: string | undefined,
  scope: WriteScope,
): Promise<void> {
  await updateOccurrence(instance, syntheticId, (options) => withNewOverrideDetails(instance, {}, options), false, accountId, scope);
  assertInScope(scope);
  const current = await findServerOccurrence(instance, accountId).catch(() => null);
  assertInScope(scope);
  if (!current) throw new OccurrenceNotFoundAgainError();
  await updateOccurrence(current, current.id, () => patch, sendSchedulingMessages, accountId, scope);
}

/**
 * Turn the calendar's default alerts off for a whole series, keeping the
 * alerts it shows as its own - before one occurrence's alerts change in a way
 * that turns them off (reminderFieldsToSave). While a series uses them,
 * Stalwart 1.0 shows the calendar's defaults in place of any occurrence's own
 * alerts and refuses useDefaultAlerts on a single occurrence ("This property
 * cannot be modified on a single occurrence."): the change was stored and
 * never shown. 0.16 stores and shows it either way; its series keeps the
 * same alerts.
 */
async function stopSeriesDefaultAlerts(baseId: string, accountId: string | undefined, scope: WriteScope): Promise<void> {
  const [base] = await fetchEvents([baseId], accountId);
  assertInScope(scope);
  if (!base?.useDefaultAlerts) return;
  const shown = base.alerts ?? {};
  await apiUpdateEvent(baseId, {
    useDefaultAlerts: false,
    // Under ids of their own: 1.0 drops alerts saved under a default alert's id.
    alerts: Object.keys(shown).length > 0 ? withOwnAlertIds(Object.values(shown), Object.keys(shown)) : null,
  }, false, accountId);
}

/** Destroy one server-expanded occurrence; falls back to excluding it on the base event. */
async function destroyOccurrence(
  instance: CalendarEvent,
  syntheticId: string,
  sendSchedulingMessages: boolean | undefined,
  accountId: string | undefined,
  scope: WriteScope,
): Promise<void> {
  if (!syntheticIdRejected) {
    try {
      await apiDeleteEvents([syntheticId], sendSchedulingMessages, accountId);
      return;
    } catch (err) {
      if (!isSyntheticIdMutationUnsupported(err)) throw err;
      syntheticIdRejected = true;
    }
    assertInScope(scope);
  }
  const fallback = buildFallbackExcludePatch(instance);
  if (!fallback || !instance.baseEventId) throw new Error('Cannot resolve the occurrence to exclude');
  await apiUpdateEvent(instance.baseEventId, fallback, sendSchedulingMessages, accountId);
}

/**
 * Write a change to one occurrence the device expanded as a recurrence
 * override on its base event (`target.realId`) - never as a change to the
 * base event itself, which would move or edit the whole series.
 */
async function updateBrowserOccurrence(
  target: MutationTarget,
  updates: Partial<CalendarEvent>,
  sendSchedulingMessages: boolean | undefined,
  scope: WriteScope,
): Promise<void> {
  const occurrence = target.storeEvent!;
  const patch = buildFallbackOverridePatch(occurrence, withNewOverrideDetails(occurrence, updates, { seriesKeys: true }));
  if (!patch) throw new Error('Cannot resolve the occurrence to override');
  await updateBaseEvent(target.realId, patch, sendSchedulingMessages, writeAccount(scope, target.accountId), scope);
}

/**
 * A first change to one occurrence the device expanded that keeps its
 * attendees' answers: the override on the base event is written first as
 * the occurrence stands, without scheduling, then updated with the change
 * (see updateOccurrenceInTwoSteps).
 */
async function updateBrowserOccurrenceInTwoSteps(
  target: MutationTarget,
  updates: Partial<CalendarEvent>,
  sendSchedulingMessages: boolean | undefined,
  scope: WriteScope,
): Promise<void> {
  const steps = buildOverrideInTwoSteps(target.storeEvent!, updates);
  if (!steps) throw new Error('Cannot resolve the occurrence to override');
  const accountId = writeAccount(scope, target.accountId);
  await updateBaseEvent(target.realId, steps.quiet, false, accountId, scope);
  assertInScope(scope);
  await updateBaseEvent(target.realId, steps.change, sendSchedulingMessages, accountId, scope);
}

/** Delete one occurrence the device expanded by excluding it on its base event. */
async function destroyBrowserOccurrence(
  target: MutationTarget,
  sendSchedulingMessages: boolean | undefined,
  scope: WriteScope,
): Promise<void> {
  const patch = buildFallbackExcludePatch(target.storeEvent!);
  if (!patch) throw new Error('Cannot resolve the occurrence to exclude');
  await apiUpdateEvent(target.realId, patch, sendSchedulingMessages, writeAccount(scope, target.accountId));
}

/**
 * Does the store show server-expanded occurrences of base event `baseId`?
 * Their synthetic ids reshuffle when the series changes, so the range is
 * reloaded after such a change.
 */
function hasServerOccurrencesOf(events: CalendarEvent[], baseId: string, accountId?: string): boolean {
  return events.some((e) =>
    isServerRecurrenceInstance(e)
    && e.baseEventId === baseId
    && (e.accountId ?? undefined) === (accountId ?? undefined));
}

export const useCalendarStore = create<CalendarState>()(
  persist(
    (set, get) => ({
  calendars: [],
  events: [],
  tasks: [],
  taskOnlyCalendarIds: [],
  hiddenCalendarIds: [],
  loadedRange: null,
  loading: false,
  error: null,
  hydrated: false,

  hydrate: async () => {
    if (get().hydrated) return;
    try {
      const raw = await AsyncStorage.getItem(HIDDEN_CALENDARS_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          set({ hiddenCalendarIds: parsed.filter((v) => typeof v === 'string') });
        }
      }
    } catch (err) {
      console.warn('[calendar-store] hydrate failed', err);
    }
    set({ hydrated: true });
  },

  fetchCalendars: async () => {
    await loadCalendarList();
  },

  fetchEvents: async (calendarIds, after, before) => {
    if (!jmapClient.isConnected) return;
    const generation = storeGeneration;
    set({ loading: true, error: null });
    try {
      const events = await loadEventsInRange(get().calendars, calendarIds, after, before);
      if (generation !== storeGeneration) return;
      set({ events, loadedRange: { after, before }, loading: false });
    } catch (err) {
      if (generation !== storeGeneration) return;
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load events' });
    }
  },

  fetchTasks: async () => {
    if (!jmapClient.isConnected) return;
    if (tasksInFlight) return tasksInFlight;
    const generation = storeGeneration;
    tasksInFlight = (async () => {
      try {
        const calendars = get().calendars;
        const accountIds = new Set<string | undefined>([undefined]);
        for (const cal of calendars) if (cal.accountId) accountIds.add(cal.accountId);
        const tasks: CalendarEvent[] = [];
        const taskOnly: string[] = [];
        for (const accountId of accountIds) {
          // The client serves another account now: the rest would be read there.
          if (generation !== storeGeneration) return;
          if (accountId && isCalendarAccessDenied(accountId)) continue;
          try {
            const scanned = await scanCalendarObjects(accountId);
            // Classify VTODO-only task lists from the full (undated) object
            // set: a calendar counts as a task list when every object in it
            // is a task. Empty calendars stay ordinary event calendars. (#28)
            const rawIds = calendars
              .filter((c) => (c.accountId ?? undefined) === accountId)
              .map((c) => c.originalId || c.id);
            for (const rawId of findTasksOnlyCalendarIds(scanned, rawIds)) {
              const cal = calendars.find(
                (c) => (c.originalId || c.id) === rawId && (c.accountId ?? undefined) === accountId,
              );
              taskOnly.push(cal?.id ?? rawId);
            }
            const taskIds = scanned
              .filter((o) => isTaskLikeObject(o))
              .map((o) => o.id as string)
              .filter(Boolean);
            if (taskIds.length === 0) continue;
            const fetched = (await fetchEvents(taskIds, accountId)) ?? [];
            tasks.push(...fetched.map((e) => mapServerEventToStoreEvent(e, calendars, accountId)));
          } catch (err) {
            if (!accountId) throw err;
            if (generation === storeGeneration) noteCalendarAccessError(accountId, err);
          }
        }
        if (generation !== storeGeneration) return;
        set({ tasks, taskOnlyCalendarIds: taskOnly });
      } catch (err) {
        if (generation === storeGeneration) set({ error: err instanceof Error ? err.message : 'Failed to load tasks' });
      } finally {
        if (generation === storeGeneration) tasksInFlight = null;
      }
    })();
    return tasksInFlight;
  },

  ensureRange: async (after, before) => {
    const { loadedRange } = get();
    if (loadedRange && rangeCovers(loadedRange, after, before)) return;

    // Taken before the calendars load: a reset meanwhile (an account switch)
    // makes this range the previous account's.
    const generation = storeGeneration;
    if (!jmapClient.isConnected) return;

    // Queries are windowed now, so load exactly the requested range instead
    // of an ever-growing union (which re-downloaded everything each time).
    if (get().calendars.length === 0) {
      // Calendars haven't loaded yet - fetch them (deduped), then events.
      // A list that didn't load (no session any more, a failed request)
      // leaves the range unloaded: marked loaded, it stayed empty.
      const listed = await loadCalendarList();
      if (generation !== storeGeneration || !listed) return;
    }
    const calendarIds = get().calendars.map((c) => c.id);
    if (calendarIds.length === 0) {
      set({ loadedRange: { after, before } });
      return;
    }
    const needTasks = get().tasks.length === 0 && get().taskOnlyCalendarIds.length === 0;
    await get().fetchEvents(calendarIds, after, before);
    if (generation !== storeGeneration) return;
    if (needTasks) void get().fetchTasks();
  },

  extendRange: async (after, before) => {
    const loaded = get().loadedRange;
    const requested = { after, before };
    const plan = planRangeLoad(
      loaded,
      requested,
      mergedSpanLimit(requested, MIN_MERGED_RANGE_MS, MAX_MERGED_RANGE_MS),
    );
    if (plan.kind === 'covered') return;
    if (plan.kind === 'replace' || !loaded) {
      await get().ensureRange(after, before);
      return;
    }
    // Taken before the calendars load, as in ensureRange.
    const generation = storeGeneration;
    if (!jmapClient.isConnected) return;
    // Calendars haven't loaded yet (cold start with a cached window): fetch
    // them (deduped) first, like ensureRange.
    if (get().calendars.length === 0) {
      const listed = await loadCalendarList();
      if (generation !== storeGeneration || !listed) return;
    }
    const calendars = get().calendars;
    const calendarIds = calendars.map((c) => c.id);
    if (calendarIds.length === 0) {
      // Only the window this plan grew from: a jump elsewhere replaced it.
      if (sameRange(get().loadedRange, loaded)) set({ loadedRange: plan.union });
      return;
    }
    set({ loading: true, error: null });
    try {
      const incoming: CalendarEvent[] = [];
      for (const piece of plan.pieces) {
        incoming.push(...(await loadEventsInRange(calendars, calendarIds, piece.after, piece.before)));
      }
      if (generation !== storeGeneration) return;
      // A jump elsewhere replaced the window meanwhile: these pieces no
      // longer border it. (A refresh of the same window is fine.)
      if (!sameRange(get().loadedRange, loaded)) {
        set({ loading: false });
        return;
      }
      set({
        events: mergeRangeEvents(get().events, incoming),
        loadedRange: plan.union,
        loading: false,
      });
    } catch (err) {
      if (generation !== storeGeneration) return;
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load events' });
    }
  },

  refresh: async () => {
    const { loadedRange, calendars } = get();
    if (!loadedRange) return;
    const ids = calendars.map((c) => c.id);
    if (ids.length === 0) return;
    await Promise.all([
      get().fetchEvents(ids, loadedRange.after, loadedRange.before),
      get().fetchTasks(),
    ]);
  },

  handleStateChange: async (change) => {
    if (!jmapClient.isConnected) return;
    // Watch the primary account plus every shared account we show calendars
    // from, so edits the owner makes to a shared calendar refresh the view.
    const known = new Set<string>([jmapClient.accountId]);
    for (const cal of get().calendars) {
      if (cal.accountId) known.add(cal.accountId);
    }
    let calendarChanged = false;
    let eventChanged = false;
    for (const [accountId, types] of Object.entries(change.changed ?? {})) {
      if (!known.has(accountId)) continue;
      if ('Calendar' in types) calendarChanged = true;
      if ('CalendarEvent' in types) eventChanged = true;
    }
    if (!calendarChanged && !eventChanged) return;

    if (calendarChanged) {
      await get().fetchCalendars();
    }
    if (eventChanged || calendarChanged) {
      await get().refresh();
    }
  },

  createEvent: async (event, calendarId, options) => {
    // Shared calendars live in the owner's account — route the create there,
    // and against the calendar's raw server id (calendarId is the namespaced
    // store id for shared calendars).
    const scope = writeScope();
    const calendars = get().calendars;
    const cal = calendars.find((c) => c.id === calendarId);
    const accountId = cal?.accountId;
    const schedule =
      options?.sendSchedulingMessages ?? (hasSchedulingParticipants(event) ? true : undefined);
    const created = await apiCreateEvent(
      event,
      cal?.originalId || calendarId,
      schedule,
      writeAccount(scope, accountId),
    );
    // Made; the store shows another account by now.
    if (!inScope(scope)) return created;
    // The /set echo lacks server-computed properties (utcStart/utcEnd, the
    // normalised recurrence rule); re-read the event so it renders at the
    // right instant, then expand a recurring series across the loaded range
    // instead of showing a single instance until the next refresh.
    let full = created;
    try {
      const fetched = (await fetchEvents([created.id], writeAccount(scope, accountId))) ?? [];
      if (fetched[0]) full = fetched[0];
    } catch {
      // Keep the echo; the next refresh reconciles.
    }
    if (!inScope(scope)) return full;
    // Map the same way fetchEvents does so the optimistic insert doesn't
    // collide with the user's own events and stays visible under the right
    // calendar filter.
    const mapped = mapServerEventToStoreEvent(full, calendars, accountId);
    const { loadedRange } = get();
    const inserted =
      mapped.recurrenceRules?.length && loadedRange
        ? expandRecurringEvents([mapped], loadedRange.after, loadedRange.before)
        : [mapped];
    set({ events: [...get().events, ...inserted] });
    requestDeviceSync(CALENDAR_AUTHORITY);
    return full;
  },

  updateEvent: async (id, changes, options) => {
    // A change to an occurrence stays on that occurrence: through its
    // synthetic id, or as an override on the base event it was expanded
    // from. Everything else goes to the stored event.
    const scope = writeScope();
    const target = resolveMutationTarget(get().events, id, 'occurrence');
    const { storeEvent, realId, accountId } = target;
    const account = writeAccount(scope, accountId);
    // Remap namespaced (shared-calendar) store ids in calendarIds back to the
    // raw server ids the owning account knows.
    const patch: Record<string, unknown> = { ...changes };
    const calendarIds = patch.calendarIds as Record<string, boolean> | undefined;
    if (calendarIds && typeof calendarIds === 'object') {
      const remapped: Record<string, boolean> = {};
      for (const [calId, v] of Object.entries(calendarIds)) {
        const cal = get().calendars.find((c) => c.id === calId);
        remapped[cal?.originalId || calId] = v;
      }
      patch.calendarIds = remapped;
    }
    // Notify attendees if either the stored event or the incoming changes
    // carry participants.
    const schedule =
      options?.sendSchedulingMessages ??
      (hasSchedulingParticipants(changes as Partial<CalendarEvent>) ||
        hasSchedulingParticipants(storeEvent)
        ? true
        : undefined);
    // A change that makes an event a series, or a single event again, changes
    // which occurrences the grid shows: only a range load expands a series,
    // and until then the grid had the series itself, once.
    const touchesSeries = (!!storeEvent && isRecurringSeriesMember(storeEvent))
      || 'recurrenceRules' in patch
      || hasServerOccurrencesOf(get().events, realId, accountId);
    // An occurrence's alerts that turn the calendar's defaults off.
    const stopsDefaultAlerts = patch.useDefaultAlerts === false && 'alerts' in patch;
    // A first change to one occurrence that goes out to attendees of whom
    // some answered and keep their answers (see updateOccurrenceInTwoSteps).
    const twoSteps = !!storeEvent && schedule === true && createsOverride(storeEvent)
      && hasAnsweredAttendees('participants' in patch
        ? patch.participants as CalendarEvent['participants']
        : storeEvent.participants);
    if (target.isOccurrence && storeEvent) {
      if (stopsDefaultAlerts && storeEvent.baseEventId) {
        await stopSeriesDefaultAlerts(storeEvent.baseEventId, account, scope);
        assertInScope(scope);
      }
      if (twoSteps) {
        try {
          await updateOccurrenceInTwoSteps(storeEvent, realId, patch as Partial<CalendarEvent>, schedule, account, scope);
        } catch (err) {
          // Its quiet override is on the server, and the series' occurrences
          // may have other ids now: a retry must not go to the ones in view.
          if (err instanceof OccurrenceNotFoundAgainError && inScope(scope)) await get().refresh().catch(() => undefined);
          throw err;
        }
      } else {
        await updateOccurrence(
          storeEvent,
          realId,
          (options) => withNewOverrideDetails(storeEvent, patch as Partial<CalendarEvent>, options),
          schedule,
          account,
          scope,
        );
      }
    } else if (target.isBrowserOccurrence) {
      if (stopsDefaultAlerts) {
        await stopSeriesDefaultAlerts(realId, account, scope);
        assertInScope(scope);
      }
      if (twoSteps) {
        await updateBrowserOccurrenceInTwoSteps(target, patch as Partial<CalendarEvent>, schedule, scope);
      } else {
        await updateBrowserOccurrence(target, patch as Partial<CalendarEvent>, schedule, scope);
      }
    } else {
      await updateBaseEvent(realId, patch, schedule, account, scope);
    }
    // Saved; the store shows another account by now, whose events can carry the same ids.
    if (!inScope(scope)) return;
    set({
      events: get().events.map((e) => (e.id === id ? { ...e, ...(changes as Partial<CalendarEvent>) } : e)),
    });
    requestDeviceSync(CALENDAR_AUTHORITY);
    // A series mutation (an occurrence override, a truncated/changed rule, a
    // master edit) touches every expanded sibling, and the optimistic merge
    // above only updated the tapped one; server-expanded occurrences also
    // get new ids. Reload the visible range like webmail's
    // refetchAfterOccurrenceMutation.
    if (touchesSeries) {
      await get().refresh();
    }
  },

  deleteEvent: async (id) => {
    // Deleting an occurrence removes just that one: through its synthetic
    // id, or by excluding it on the base event it was expanded from.
    const scope = writeScope();
    const target = resolveMutationTarget(get().events, id, 'occurrence');
    const { storeEvent, realId, accountId } = target;
    const touchesSeries = (!!storeEvent && isRecurringSeriesMember(storeEvent))
      || hasServerOccurrencesOf(get().events, realId, accountId);
    const schedule = hasSchedulingParticipants(storeEvent) ? true : undefined;
    if (target.isOccurrence && storeEvent) {
      await destroyOccurrence(storeEvent, realId, schedule, writeAccount(scope, accountId), scope);
      if (!inScope(scope)) return;
      set({ events: get().events.filter((e) => e.id !== id) });
    } else if (target.isBrowserOccurrence) {
      await destroyBrowserOccurrence(target, schedule, scope);
      if (!inScope(scope)) return;
      set({ events: get().events.filter((e) => e.id !== id) });
    } else {
      await apiDeleteEvents([realId], schedule, writeAccount(scope, accountId));
      // Deleted; the store shows another account by now, whose events can carry the same ids.
      if (!inScope(scope)) return;
      knownMasters.delete(id);
      // Destroying a master removes every expanded occurrence of it, not
      // just the tapped one.
      set({
        events: get().events.filter((e) =>
          e.id !== id
          && !(seriesIdOf(e) === realId && (e.accountId ?? undefined) === (accountId ?? undefined))),
      });
    }
    requestDeviceSync(CALENDAR_AUTHORITY);
    if (touchesSeries) {
      await get().refresh();
    }
  },

  getMasterEvent: async (event) => {
    // Expansion replaces the master with its occurrences, each pointing back
    // at the stored event: through baseEventId when the server expanded it,
    // through originalId when the device did. The stored event is read
    // again every time, also for the series itself (opened from a reminder
    // or a link) and one the grid shows as itself: a copy held here can be
    // older than the server's, and the scope edits build on its overrides
    // and its SEQUENCE - a change that raises it from a stale one goes out
    // lower than the attendees' copies, which 0.16 refuses.
    const realId = seriesIdOf(event);
    const generation = storeGeneration;
    const fetched = (await fetchEvents([realId], event.accountId)) ?? [];
    // Read from the account before a reset: not the next account's master.
    if (generation !== storeGeneration) throw new CalendarAccountChangedError();
    const master = fetched[0];
    if (!master) return null;
    // Known from here on, so a change to it is sent to its own account under
    // its raw id (resolveMutationTarget), whether or not the grid shows it.
    const mapped = mapServerEventToStoreEvent(master, get().calendars, event.accountId);
    knownMasters.set(mapped.id, mapped);
    return mapped;
  },

  rsvpEvent: async (eventId, participantId, status, replyTo, event, scope = 'series') => {
    // JMAP participant ids are opaque strings (they can contain @, ., :, /);
    // the api layer RFC 6901-escapes them, so only reject empty values.
    if (!participantId) {
      throw new Error('Invalid participant ID');
    }
    // An event outside the loaded window (an invitation looked up by UID)
    // isn't in the store; the caller hands it over instead. With scope
    // 'series' an occurrence answers for its whole series: the stored event
    // is updated.
    const write = writeScope();
    const target = resolveMutationTarget(get().events, eventId, scope);
    const storeEvent = target.storeEvent ?? event;
    const realId = target.storeEvent || !event ? target.realId : seriesIdOf(event);
    const accountId = target.storeEvent ? target.accountId : event?.accountId ?? target.accountId;
    const account = writeAccount(write, accountId);
    const occurrence = scope === 'occurrence' && (target.isOccurrence || target.isBrowserOccurrence)
      ? target.storeEvent ?? null
      : null;
    const touchesSeries = (!!storeEvent && isRecurringSeriesMember(storeEvent))
      || hasServerOccurrencesOf(get().events, seriesIdOf(storeEvent ?? { id: realId }), accountId);
    if (occurrence) {
      // Through a synthetic id the answer leaves the organizer out (it is the
      // series'); an override on the base event names it (0.16.19 needs it).
      const patchFor = (options: OverridePatchOptions) =>
        buildOccurrenceRsvpPatch(occurrence, participantId, status, options);
      const patch = patchFor({ seriesKeys: true });
      if (!patch) throw new Error('Participant not found on this occurrence');
      if (target.isOccurrence) {
        await updateOccurrence(occurrence, target.realId, (options) => patchFor(options) ?? {}, true, account, write);
      } else {
        await updateBrowserOccurrence(target, patch, true, write);
      }
    } else {
      // Repair events that are missing the organizer (e.g. imported ones) so
      // Stalwart can route the REPLY; never touch an existing one.
      const repair =
        replyTo?.imip && storeEvent && !storeEvent.organizerCalendarAddress
          ? replyTo.imip
          : undefined;
      await apiRsvpEvent(realId, participantId, status, repair, account);
    }
    // Answered; the store shows another account by now, whose events can carry the same ids.
    if (!inScope(write)) return;
    requestDeviceSync(CALENDAR_AUTHORITY);
    set({
      events: get().events.map((e) => {
        if (e.id !== eventId || !e.participants?.[participantId]) return e;
        return {
          ...e,
          participants: {
            ...e.participants,
            [participantId]: { ...e.participants[participantId], participationStatus: status },
          },
        };
      }),
    });
    // The other occurrences in view still show the old answer.
    if (touchesSeries) await get().refresh();
  },

  importEvents: async (events, calendarId) => {
    if (events.length === 0) return { imported: 0, refused: [] };
    const scope = writeScope();
    // Shared calendars live in the owner's account and carry a namespaced
    // store id — resolve the raw server id + owning account so dedup and
    // create target the right place.
    const cal = get().calendars.find((c) => c.id === calendarId);
    const accountId = writeAccount(scope, cal?.accountId);
    const serverCalendarId = cal?.originalId || calendarId;
    const refused: RefusedImport[] = [];
    // Stalwart enforces UID uniqueness across calendars (#113):
    // - UID already in the target calendar -> skip (true duplicate)
    // - UID in another calendar -> link it to the target via calendarIds
    // - new UID -> create
    let toCreate = events;
    let linked = 0;
    try {
      const existingIds = await queryEvents([], '', '', accountId);
      assertInScope(scope);
      const existing = await getEventIdentities(existingIds, accountId);
      assertInScope(scope);
      const byUid = new Map<string, EventIdentityFields>();
      for (const e of existing) if (e.uid) byUid.set(e.uid, e);
      const fresh: Partial<CalendarEvent>[] = [];
      for (const e of events) {
        const found = e.uid ? byUid.get(e.uid) : undefined;
        if (!found) {
          fresh.push(e);
          continue;
        }
        if (found.calendarIds?.[serverCalendarId]) continue;
        assertInScope(scope);
        try {
          await apiUpdateEvent(
            found.id,
            { calendarIds: { ...(found.calendarIds || {}), [serverCalendarId]: true } },
            undefined,
            accountId,
          );
          linked++;
        } catch (err) {
          // Leave it where it is and say so; the import of the rest continues.
          refused.push({ event: e, reason: errorReason(err) });
        }
      }
      toCreate = fresh;
    } catch (err) {
      if (err instanceof CalendarAccountChangedError) throw err;
      // Couldn't dedupe — proceed and let the server reject genuine dupes.
    }
    const prepared = toCreate.map(prepareImportedEvent);
    let count = 0;
    try {
      // Batch in chunks of 50 to avoid oversized requests.
      for (let i = 0; i < prepared.length; i += 50) {
        // The rest would go to the next account's calendar of the same id.
        assertInScope(scope);
        try {
          const result = await apiBatchCreateEvents(prepared.slice(i, i + 50), serverCalendarId, accountId);
          count += result.created;
          for (const { index, reason } of result.refused) {
            refused.push({ event: toCreate[i + index], reason });
          }
        } catch (err) {
          // A method-level error (unknown calendar, lost connection) would
          // refuse the later chunks the same way: report them all.
          for (const event of toCreate.slice(i)) refused.push({ event, reason: errorReason(err) });
          break;
        }
      }
    } finally {
      // Also when a chunk was refused: show what did get in.
      if ((count > 0 || linked > 0) && inScope(scope)) {
        requestDeviceSync(CALENDAR_AUTHORITY);
        await get().refresh();
      }
    }
    if (count + linked === 0 && refused.length > 0) throw new ImportRefusedError(refused);
    return { imported: count + linked, refused };
  },

  createCalendar: async (name, color, description) => {
    const scope = writeScope();
    const created = await apiCreateCalendar(name, color, description, writeAccount(scope, undefined));
    // Made in the account before a switch: not one of the next account's.
    if (!inScope(scope)) return created;
    set({ calendars: sortCalendars([...get().calendars, created]) });
    requestDeviceSync(CALENDAR_AUTHORITY);
    return created;
  },

  updateCalendar: async (id, updates) => {
    const scope = writeScope();
    const cal = get().calendars.find((c) => c.id === id);
    await apiUpdateCalendar(cal?.originalId || id, updates, writeAccount(scope, cal?.accountId));
    if (!inScope(scope)) return;
    set({
      calendars: sortCalendars(get().calendars.map((c) => (c.id === id ? { ...c, ...updates } as Calendar : c))),
    });
    requestDeviceSync(CALENDAR_AUTHORITY);
  },

  reorderCalendars: async (orderedIds) => {
    const updates = sortOrderUpdates(get().calendars, orderedIds);
    if (updates.length === 0) return;
    const scope = writeScope();
    const before = get().calendars;
    const withSortOrders = (sortOrders: Map<string, number>) => sortCalendars(before.map((c) =>
      sortOrders.has(c.id) ? { ...c, sortOrder: sortOrders.get(c.id)! } : c));
    // Optimistic, so the list moves at once.
    set({ calendars: withSortOrders(new Map(updates.map((u) => [u.id, u.sortOrder]))) });
    const saved = new Map<string, number>();
    try {
      for (const { id, sortOrder } of updates) {
        // The rest would renumber the next account's calendars of the same ids.
        assertInScope(scope);
        const cal = before.find((c) => c.id === id);
        await apiUpdateCalendar(cal?.originalId || id, { sortOrder }, writeAccount(scope, cal?.accountId));
        saved.set(id, sortOrder);
      }
    } catch (err) {
      // Show the order the server now holds: the moves saved before the
      // failure stay, the rest are undone. Not over the next account's list.
      if (inScope(scope)) set({ calendars: withSortOrders(saved) });
      throw err;
    } finally {
      if (saved.size > 0 && inScope(scope)) requestDeviceSync(CALENDAR_AUTHORITY);
    }
  },

  removeCalendar: async (id) => {
    const scope = writeScope();
    const cal = get().calendars.find((c) => c.id === id);
    await apiDeleteCalendar(cal?.originalId || id, writeAccount(scope, cal?.accountId));
    // Removed; the next account may have a calendar of the same id.
    if (!inScope(scope)) return;
    set({
      calendars: get().calendars.filter((c) => c.id !== id),
      events: get().events.filter((e) => !e.calendarIds?.[id]),
      tasks: get().tasks.filter((t) => !t.calendarIds?.[id]),
      hiddenCalendarIds: get().hiddenCalendarIds.filter((x) => x !== id),
    });
    requestDeviceSync(CALENDAR_AUTHORITY);
  },

  clearCalendarEvents: async (id) => {
    const scope = writeScope();
    const cal = get().calendars.find((c) => c.id === id);
    try {
      const cleared = await apiClearCalendarEvents(cal?.originalId || id, writeAccount(scope, cal?.accountId));
      requestDeviceSync(CALENDAR_AUTHORITY);
      return cleared;
    } finally {
      // Also after a refused batch: earlier batches may have gone through.
      await get().refresh();
    }
  },

  shareCalendar: async (id, principalId, rights) => {
    const scope = writeScope();
    const cal = get().calendars.find((c) => c.id === id);
    await apiSetCalendarShare(cal?.originalId || id, principalId, rights, writeAccount(scope, cal?.accountId));
    if (!inScope(scope)) return;
    set({
      calendars: get().calendars.map((c) => {
        if (c.id !== id) return c;
        const next = { ...(c.shareWith ?? {}) };
        if (rights === null) delete next[principalId];
        else next[principalId] = rights;
        return { ...c, shareWith: next };
      }),
    });
  },

  setDefaultCalendar: async (id) => {
    const scope = writeScope();
    const cal = get().calendars.find((c) => c.id === id);
    await apiSetDefaultCalendar(cal?.originalId || id, writeAccount(scope, cal?.accountId));
    if (!inScope(scope)) return;
    set({
      calendars: get().calendars.map((c) => {
        if (c.id === id) return { ...c, isDefault: true };
        // Only one default per account — clear the flag on siblings within
        // the same account scope.
        if (c.isDefault && (c.accountId ?? null) === (cal?.accountId ?? null)) {
          return { ...c, isDefault: false };
        }
        return c;
      }),
    });
  },

  createTask: async (task, calendarId) => {
    const scope = writeScope();
    const cal = get().calendars.find((c) => c.id === calendarId);
    await apiCreateEvent(
      { ...task, '@type': 'Task' },
      cal?.originalId || calendarId,
      undefined,
      writeAccount(scope, cal?.accountId),
    );
    await get().fetchTasks();
  },

  updateTask: async (id, changes) => {
    const scope = writeScope();
    const task = get().tasks.find((t) => t.id === id);
    const realId = task?.originalId || id;
    await apiUpdateEvent(realId, changes, undefined, writeAccount(scope, task?.accountId));
    // Saved; the next account's tasks can carry the same ids.
    if (!inScope(scope)) return;
    set({ tasks: get().tasks.map((t) => (t.id === id ? { ...t, ...changes } : t)) });
  },

  toggleTaskComplete: async (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    // The tasks sheet ticks cancelled tasks too, so a tap on one reopens it.
    const completed = task.progress === 'completed' || task.progress === 'cancelled';
    // Un-completing goes back to needs-action (not in-process), like webmail.
    // No progressUpdated: JSCalendar 2.0 dropped it and Stalwart rejects the
    // whole update with invalidProperties (#958).
    const next: Partial<CalendarEvent> = completed
      ? { progress: 'needs-action', percentComplete: 0 }
      : { progress: 'completed', percentComplete: 100 };
    // Flip the checkbox right away and put it back if the server refuses.
    const patchTask = (changes: Partial<CalendarEvent>) =>
      set({ tasks: get().tasks.map((t) => (t.id === id ? { ...t, ...changes } : t)) });
    const scope = writeScope();
    patchTask(next);
    try {
      await apiUpdateEvent(task.originalId || id, next, undefined, writeAccount(scope, task.accountId));
    } catch (err) {
      // Not on the next account's task of the same id.
      if (inScope(scope)) patchTask({ progress: task.progress, percentComplete: task.percentComplete });
      throw err;
    }
  },

  deleteTask: async (id) => {
    const scope = writeScope();
    const task = get().tasks.find((t) => t.id === id);
    const realId = task?.originalId || id;
    await apiDeleteEvents([realId], undefined, writeAccount(scope, task?.accountId));
    if (!inScope(scope)) return;
    set({ tasks: get().tasks.filter((t) => t.id !== id) });
  },

  toggleCalendarVisibility: (id) => {
    const { hiddenCalendarIds } = get();
    const next = hiddenCalendarIds.includes(id)
      ? hiddenCalendarIds.filter((x) => x !== id)
      : [...hiddenCalendarIds, id];
    set({ hiddenCalendarIds: next });
    persistHidden(next);
  },

  setCalendarHidden: (id, hidden) => {
    const { hiddenCalendarIds } = get();
    const isHidden = hiddenCalendarIds.includes(id);
    if (hidden === isHidden) return;
    const next = hidden
      ? [...hiddenCalendarIds, id]
      : hiddenCalendarIds.filter((x) => x !== id);
    set({ hiddenCalendarIds: next });
    persistHidden(next);
  },

  forgetHiddenCalendars: async () => {
    // A read of the stored list still under way would bring them back.
    await get().hydrate();
    set({ hiddenCalendarIds: [] });
    persistHidden([]);
  },

  reset: () => {
    // A new session may grant access the old one lacked, or reach an
    // upgraded server.
    storeGeneration += 1;
    calendarsInFlight = null;
    tasksInFlight = null;
    resetCalendarAccessDenied();
    resetSyntheticIdSupport();
    resetTimeZoneChecks();
    syntheticIdRejected = false;
    overrideSeriesKeysRejected = false;
    knownMasters.clear();
    set({
      calendars: [],
      events: [],
      tasks: [],
      taskOnlyCalendarIds: [],
      loadedRange: null,
      loading: false,
      error: null,
    });
  },
    }),
    {
      // Persist calendars + expanded events + the range they cover so the
      // calendar renders instantly on re-open. A refresh happens in the
      // background and replaces the cached data with fresh copies.
      name: 'calendar-cache',
      storage: createPersistStorage(),
      partialize: (state) => ({
        calendars: state.calendars,
        events: state.events,
        tasks: state.tasks,
        taskOnlyCalendarIds: state.taskOnlyCalendarIds,
        loadedRange: state.loadedRange,
      }),
    },
  ),
);

// ─── Selectors ───────────────────────────────────────────
export function selectVisibleCalendars(state: CalendarState): Calendar[] {
  return state.calendars.filter((c) => !state.hiddenCalendarIds.includes(c.id));
}

export function selectVisibleEvents(state: CalendarState): CalendarEvent[] {
  if (state.hiddenCalendarIds.length === 0) return state.events;
  const hidden = new Set(state.hiddenCalendarIds);
  return state.events.filter((e) => {
    const ids = Object.keys(e.calendarIds || {});
    if (ids.length === 0) return true;
    // Visible if at least one calendar isn't hidden
    return ids.some((id) => !hidden.has(id));
  });
}
