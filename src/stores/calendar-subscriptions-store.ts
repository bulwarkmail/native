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
  updateEvent,
  updateCalendar,
} from '../api/calendar';
import { jmapClient } from '../api/jmap-client';
import { uploadBytes } from '../api/blob';
import { useCalendarStore } from './calendar-store';
import { t } from './locale-store';

export interface CalendarSubscription {
  id: string;
  name: string;
  url: string;
  color?: string;
  /** The local Stalwart calendar that mirrors this remote feed. */
  calendarId: string;
  /** JMAP account the mirror calendar lives in; subs of other accounts are hidden. */
  accountId?: string;
  /** Minutes between automatic refreshes (default 60). */
  refreshIntervalMinutes?: number;
  lastSyncAt: number | null;
  lastError: string | null;
}

export const DEFAULT_REFRESH_INTERVAL_MINUTES = 60;

// 10 MB is far beyond any real feed; a bigger response is not a calendar.
const MAX_FEED_BYTES = 10 * 1024 * 1024;

interface SubscriptionsState {
  subscriptions: CalendarSubscription[];
  syncing: Record<string, boolean>;

  addSubscription: (input: {
    name: string;
    url: string;
    color?: string;
    refreshIntervalMinutes?: number;
  }) => Promise<CalendarSubscription>;
  updateSubscription: (
    id: string,
    updates: { name?: string; url?: string; color?: string; refreshIntervalMinutes?: number },
  ) => Promise<void>;
  removeSubscription: (id: string) => Promise<void>;
  syncSubscription: (id: string) => Promise<void>;
  syncAll: () => Promise<void>;
  /** Refresh every subscription of the active account whose interval elapsed. */
  syncDue: () => Promise<void>;
}

/** Subscriptions belonging to the signed-in JMAP account (legacy ones without an accountId count as its own). */
export function selectAccountSubscriptions(
  subscriptions: CalendarSubscription[],
  accountId: string | null,
): CalendarSubscription[] {
  return subscriptions.filter((s) => !s.accountId || !accountId || s.accountId === accountId);
}

function currentAccountId(): string | null {
  return jmapClient.isConnected ? jmapClient.accountId : null;
}

// webcal:// and webcals:// are just iCalendar over HTTP(S) — clients map
// them to https. Credentials embedded in the URL (#275) are moved into an
// Authorization header because RN's WHATWG fetch rejects userinfo in URLs.
export function normalizeFeedUrl(url: string): { url: string; headers: Record<string, string> } {
  let normalized = url.trim().replace(/^webcals?:\/\//i, 'https://');
  const headers: Record<string, string> = {};
  const m = /^(https?:\/\/)([^/@]+)@(.+)$/i.exec(normalized);
  if (m) {
    const creds = decodeURIComponent(m[2]);
    normalized = `${m[1]}${m[3]}`;
    headers.Authorization = `Basic ${base64(creds)}`;
  }
  return { url: normalized, headers };
}

function base64(input: string): string {
  const g = globalThis as { btoa?: (s: string) => string; Buffer?: { from: (s: string, e: string) => { toString: (e: string) => string } } };
  if (g.btoa) {
    // btoa expects latin1; encode UTF-8 bytes first.
    const bytes = new TextEncoder().encode(input);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return g.btoa(bin);
  }
  if (g.Buffer) return g.Buffer.from(input, 'utf8').toString('base64');
  return input;
}

async function fetchAndParseFeed(url: string): Promise<Partial<CalendarEvent>[]> {
  const { url: feedUrl, headers } = normalizeFeedUrl(url);
  const res = await fetch(feedUrl, { headers });
  if (!res.ok) {
    throw new Error(t('calendar.subscription.fetch_failed', 'Could not fetch feed (HTTP {status})', { status: res.status }));
  }
  const tooLarge = () => new Error(t('calendar.subscription.feed_too_large', 'Feed is too large'));
  const length = Number(res.headers.get('content-length') || 0);
  if (length > MAX_FEED_BYTES) throw tooLarge();
  const text = await res.text();
  if (text.length > MAX_FEED_BYTES) throw tooLarge();
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    throw new Error(t('calendar.subscription.not_a_feed', 'That URL did not return an iCalendar feed'));
  }
  const bytes = new TextEncoder().encode(text);
  const { blobId } = await uploadBytes(bytes, 'text/calendar');
  const events = await parseCalendarBlob(blobId);
  return events.filter((e) => !!e.start);
}

// Reconcile the local calendar with the remote feed: drop events whose UID
// disappeared upstream (unlinking rather than deleting when the event also
// lives in another calendar), then import the current set (importEvents
// dedupes by UID, so unchanged events are left in place).
async function syncFeedIntoCalendar(calendarId: string, url: string): Promise<void> {
  const parsed = await fetchAndParseFeed(url);
  const parsedUids = new Set(parsed.map((e) => e.uid).filter(Boolean) as string[]);

  try {
    const ids = await queryEvents([calendarId], '', '');
    const existing = ids.length > 0 ? await getEvents(ids) : [];
    const stale = existing.filter((e) => e.uid && !parsedUids.has(e.uid));
    const toDelete: string[] = [];
    for (const e of stale) {
      const others = { ...(e.calendarIds || {}) };
      delete others[calendarId];
      if (Object.keys(others).length === 0) toDelete.push(e.id);
      else await updateEvent(e.id, { calendarIds: others });
    }
    if (toDelete.length > 0) await deleteEvents(toDelete);
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

      addSubscription: async ({ name, url, color, refreshIntervalMinutes }) => {
        // Create a dedicated local calendar to hold the feed's events.
        const calendar = await createCalendar(name, color);
        const sub: CalendarSubscription = {
          id: `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
          name,
          url: url.trim(),
          color,
          calendarId: calendar.id,
          accountId: currentAccountId() ?? undefined,
          refreshIntervalMinutes: refreshIntervalMinutes ?? DEFAULT_REFRESH_INTERVAL_MINUTES,
          lastSyncAt: null,
          lastError: null,
        };
        // Make the new calendar visible immediately.
        await useCalendarStore.getState().fetchCalendars();
        try {
          set({ syncing: { ...get().syncing, [sub.id]: true } });
          await syncFeedIntoCalendar(sub.calendarId, sub.url);
          set({ subscriptions: [...get().subscriptions, { ...sub, lastSyncAt: Date.now() }] });
          await useCalendarStore.getState().refresh();
          return { ...sub, lastSyncAt: Date.now() };
        } catch (err) {
          // Roll back: a bad URL / 404 must not leave a phantom calendar behind.
          try {
            await deleteCalendar(calendar.id);
          } catch {
            // best-effort
          }
          await useCalendarStore.getState().fetchCalendars();
          throw err instanceof Error ? err : new Error(t('calendar.subscription.error', 'Failed to add subscription'));
        } finally {
          set({ syncing: { ...get().syncing, [sub.id]: false } });
        }
      },

      updateSubscription: async (id, updates) => {
        const sub = get().subscriptions.find((s) => s.id === id);
        if (!sub) return;
        const next: CalendarSubscription = {
          ...sub,
          ...(updates.name !== undefined ? { name: updates.name.trim() } : {}),
          ...(updates.url !== undefined ? { url: updates.url.trim() } : {}),
          ...(updates.color !== undefined ? { color: updates.color } : {}),
          ...(updates.refreshIntervalMinutes !== undefined
            ? { refreshIntervalMinutes: updates.refreshIntervalMinutes }
            : {}),
        };
        if (next.name !== sub.name || next.color !== sub.color) {
          try {
            await updateCalendar(sub.calendarId, { name: next.name, color: next.color });
            await useCalendarStore.getState().fetchCalendars();
          } catch {
            // The mirror calendar keeps its old name/colour; the sub still updates.
          }
        }
        set({ subscriptions: get().subscriptions.map((s) => (s.id === id ? next : s)) });
        if (next.url !== sub.url) await get().syncSubscription(id);
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
        if (get().syncing[id]) return;
        set({ syncing: { ...get().syncing, [id]: true } });
        try {
          await syncFeedIntoCalendar(sub.calendarId, sub.url);
          set({
            subscriptions: get().subscriptions.map((s) =>
              s.id === id ? { ...s, lastSyncAt: Date.now(), lastError: null } : s,
            ),
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : t('calendar.subscription.refresh_error', 'Failed to refresh subscription');
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
        const subs = selectAccountSubscriptions(get().subscriptions, currentAccountId());
        for (const sub of subs) {
          await get().syncSubscription(sub.id);
        }
      },

      syncDue: async () => {
        if (!jmapClient.isConnected) return;
        const now = Date.now();
        const subs = selectAccountSubscriptions(get().subscriptions, currentAccountId());
        for (const sub of subs) {
          const interval = (sub.refreshIntervalMinutes ?? DEFAULT_REFRESH_INTERVAL_MINUTES) * 60_000;
          if (sub.lastSyncAt && now - sub.lastSyncAt < interval) continue;
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
