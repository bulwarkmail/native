import { create } from 'zustand';
import type { Calendar, CalendarEvent } from '../api/types';
import {
  getCalendars as fetchCalendars,
  queryEvents,
  getEvents as fetchEvents,
  createEvent as apiCreateEvent,
  updateEvent as apiUpdateEvent,
  deleteEvents as apiDeleteEvents,
} from '../api/calendar';

export interface CalendarState {
  calendars: Calendar[];
  events: CalendarEvent[];
  loading: boolean;
  error: string | null;

  fetchCalendars: () => Promise<void>;
  fetchEvents: (calendarIds: string[], after: string, before: string) => Promise<void>;
  createEvent: (event: Partial<CalendarEvent>, calendarId: string) => Promise<CalendarEvent>;
  updateEvent: (id: string, changes: Partial<CalendarEvent>) => Promise<void>;
  deleteEvent: (id: string) => Promise<void>;
  reset: () => void;
}

export const useCalendarStore = create<CalendarState>((set, get) => ({
  calendars: [],
  events: [],
  loading: false,
  error: null,

  fetchCalendars: async () => {
    try {
      const calendars = await fetchCalendars();
      set({ calendars });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Failed to load calendars' });
    }
  },

  fetchEvents: async (calendarIds, after, before) => {
    set({ loading: true, error: null });
    try {
      const ids = await queryEvents(calendarIds, after, before);
      const events = ids.length > 0 ? await fetchEvents(ids) : [];
      set({ events, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : 'Failed to load events' });
    }
  },

  createEvent: async (event, calendarId) => {
    const created = await apiCreateEvent(event, calendarId);
    set({ events: [...get().events, created] });
    return created;
  },

  updateEvent: async (id, changes) => {
    await apiUpdateEvent(id, changes);
    set({
      events: get().events.map((e) =>
        e.id === id ? { ...e, ...changes } : e,
      ),
    });
  },

  deleteEvent: async (id) => {
    await apiDeleteEvents([id]);
    set({ events: get().events.filter((e) => e.id !== id) });
  },

  reset: () => set({
    calendars: [],
    events: [],
    loading: false,
    error: null,
  }),
}));
