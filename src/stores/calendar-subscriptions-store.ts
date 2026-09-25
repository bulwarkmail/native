import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { CalendarEvent } from '../api/types';
import {
  createCalendar,
  deleteCalendar,
  getCalendarName,
  parseCalendarBlob,
  queryEvents,
  getEventIdentities,
  deleteEvents,
  updateEvent,
  updateCalendar,
} from '../api/calendar';
import { jmapClient } from '../api/jmap-client';
import { uploadBytes } from '../api/blob';
import { generateAccountId } from '../lib/account-utils';
import { readServerPrimaryAccountId } from '../lib/server-fingerprint';
import { useAccountStore } from './account-store';
import { useCalendarStore } from './calendar-store';
import { t } from './locale-store';

export interface CalendarSubscription {
  id: string;
  name: string;
  url: string;
  color?: string;
  /**
   * The local Stalwart calendar that mirrors this remote feed. Null once the
   * server behind the account was replaced (lib/server-change), whose ids may
   * name other calendars; the next sync makes a new mirror.
   */
  calendarId: string | null;
  /** JMAP account the mirror calendar lives in; subs of other accounts are hidden. */
  accountId?: string;
  /**
   * The signed-in account (username@host) it belongs to: JMAP account ids
   * repeat across servers. Unset on subscriptions made before it was kept,
   * until a sync finds their mirror calendar in an account.
   */
  localAccountId?: string;
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
  /**
   * The server behind a signed-in account was replaced (lib/server-change):
   * its calendar ids name other calendars now, or none. The account's
   * subscriptions keep their feed, name, colour and interval, lose their
   * mirror calendar and get a new one on the next sync. Subscriptions made
   * before the account was recorded on them go with it when they name a JMAP
   * account id the old or the new server gave it, and no other signed-in
   * account has that id.
   */
  unlinkAccount: (localAccountId: string, jmapAccountIds: { previous: string | null; next: string | null }) => Promise<void>;
}

/**
 * Subscriptions belonging to the signed-in account: by username@host where
 * the subscription records it, else by JMAP account id (legacy ones without
 * either count as its own).
 */
export function selectAccountSubscriptions(
  subscriptions: CalendarSubscription[],
  accountId: string | null,
  localAccountId?: string | null,
): CalendarSubscription[] {
  return subscriptions.filter((s) => {
    if (s.localAccountId && localAccountId) return s.localAccountId === localAccountId;
    return !s.accountId || !accountId || s.accountId === accountId;
  });
}

function currentAccountId(): string | null {
  return jmapClient.isConnected ? jmapClient.accountId : null;
}

/** The signed-in account as username@host, when the client serves one. */
export function currentLocalAccountId(): string | null {
  const { username, serverUrl } = jmapClient;
  if (!jmapClient.isConnected || !username || !serverUrl) return null;
  return generateAccountId(username, serverUrl);
}

// The mirror calendar is recognised by the name the subscription gave it.
// A calendar under the recorded id with another name is not the mirror: the
// id may be reused by a replaced server, or the user renamed the calendar.
// False when the server can't be asked.
async function isMirrorCalendar(calendarId: string, name: string): Promise<boolean> {
  try {
    return (await getCalendarName(calendarId)) === name;
  } catch {
    return false;
  }
}

/**
 * Whether a subscription made before subscriptions recorded their account
 * (no localAccountId) is `localAccountId`'s, whose server gave its own data
 * the JMAP ids `jmapAccountIds`. The subscription recorded only its JMAP
 * account, and JMAP ids repeat across servers: it is the account's only when
 * no other signed-in account has that id, or may have it.
 */
async function ownsLegacySubscription(
  sub: CalendarSubscription,
  localAccountId: string,
  jmapAccountIds: Array<string | null>,
): Promise<boolean> {
  if (sub.accountId && !jmapAccountIds.includes(sub.accountId)) return false;
  for (const other of useAccountStore.getState().accounts) {
    if (other.id === localAccountId) continue;
    const otherJmapId = (await readServerPrimaryAccountId(other.id)) ?? other.jmapAccountId ?? null;
    // Not known yet (not signed in to since the id was first recorded).
    if (otherJmapId === null) return false;
    if (!sub.accountId || otherJmapId === sub.accountId) return false;
  }
  return true;
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

// Reconcile the mirror calendar with the remote feed: drop events whose UID
// disappeared upstream (unlinking rather than deleting when the event also
// lives in another calendar), then import the current set (importEvents
// dedupes by UID, so unchanged events are left in place). Callers make sure
// `calendarId` is the mirror: nothing goes into, nor is dropped from, another
// calendar. One made for this sync has nothing to drop.
async function syncFeedIntoCalendar(calendarId: string, url: string, dropStale: boolean): Promise<void> {
  const parsed = await fetchAndParseFeed(url);

  if (dropStale) {
    const parsedUids = new Set(parsed.map((e) => e.uid).filter(Boolean) as string[]);
    try {
      const ids = await queryEvents([calendarId], '', '');
      const existing = await getEventIdentities(ids);
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
          localAccountId: currentLocalAccountId() ?? undefined,
          refreshIntervalMinutes: refreshIntervalMinutes ?? DEFAULT_REFRESH_INTERVAL_MINUTES,
          lastSyncAt: null,
          lastError: null,
        };
        // Make the new calendar visible immediately.
        await useCalendarStore.getState().fetchCalendars();
        try {
          set({ syncing: { ...get().syncing, [sub.id]: true } });
          await syncFeedIntoCalendar(calendar.id, sub.url, false);
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
        const changes: Partial<CalendarSubscription> = {
          ...(updates.name !== undefined ? { name: updates.name.trim() } : {}),
          ...(updates.url !== undefined ? { url: updates.url.trim() } : {}),
          ...(updates.color !== undefined ? { color: updates.color } : {}),
          ...(updates.refreshIntervalMinutes !== undefined
            ? { refreshIntervalMinutes: updates.refreshIntervalMinutes }
            : {}),
        };
        const next: CalendarSubscription = { ...sub, ...changes };
        // An unlinked subscription has no calendar to rename yet; its next
        // sync makes one with the new name and colour. A mirror is renamed
        // first, and when that fails (or its name can't be read) nothing
        // changes: a sync recognises the mirror by the subscription's name,
        // and would take the old-named calendar for another one.
        if (sub.calendarId && (next.name !== sub.name || next.color !== sub.color)) {
          if ((await getCalendarName(sub.calendarId)) === sub.name) {
            // Only what changed: Stalwart 1.0 refuses a colour that is not
            // #rgb, #rrggbb or a CSS name, which another client may have set.
            await updateCalendar(sub.calendarId, {
              ...(next.name !== sub.name ? { name: next.name } : {}),
              ...(next.color !== sub.color ? { color: next.color } : {}),
            });
            void useCalendarStore.getState().fetchCalendars().catch(() => undefined);
          }
        }
        set({ subscriptions: get().subscriptions.map((s) => (s.id === id ? { ...s, ...changes } : s)) });
        if (next.url !== sub.url) await get().syncSubscription(id);
      },

      removeSubscription: async (id) => {
        const sub = get().subscriptions.find((s) => s.id === id);
        set({ subscriptions: get().subscriptions.filter((s) => s.id !== id) });
        // Only a calendar recognisably the mirror is destroyed, with its
        // events: under a replaced server the recorded id can name another.
        if (sub?.calendarId && (await isMirrorCalendar(sub.calendarId, sub.name))) {
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
        // Only its own account syncs a subscription, and an unlinked one gets
        // its new mirror in its own account only.
        const localAccountId = currentLocalAccountId();
        if (sub.localAccountId && sub.localAccountId !== localAccountId) return;
        if (!sub.calendarId && !localAccountId) return;
        set({ syncing: { ...get().syncing, [id]: true } });
        try {
          const jmapAccountId = currentAccountId();
          let calendarId = sub.calendarId;
          // Throws when the server can't be asked; the next sync tries again.
          if (calendarId && (await getCalendarName(calendarId)) !== sub.name) {
            // The recorded id names another calendar, or none: the server was
            // replaced unseen, or the mirror was renamed or removed elsewhere.
            // The feed goes into its own mirror only: a new one, made as for
            // an unlinked subscription. One made before subscriptions recorded
            // their account may be another account's, with the same JMAP id.
            if (!sub.localAccountId
              && !(localAccountId && (await ownsLegacySubscription(sub, localAccountId, [jmapAccountId])))) {
              return;
            }
            calendarId = null;
          } else if (calendarId && !sub.localAccountId && localAccountId) {
            // Its mirror is in this account, so it is this account's alone
            // from now on, not every account's with the same JMAP id.
            const owner = { localAccountId, accountId: sub.accountId ?? jmapAccountId ?? undefined };
            set({ subscriptions: get().subscriptions.map((s) => (s.id === id ? { ...s, ...owner } : s)) });
          }
          if (!calendarId) {
            // As addSubscription does. Linked right away, so a feed that
            // fails below doesn't get another calendar on the next sync.
            calendarId = (await createCalendar(sub.name, sub.color)).id;
            const linked = { calendarId, accountId: jmapAccountId ?? undefined, localAccountId: localAccountId ?? undefined };
            set({ subscriptions: get().subscriptions.map((s) => (s.id === id ? { ...s, ...linked } : s)) });
            await useCalendarStore.getState().fetchCalendars();
          }
          const linkedBefore = calendarId === sub.calendarId;
          await syncFeedIntoCalendar(calendarId, sub.url, linkedBefore);
          set({
            subscriptions: get().subscriptions.map((s) =>
              s.id === id ? { ...s, lastSyncAt: Date.now(), lastError: null } : s,
            ),
          });
          if (!linkedBefore) await useCalendarStore.getState().refresh();
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
        const subs = selectAccountSubscriptions(get().subscriptions, currentAccountId(), currentLocalAccountId());
        for (const sub of subs) {
          await get().syncSubscription(sub.id);
        }
      },

      syncDue: async () => {
        if (!jmapClient.isConnected) return;
        const now = Date.now();
        const subs = selectAccountSubscriptions(get().subscriptions, currentAccountId(), currentLocalAccountId());
        for (const sub of subs) {
          const interval = (sub.refreshIntervalMinutes ?? DEFAULT_REFRESH_INTERVAL_MINUTES) * 60_000;
          if (sub.lastSyncAt && now - sub.lastSyncAt < interval) continue;
          await get().syncSubscription(sub.id);
        }
      },

      unlinkAccount: async (localAccountId, { previous, next }) => {
        // Cold start: the subscriptions may not have been read from storage yet.
        if (!useCalendarSubscriptionsStore.persist.hasHydrated()) {
          await useCalendarSubscriptionsStore.persist.rehydrate();
        }
        const owned = new Set<string>();
        for (const s of get().subscriptions) {
          const mine = s.localAccountId
            ? s.localAccountId === localAccountId
            : await ownsLegacySubscription(s, localAccountId, [previous, next]);
          if (mine) owned.add(s.id);
        }
        set({
          subscriptions: get().subscriptions.map((s) => (owned.has(s.id)
            ? {
              ...s,
              calendarId: null,
              localAccountId,
              accountId: next ?? s.accountId,
              // Due at once: the calendar is gone until the next sync.
              lastSyncAt: null,
              lastError: null,
            }
            : s)),
        });
      },
    }),
    {
      name: 'calendar-subscriptions',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({ subscriptions: state.subscriptions }),
    },
  ),
);
