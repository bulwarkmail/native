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
} from '../api/calendar';
import { jmapClient } from '../api/jmap-client';
import { expandRecurringEvents } from '../lib/recurrence-expansion';

const HIDDEN_CALENDARS_STORAGE_KEY = 'webmail:calendar:hidden:v1';

export interface LoadedRange {
  after: string;
  before: string;
}

export interface CalendarState {
  calendars: Calendar[];
  events: CalendarEvent[];
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
    try {
      const calendars = (await fetchCalendars()) ?? [];
      set({ calendars });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load calendars' });
    }
  },

  fetchEvents: async (calendarIds, after, before) => {
    set({ loading: true, error: null });
    try {
      const ids = (await queryEvents(calendarIds, after, before)) ?? [];
      const raw = ids.length > 0 ? ((await fetchEvents(ids)) ?? []) : [];
      // Stalwart returns both Events and Tasks from CalendarEvent/query; tasks
      // lack `start` and must be filtered out client-side.
      const onlyEvents = raw.filter((e) => {
        const t = (e as { '@type'?: string })['@type'];
        return (t === 'Event' || t === undefined) && !!e.start;
      });
      const events = expandRecurringEvents(onlyEvents, after, before);
      set({ events, loadedRange: { after, before }, loading: false });
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
      // Calendars haven't loaded yet — fetch them, then events.
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
    const accountId = jmapClient.accountId;
    const accountChanges = change.changed?.[accountId];
    if (!accountChanges) return;

    const calendarChanged = 'Calendar' in accountChanges;
    const eventChanged = 'CalendarEvent' in accountChanges;
    if (!calendarChanged && !eventChanged) return;

    if (calendarChanged) {
      await get().fetchCalendars();
    }
    if (eventChanged || calendarChanged) {
      await get().refresh();
    }
  },

  createEvent: async (event, calendarId) => {
    const created = await apiCreateEvent(event, calendarId);
    set({ events: [...get().events, created] });
    return created;
  },

  updateEvent: async (id, changes) => {
    // Resolve client-side expanded occurrence IDs back to the master event ID.
    const storeEvent = get().events.find((e) => e.id === id);
    const realId = storeEvent?.originalId || id;
    await apiUpdateEvent(realId, changes);
    set({
      events: get().events.map((e) => (e.id === id ? { ...e, ...changes } : e)),
    });
  },

  deleteEvent: async (id) => {
    const storeEvent = get().events.find((e) => e.id === id);
    const realId = storeEvent?.originalId || id;
    await apiDeleteEvents([realId]);
    set({ events: get().events.filter((e) => e.id !== id) });
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
