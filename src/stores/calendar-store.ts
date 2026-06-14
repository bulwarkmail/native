import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Calendar, CalendarEvent, StateChange } from '../api/types';
import {
  getCalendars as fetchCalendars,
  queryEvents,
  getEvents as fetchEvents,
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

export interface LoadedRange {
  after: string;
  before: string;
}

export interface CalendarState {
  calendars: Calendar[];
  events: CalendarEvent[];
  tasks: CalendarEvent[];
  hiddenCalendarIds: string[];
  loadedRange: LoadedRange | null;
  loading: boolean;
  error: string | null;
  hydrated: boolean;

  hydrate: () => Promise<void>;
  fetchCalendars: () => Promise<void>;
  fetchEvents: (calendarIds: string[], after: string, before: string) => Promise<void>;
  ensureRange: (after: string, before: string) => Promise<void>;
  refresh: () => Promise<void>;
  handleStateChange: (change: StateChange) => Promise<void>;
  createEvent: (event: Partial<CalendarEvent>, calendarId: string) => Promise<CalendarEvent>;
  updateEvent: (id: string, changes: Partial<CalendarEvent>) => Promise<void>;
  deleteEvent: (id: string) => Promise<void>;
  // Invitations / scheduling
  rsvpEvent: (
    eventId: string,
    participantId: string,
    status: 'accepted' | 'declined' | 'tentative',
    replyTo?: Record<string, string> | null,
  ) => Promise<void>;
  importEvents: (events: Partial<CalendarEvent>[], calendarId: string) => Promise<number>;
  createCalendar: (name: string, color?: string) => Promise<Calendar>;
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
    try {
      const calendars = (await fetchCalendars()) ?? [];
      set({ calendars });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load calendars' });
    }
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
        try {
          const eventIds = (await queryEvents(ids, after, before, accountId)) ?? [];
          if (eventIds.length === 0) continue;
          const fetched = (await fetchEvents(eventIds, accountId)) ?? [];
          raw.push(...fetched.map((e) => mapServerEventToStoreEvent(e, calendars, accountId)));
        } catch (err) {
          // A failing shared account must not hide the user's own events.
          if (!accountId) throw err;
        }
      }
      // Stalwart returns both Events and Tasks from CalendarEvent/query. Events
      // have a `start`; tasks are surfaced separately so they don't pollute the
      // grid (they're shown in the task list with their due date instead).
      const onlyEvents = raw.filter((e) => {
        const t = (e as { '@type'?: string })['@type'];
        return (t === 'Event' || t === undefined) && !!e.start;
      });
      const tasks = raw.filter((e) => (e as { '@type'?: string })['@type'] === 'Task');
      const events = expandRecurringEvents(onlyEvents, after, before);
      set({ events, tasks, loadedRange: { after, before }, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load events' });
    }
  },

  ensureRange: async (after, before) => {
    const { loadedRange, calendars } = get();
    if (loadedRange && rangeCovers(loadedRange, after, before)) return;

    const target = loadedRange ? unionRange(loadedRange, after, before) : { after, before };
    const ids = calendars.map((c) => c.id);
    if (ids.length === 0) {
      // Calendars haven't loaded yet - fetch them, then events.
      await get().fetchCalendars();
    }
    const calendarIdsAfter = get().calendars.map((c) => c.id);
    if (calendarIdsAfter.length === 0) {
      set({ loadedRange: target });
      return;
    }
    await get().fetchEvents(calendarIdsAfter, target.after, target.before);
  },

  refresh: async () => {
    const { loadedRange, calendars } = get();
    if (!loadedRange) return;
    const ids = calendars.map((c) => c.id);
    if (ids.length === 0) return;
    await get().fetchEvents(ids, loadedRange.after, loadedRange.before);
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

  createEvent: async (event, calendarId) => {
    // Shared calendars live in the owner's account — route the create there,
    // and against the calendar's raw server id (calendarId is the namespaced
    // store id for shared calendars).
    const calendars = get().calendars;
    const cal = calendars.find((c) => c.id === calendarId);
    const accountId = cal?.accountId;
    const created = await apiCreateEvent(
      event,
      cal?.originalId || calendarId,
      hasSchedulingParticipants(event) ? true : undefined,
      accountId,
    );
    // Map the same way fetchEvents does so the optimistic insert doesn't
    // collide with the user's own events and stays visible under the right
    // calendar filter.
    set({ events: [...get().events, mapServerEventToStoreEvent(created, calendars, accountId)] });
    return created;
  },

  updateEvent: async (id, changes) => {
    // Resolve client-side expanded occurrence IDs back to the master event ID.
    const storeEvent = get().events.find((e) => e.id === id);
    const realId = storeEvent?.originalId || id;
    // Notify attendees if either the stored event or the incoming changes
    // carry participants.
    const schedule =
      hasSchedulingParticipants(changes) || hasSchedulingParticipants(storeEvent);
    await apiUpdateEvent(realId, changes, schedule ? true : undefined, storeEvent?.accountId);
    set({
      events: get().events.map((e) => (e.id === id ? { ...e, ...changes } : e)),
    });
  },

  deleteEvent: async (id) => {
    const storeEvent = get().events.find((e) => e.id === id);
    const realId = storeEvent?.originalId || id;
    await apiDeleteEvents(
      [realId],
      hasSchedulingParticipants(storeEvent) ? true : undefined,
      storeEvent?.accountId,
    );
    set({ events: get().events.filter((e) => e.id !== id) });
  },

  rsvpEvent: async (eventId, participantId, status, replyTo) => {
    if (!participantId || participantId.includes('..')) {
      throw new Error('Invalid participant ID');
    }
    const storeEvent = get().events.find((e) => e.id === eventId);
    const realId = storeEvent?.originalId || eventId;
    await apiRsvpEvent(realId, participantId, status, replyTo, storeEvent?.accountId);
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
    // Stalwart enforces UID uniqueness across calendars. Skip events whose UID
    // already exists; create the rest. (We don't attempt cross-calendar linking
    // on mobile — a duplicate is simply skipped.)
    let toCreate = events;
    try {
      const existingIds = await queryEvents([], '', '', accountId);
      const existing = existingIds.length > 0 ? await fetchEvents(existingIds, accountId) : [];
      const seenUids = new Set(existing.map((e) => e.uid).filter(Boolean) as string[]);
      toCreate = events.filter((e) => !e.uid || !seenUids.has(e.uid));
    } catch {
      // Couldn't dedupe — proceed and let the server reject genuine dupes.
    }
    if (toCreate.length === 0) return 0;
    const count = await apiBatchCreateEvents(toCreate, serverCalendarId, accountId);
    await get().refresh();
    return count;
  },

  createCalendar: async (name, color) => {
    const created = await apiCreateCalendar(name, color);
    set({ calendars: [...get().calendars, created] });
    return created;
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
    await get().refresh();
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
    const next: Partial<CalendarEvent> = completed
      ? { progress: 'in-process', percentComplete: 0 }
      : { progress: 'completed', percentComplete: 100 };
    await get().updateTask(id, next);
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

  reset: () => set({
    calendars: [],
    events: [],
    tasks: [],
    loadedRange: null,
    loading: false,
    error: null,
  }),
    }),
    {
      // Persist calendars + expanded events + the range they cover so the
      // calendar renders instantly on re-open. A refresh happens in the
      // background and replaces the cached data with fresh copies.
      name: 'calendar-cache',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        calendars: state.calendars,
        events: state.events,
        tasks: state.tasks,
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
