import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { createPersistStorage } from './persist-storage';
import type { Calendar, CalendarEvent, CalendarRights, Participant, StateChange } from '../api/types';
import { normalizeAllDayDuration } from '../lib/calendar-utils';
import {
  type CalendarUpdates,
  updateCalendar as apiUpdateCalendar,
  deleteCalendar as apiDeleteCalendar,
  clearCalendarEvents as apiClearCalendarEvents,
  setCalendarShare as apiSetCalendarShare,
  getCalendars as fetchCalendars,
  queryEvents,
  getEvents as fetchEvents,
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
} from '../api/calendar';
import { jmapClient } from '../api/jmap-client';
import { expandRecurringEvents } from '../lib/recurrence-expansion';
import { isRecurringSeriesMember } from '../lib/recurrence-overrides';
import { findTasksOnlyCalendarIds, isTaskLikeObject } from '../lib/calendar-component-detection';

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
function mapServerEventToStoreEvent(
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
    duration: src.showWithoutTime ? normalizeAllDayDuration(src.duration) : src.duration,
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
  // Resolve a client-side expanded occurrence (or a master) to its master
  // event, fetching it from the server when the expansion replaced it.
  getMasterEvent: (event: CalendarEvent) => Promise<CalendarEvent | null>;
  // Invitations / scheduling
  rsvpEvent: (
    eventId: string,
    participantId: string,
    status: 'accepted' | 'declined' | 'tentative',
    replyTo?: Record<string, string> | null,
  ) => Promise<void>;
  importEvents: (events: Partial<CalendarEvent>[], calendarId: string) => Promise<number>;
  createCalendar: (name: string, color?: string, description?: string) => Promise<Calendar>;
  updateCalendar: (id: string, updates: CalendarUpdates) => Promise<void>;
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
  reset: () => void;
}

// In-flight dedupe for the two whole-account loads (see fetchCalendars).
let calendarsInFlight: Promise<void> | null = null;
let tasksInFlight: Promise<void> | null = null;

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
    // CalendarScreen fires this on mount; on cold start that happens before
    // restoreSession has connected jmapClient. Bail rather than surfacing
    // a "Not authenticated" error - the refetch driven by the auth-store
    // will run this again once the session is live.
    if (!jmapClient.isConnected) return;
    // First-touch gate (#907): the screen mount, ensureRange and the
    // auth-store all kick this off at once, and on a clustered Stalwart
    // concurrent first Calendar/* requests can each lazily create a default
    // calendar. Share one in-flight request instead.
    if (calendarsInFlight) return calendarsInFlight;
    calendarsInFlight = (async () => {
      try {
        const calendars = (await fetchCalendars()) ?? [];
        set({ calendars });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : 'Failed to load calendars' });
      } finally {
        calendarsInFlight = null;
      }
    })();
    return calendarsInFlight;
  },

  fetchEvents: async (calendarIds, after, before) => {
    if (!jmapClient.isConnected) return;
    set({ loading: true, error: null });
    try {
      // Group the requested calendars by owning account: the primary account
      // (calendars without an accountId tag) plus one group per shared
      // account, since CalendarEvent/query is scoped to a single account. The
      // incoming ids are store ids (shared calendars are namespaced
      // `${accountId}:${id}`); map them back to the raw server ids the query
      // filter expects.
      const calendars = get().calendars;
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

      const raw: CalendarEvent[] = [];
      for (const [accountId, ids] of groups) {
        if (accountId && isCalendarAccessDenied(accountId)) continue;
        try {
          // The window is sent as after/before so accounts with more than
          // 1000 objects don't silently lose events and navigating past the
          // loaded range doesn't re-download everything.
          const eventIds = (await queryEvents(ids, after, before, accountId)) ?? [];
          if (eventIds.length === 0) continue;
          const fetched = (await fetchEvents(eventIds, accountId)) ?? [];
          raw.push(...fetched.map((e) => mapServerEventToStoreEvent(e, calendars, accountId)));
        } catch (err) {
          // A failing shared account must not hide the user's own events;
          // remember an access rejection so it isn't re-probed every fetch.
          if (!accountId) throw err;
          noteCalendarAccessError(accountId, err);
        }
      }
      // Stalwart returns both Events and Tasks from CalendarEvent/query. Tasks
      // (also CalDAV ones without an `@type`) are surfaced by fetchTasks so
      // they don't pollute the grid.
      const onlyEvents = raw.filter((e) => !isTaskLikeObject(e) && !!e.start);
      const events = expandRecurringEvents(onlyEvents, after, before);
      set({ events, loadedRange: { after, before }, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load events' });
    }
  },

  fetchTasks: async () => {
    if (!jmapClient.isConnected) return;
    if (tasksInFlight) return tasksInFlight;
    tasksInFlight = (async () => {
      try {
        const calendars = get().calendars;
        const accountIds = new Set<string | undefined>([undefined]);
        for (const cal of calendars) if (cal.accountId) accountIds.add(cal.accountId);
        const tasks: CalendarEvent[] = [];
        const taskOnly: string[] = [];
        for (const accountId of accountIds) {
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
            noteCalendarAccessError(accountId, err);
          }
        }
        set({ tasks, taskOnlyCalendarIds: taskOnly });
      } catch (err) {
        set({ error: err instanceof Error ? err.message : 'Failed to load tasks' });
      } finally {
        tasksInFlight = null;
      }
    })();
    return tasksInFlight;
  },

  ensureRange: async (after, before) => {
    const { loadedRange } = get();
    if (loadedRange && rangeCovers(loadedRange, after, before)) return;

    // Queries are windowed now, so load exactly the requested range instead
    // of an ever-growing union (which re-downloaded everything each time).
    if (get().calendars.length === 0) {
      // Calendars haven't loaded yet - fetch them (deduped), then events.
      await get().fetchCalendars();
    }
    const calendarIds = get().calendars.map((c) => c.id);
    if (calendarIds.length === 0) {
      set({ loadedRange: { after, before } });
      return;
    }
    const needTasks = get().tasks.length === 0 && get().taskOnlyCalendarIds.length === 0;
    await get().fetchEvents(calendarIds, after, before);
    if (needTasks) void get().fetchTasks();
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
    const calendars = get().calendars;
    const cal = calendars.find((c) => c.id === calendarId);
    const accountId = cal?.accountId;
    const schedule =
      options?.sendSchedulingMessages ?? (hasSchedulingParticipants(event) ? true : undefined);
    const created = await apiCreateEvent(
      event,
      cal?.originalId || calendarId,
      schedule,
      accountId,
    );
    // The /set echo lacks server-computed properties (utcStart/utcEnd, the
    // normalised recurrence rule); re-read the event so it renders at the
    // right instant, then expand a recurring series across the loaded range
    // instead of showing a single instance until the next refresh.
    let full = created;
    try {
      const fetched = (await fetchEvents([created.id], accountId)) ?? [];
      if (fetched[0]) full = fetched[0];
    } catch {
      // Keep the echo; the next refresh reconciles.
    }
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
    return full;
  },

  updateEvent: async (id, changes, options) => {
    // Resolve client-side expanded occurrence IDs back to the master event ID.
    const storeEvent = get().events.find((e) => e.id === id);
    const realId = storeEvent?.originalId || id;
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
    await apiUpdateEvent(realId, patch, schedule, storeEvent?.accountId);
    set({
      events: get().events.map((e) => (e.id === id ? { ...e, ...(changes as Partial<CalendarEvent>) } : e)),
    });
    // A series mutation (an occurrence override, a truncated/changed rule, a
    // master edit) touches every expanded sibling, and the optimistic merge
    // above only updated the tapped one — reload the visible range like
    // webmail's refetchAfterOccurrenceMutation.
    if (storeEvent && isRecurringSeriesMember(storeEvent)) {
      await get().refresh();
    }
  },

  deleteEvent: async (id) => {
    const storeEvent = get().events.find((e) => e.id === id);
    const realId = storeEvent?.originalId || id;
    await apiDeleteEvents(
      [realId],
      hasSchedulingParticipants(storeEvent) ? true : undefined,
      storeEvent?.accountId,
    );
    // Destroying a master removes every expanded occurrence of it, not just
    // the tapped one.
    set({ events: get().events.filter((e) => e.id !== id && (e.originalId || e.id) !== realId) });
    if (storeEvent && isRecurringSeriesMember(storeEvent)) {
      await get().refresh();
    }
  },

  getMasterEvent: async (event) => {
    if (event.recurrenceRules?.length && !event.recurrenceId) return event;
    // Client-side expansion replaces the master with its occurrences, each
    // pointing back at the master's server id through originalId.
    const realId = event.originalId || event.id;
    const inStore = get().events.find(
      (e) => e.id === realId && !e.recurrenceId && !!e.recurrenceRules?.length,
    );
    if (inStore) return inStore;
    const fetched = (await fetchEvents([realId], event.accountId)) ?? [];
    const master = fetched[0];
    if (!master) return null;
    return mapServerEventToStoreEvent(master, get().calendars, event.accountId);
  },

  rsvpEvent: async (eventId, participantId, status, replyTo) => {
    // JMAP participant ids are opaque strings (they can contain @, ., :, /);
    // the api layer RFC 6901-escapes them, so only reject empty values.
    if (!participantId) {
      throw new Error('Invalid participant ID');
    }
    const storeEvent = get().events.find((e) => e.id === eventId);
    const realId = storeEvent?.originalId || eventId;
    // Repair events that are missing the organizer (e.g. imported ones) so
    // Stalwart can route the REPLY; never touch an existing one.
    const repair =
      replyTo?.imip && storeEvent && !storeEvent.organizerCalendarAddress
        ? replyTo.imip
        : undefined;
    await apiRsvpEvent(realId, participantId, status, repair, storeEvent?.accountId);
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
  },

  importEvents: async (events, calendarId) => {
    if (events.length === 0) return 0;
    // Shared calendars live in the owner's account and carry a namespaced
    // store id — resolve the raw server id + owning account so dedup and
    // create target the right place.
    const cal = get().calendars.find((c) => c.id === calendarId);
    const accountId = cal?.accountId;
    const serverCalendarId = cal?.originalId || calendarId;
    // Stalwart enforces UID uniqueness across calendars (#113):
    // - UID already in the target calendar -> skip (true duplicate)
    // - UID in another calendar -> link it to the target via calendarIds
    // - new UID -> create
    let toCreate = events;
    let linked = 0;
    try {
      const existingIds = await queryEvents([], '', '', accountId);
      const existing = existingIds.length > 0 ? await fetchEvents(existingIds, accountId) : [];
      const byUid = new Map<string, CalendarEvent>();
      for (const e of existing) if (e.uid) byUid.set(e.uid, e);
      const fresh: Partial<CalendarEvent>[] = [];
      for (const e of events) {
        const found = e.uid ? byUid.get(e.uid) : undefined;
        if (!found) {
          fresh.push(e);
          continue;
        }
        if (found.calendarIds?.[serverCalendarId]) continue;
        try {
          await apiUpdateEvent(
            found.id,
            { calendarIds: { ...(found.calendarIds || {}), [serverCalendarId]: true } },
            undefined,
            accountId,
          );
          linked++;
        } catch {
          // Leave it where it is; the import of the rest continues.
        }
      }
      toCreate = fresh;
    } catch {
      // Couldn't dedupe — proceed and let the server reject genuine dupes.
    }
    const prepared = toCreate.map(prepareImportedEvent);
    let count = 0;
    // Batch in chunks of 50 to avoid oversized requests.
    for (let i = 0; i < prepared.length; i += 50) {
      count += await apiBatchCreateEvents(prepared.slice(i, i + 50), serverCalendarId, accountId);
    }
    if (count > 0 || linked > 0) await get().refresh();
    return count + linked;
  },

  createCalendar: async (name, color, description) => {
    const created = await apiCreateCalendar(name, color, description);
    set({ calendars: [...get().calendars, created] });
    return created;
  },

  updateCalendar: async (id, updates) => {
    const cal = get().calendars.find((c) => c.id === id);
    await apiUpdateCalendar(cal?.originalId || id, updates, cal?.accountId);
    set({
      calendars: get().calendars.map((c) => (c.id === id ? { ...c, ...updates } as Calendar : c)),
    });
  },

  removeCalendar: async (id) => {
    const cal = get().calendars.find((c) => c.id === id);
    await apiDeleteCalendar(cal?.originalId || id, cal?.accountId);
    set({
      calendars: get().calendars.filter((c) => c.id !== id),
      events: get().events.filter((e) => !e.calendarIds?.[id]),
      tasks: get().tasks.filter((t) => !t.calendarIds?.[id]),
      hiddenCalendarIds: get().hiddenCalendarIds.filter((x) => x !== id),
    });
  },

  clearCalendarEvents: async (id) => {
    const cal = get().calendars.find((c) => c.id === id);
    const removed = await apiClearCalendarEvents(cal?.originalId || id, cal?.accountId);
    await get().refresh();
    return removed;
  },

  shareCalendar: async (id, principalId, rights) => {
    const cal = get().calendars.find((c) => c.id === id);
    await apiSetCalendarShare(cal?.originalId || id, principalId, rights, cal?.accountId);
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
    const cal = get().calendars.find((c) => c.id === id);
    await apiSetDefaultCalendar(cal?.originalId || id, cal?.accountId);
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
    const cal = get().calendars.find((c) => c.id === calendarId);
    await apiCreateEvent(
      { ...task, '@type': 'Task' },
      cal?.originalId || calendarId,
      undefined,
      cal?.accountId,
    );
    await get().fetchTasks();
  },

  updateTask: async (id, changes) => {
    const task = get().tasks.find((t) => t.id === id);
    const realId = task?.originalId || id;
    await apiUpdateEvent(realId, changes, undefined, task?.accountId);
    set({ tasks: get().tasks.map((t) => (t.id === id ? { ...t, ...changes } : t)) });
  },

  toggleTaskComplete: async (id) => {
    const task = get().tasks.find((t) => t.id === id);
    if (!task) return;
    const completed = task.progress === 'completed';
    // Un-completing goes back to needs-action (not in-process), like webmail.
    // No progressUpdated: JSCalendar 2.0 dropped it and Stalwart rejects the
    // whole update with invalidProperties (#958).
    const next: Partial<CalendarEvent> = completed
      ? { progress: 'needs-action', percentComplete: 0 }
      : { progress: 'completed', percentComplete: 100 };
    // Flip the checkbox right away and put it back if the server refuses.
    const patchTask = (changes: Partial<CalendarEvent>) =>
      set({ tasks: get().tasks.map((t) => (t.id === id ? { ...t, ...changes } : t)) });
    patchTask(next);
    try {
      await apiUpdateEvent(task.originalId || id, next, undefined, task.accountId);
    } catch (err) {
      patchTask({ progress: task.progress, percentComplete: task.percentComplete });
      throw err;
    }
  },

  deleteTask: async (id) => {
    const task = get().tasks.find((t) => t.id === id);
    const realId = task?.originalId || id;
    await apiDeleteEvents([realId], undefined, task?.accountId);
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

  reset: () => {
    // A new session may grant access the old one lacked.
    resetCalendarAccessDenied();
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
