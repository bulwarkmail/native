import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CalendarEvent } from '../api/types';
import {
  createCalendar,
  deleteCalendar,
  parseCalendarBlob,
  queryEvents,
  getEvents,
  deleteEvents,
} from '../api/calendar';
import { uploadBytes } from '../api/blob';
import { useCalendarStore } from './calendar-store';

export interface CalendarSubscription {
  id: string;
  name: string;
  url: string;
  color?: string;
  /** The local Stalwart calendar that mirrors this remote feed. */
  calendarId: string;
  lastSyncAt: number | null;
  lastError: string | null;
}

interface SubscriptionsState {
  subscriptions: CalendarSubscription[];
  syncing: Record<string, boolean>;

  addSubscription: (input: { name: string; url: string; color?: string }) => Promise<CalendarSubscription>;
  removeSubscription: (id: string) => Promise<void>;
  syncSubscription: (id: string) => Promise<void>;
  syncAll: () => Promise<void>;
}

// webcal:// is just iCalendar over HTTP(S) — browsers/clients map it to https.
function normalizeFeedUrl(url: string): string {
  return url.trim().replace(/^webcal:\/\//i, 'https://');
}

async function fetchAndParseFeed(url: string): Promise<Partial<CalendarEvent>[]> {
  const res = await fetch(normalizeFeedUrl(url));
  if (!res.ok) throw new Error(`Could not fetch feed (HTTP ${res.status})`);
  const text = await res.text();
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    throw new Error('That URL did not return an iCalendar feed');
  }
  const bytes = new TextEncoder().encode(text);
  const { blobId } = await uploadBytes(bytes, 'text/calendar');
  const events = await parseCalendarBlob(blobId);
  return events.filter((e) => !!e.start);
}

// Reconcile the local calendar with the remote feed: delete events whose UID
// disappeared upstream, then import the current set (importEvents dedupes by
// UID, so unchanged events are left in place).
async function syncFeedIntoCalendar(calendarId: string, url: string): Promise<void> {
  const parsed = await fetchAndParseFeed(url);
  const parsedUids = new Set(parsed.map((e) => e.uid).filter(Boolean) as string[]);

  try {
    const allIds = await queryEvents([], '', '');
    const all = allIds.length > 0 ? await getEvents(allIds) : [];
    const stale = all
      .filter((e) => e.calendarIds?.[calendarId] && e.uid && !parsedUids.has(e.uid))
      .map((e) => e.id);
    if (stale.length > 0) await deleteEvents(stale);
  } catch {
    // Non-fatal: if we can't enumerate existing events, still import new ones.
  }

  await useCalendarStore.getState().importEvents(parsed, calendarId);
}

export const useCalendarSubscriptionsStore = create<SubscriptionsState>()(
  persist(
    (set, get) => ({
      subscriptions: [],
      syncing: {},

      addSubscription: async ({ name, url, color }) => {
        // Create a dedicated local calendar to hold the feed's events.
        const calendar = await createCalendar(name, color);
        const sub: CalendarSubscription = {
          id: `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          name,
          url: url.trim(),
          color,
          calendarId: calendar.id,
          lastSyncAt: null,
          lastError: null,
        };
        set({ subscriptions: [...get().subscriptions, sub] });
        // Make the new calendar visible immediately.
        await useCalendarStore.getState().fetchCalendars();
        try {
          set({ syncing: { ...get().syncing, [sub.id]: true } });
          await syncFeedIntoCalendar(sub.calendarId, sub.url);
          set({
            subscriptions: get().subscriptions.map((s) =>
              s.id === sub.id ? { ...s, lastSyncAt: Date.now(), lastError: null } : s,
            ),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Sync failed';
          set({
            subscriptions: get().subscriptions.map((s) =>
              s.id === sub.id ? { ...s, lastError: message } : s,
            ),
          });
        } finally {
          set({ syncing: { ...get().syncing, [sub.id]: false } });
        }
        return sub;
      },

      removeSubscription: async (id) => {
        const sub = get().subscriptions.find((s) => s.id === id);
        set({ subscriptions: get().subscriptions.filter((s) => s.id !== id) });
        if (sub) {
          try {
            await deleteCalendar(sub.calendarId);
          } catch {
            // best-effort
          }
          await useCalendarStore.getState().fetchCalendars();
          await useCalendarStore.getState().refresh();
        }
      },

      syncSubscription: async (id) => {
        const sub = get().subscriptions.find((s) => s.id === id);
        if (!sub) return;
        set({ syncing: { ...get().syncing, [id]: true } });
        try {
          await syncFeedIntoCalendar(sub.calendarId, sub.url);
          set({
            subscriptions: get().subscriptions.map((s) =>
              s.id === id ? { ...s, lastSyncAt: Date.now(), lastError: null } : s,
            ),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Sync failed';
          set({
            subscriptions: get().subscriptions.map((s) =>
              s.id === id ? { ...s, lastError: message } : s,
            ),
          });
        } finally {
          set({ syncing: { ...get().syncing, [id]: false } });
        }
      },

      syncAll: async () => {
        const subs = get().subscriptions;
        for (const sub of subs) {
          await get().syncSubscription(sub.id);
        }
      },
    }),
    {
      name: 'calendar-subscriptions',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ subscriptions: state.subscriptions }),
    },
  ),
);
