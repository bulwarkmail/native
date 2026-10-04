import { create } from 'zustand';
import { jmapClient } from '../api/jmap-client';
import {
  destroyCalendarEventNotifications,
  getCalendarEventNotifications,
} from '../api/calendar-event-notifications';
import type { CalendarEventNotification } from '../api/types';
import { activeAppAccountId, clientServesActiveAccount } from '../lib/active-client-account';

/**
 * A notice tagged with the JMAP account it was fetched for and the app account
 * (account-store id) that was active. The JMAP account id alone is not unique:
 * Stalwart servers hand out the same short ids, so two accounts on different
 * servers can share both it and the notice ids.
 */
export type PendingCalendarEventNotification = CalendarEventNotification & {
  accountId: string;
  appAccountId: string;
};

interface CalendarEventNotificationState {
  /** Notices of the active account not yet handed to the toaster. */
  pending: PendingCalendarEventNotification[];
  fetch: () => Promise<void>;
  /** Removes the notices locally, then destroys them on the server. */
  acknowledge: (ids: string[]) => Promise<void>;
  reset: () => void;
}

function currentJmapAccountId(): string | null {
  try {
    return jmapClient.accountId;
  } catch {
    return null;
  }
}

// Bumped by reset() so a fetch that lands after an account switch or a
// sign-out is dropped instead of shown (same pattern as contacts-store's
// directory load).
let generation = 0;
let inFlight: Promise<void> | null = null;
let inFlightToken: object | null = null;
// `${appAccountId}:${id}` of every notice already queued this session. Kept
// across reset(): a notice the server failed to destroy comes back on the next
// fetch and must not toast twice. (After an app restart it can toast once more.)
const seen = new Set<string>();

export const useCalendarEventNotificationStore = create<CalendarEventNotificationState>((set, get) => ({
  pending: [],

  fetch: () => {
    // Coalesce: a push arriving while the previous fetch runs joins it.
    if (inFlight) return inFlight;
    if (!jmapClient.isConnected) return Promise.resolve();
    const mine = generation;
    const accountId = currentJmapAccountId();
    const appAccountId = activeAppAccountId();
    if (!accountId || !appAccountId || !clientServesActiveAccount()) return Promise.resolve();
    const token = {};
    inFlightToken = token;
    const run: Promise<void> = (async () => {
      // Yield so a synchronous failure cannot clear the slot before it is set.
      await Promise.resolve();
      try {
        const list = await getCalendarEventNotifications();
        if (mine !== generation) return;
        // Dropped, and not marked seen, when the client moved to (or is still
        // on) another account than the one this was fetched for.
        if (currentJmapAccountId() !== accountId || activeAppAccountId() !== appAccountId || !clientServesActiveAccount()) return;
        const fresh = list
          .filter((n) => !seen.has(`${appAccountId}:${n.id}`))
          .map((n): PendingCalendarEventNotification => ({ ...n, accountId, appAccountId }));
        if (fresh.length === 0) return;
        for (const n of fresh) seen.add(`${appAccountId}:${n.id}`);
        set((state) => ({ pending: [...state.pending, ...fresh] }));
      } catch (error) {
        console.error('Failed to fetch calendar event notifications:', error);
      } finally {
        if (inFlightToken === token) { inFlight = null; inFlightToken = null; }
      }
    })();
    inFlight = run;
    return run;
  },

  acknowledge: async (ids) => {
    if (ids.length === 0) return;
    const idSet = new Set(ids);
    const mine = get().pending.filter((n) => idSet.has(n.id));
    set({ pending: get().pending.filter((n) => !idSet.has(n.id)) });
    // Destroy on the account each notice came from, never the active one.
    const byAccount = new Map<string, { accountId: string; appAccountId: string; ids: string[] }>();
    for (const n of mine) {
      const key = `${n.appAccountId}\u0000${n.accountId}`;
      const group = byAccount.get(key) ?? { accountId: n.accountId, appAccountId: n.appAccountId, ids: [] };
      group.ids.push(n.id);
      byAccount.set(key, group);
    }
    for (const { accountId, appAccountId, ids: groupIds } of byAccount.values()) {
      try {
        await destroyCalendarEventNotifications(
          groupIds,
          accountId,
          () => clientServesActiveAccount() && activeAppAccountId() === appAccountId,
        );
      } catch (error) {
        // `seen` keeps it from toasting again this session.
        console.error('Failed to acknowledge calendar event notifications:', error);
      }
    }
  },

  reset: () => {
    generation++;
    inFlight = null;
    inFlightToken = null;
    set({ pending: [] });
  },
}));
