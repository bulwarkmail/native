import { AppState } from 'react-native';
import { jmapClient } from '../api/jmap-client';
import {
  destroyCalendarEventNotifications,
  getCalendarEventNotifications,
  isCancellation,
  type CalendarEventNotification,
} from '../api/calendar-event-notifications';
import { useAuthStore } from '../stores/auth-store';
import { useCalendarStore } from '../stores/calendar-store';
import { t as translate } from '../stores/locale-store';
import { toast } from '../stores/toast-store';
import { hasCalendarCapability } from './capabilities';
import { onStateChangeType } from './state-change-bus';

// Someone invited the user, changed or cancelled an event the user takes
// part in: the server keeps a CalendarEventNotification for it. They are
// pulled at sign-in, on every `CalendarEventNotification` push and when the
// app comes back to the foreground, shown as toasts, the events in view are
// refreshed so the change shows, and the notifications are acknowledged,
// which destroys them on the server. Ported from the webmail's
// stores/calendar-event-notification-store.ts,
// lib/pending-notification-store.ts and
// components/layout/calendar-event-notification-toaster.tsx.

type Translate = (key: string, fallback?: string, params?: Record<string, string | number>) => string;

export interface EventNotificationToast {
  type: 'info' | 'warning';
  title: string;
  message?: string;
}

/** The toast for one notification; null for a draft (the user's own unsent change). */
export function eventNotificationToast(n: CalendarEventNotification, t: Translate): EventNotificationToast | null {
  if (n.isDraft) return null;
  // Stalwart sends an organizer's cancellation as an update setting the
  // status to cancelled (the webmail reads only `type` and says "updated").
  const kind = n.type === 'created' ? 'invited' : isCancellation(n) ? 'cancelled' : 'updated';
  const params = {
    name: n.changedBy?.name || n.changedBy?.email || t('calendar_event_notifications.someone', 'Someone'),
    title: n.event?.title || t('calendar_event_notifications.untitled', 'Untitled event'),
  };
  const title = kind === 'invited'
    ? t('calendar_event_notifications.invited', '{name} invited you to "{title}"', params)
    : kind === 'cancelled'
      ? t('calendar_event_notifications.cancelled', '{name} cancelled "{title}"', params)
      : t('calendar_event_notifications.updated', '{name} updated "{title}"', params);
  return { type: kind === 'cancelled' ? 'warning' : 'info', title, message: n.comment || undefined };
}

// Ids already shown in this session; a pull racing an acknowledgement must
// not show them again.
const seen = new Set<string>();
let seenFor: string | null = null;
let inFlight: Promise<void> | null = null;
let again = false;
let syncStarted = false;
let pullTimer: ReturnType<typeof setTimeout> | null = null;

function sessionKey(): string | null {
  try {
    return `${jmapClient.currentSession?.apiUrl ?? ''}|${jmapClient.accountId}`;
  } catch {
    return null;
  }
}

/**
 * Fetch the pending notifications, show the new ones, refresh the calendar
 * and acknowledge them. Concurrent calls coalesce; a push arriving while a
 * pull runs pulls again afterwards. Never rejects.
 */
export function pullCalendarEventNotifications(): Promise<void> {
  if (inFlight) {
    again = true;
    return inFlight;
  }
  inFlight = (async () => {
    try {
      do {
        again = false;
        await pullOnce();
      } while (again);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

async function pullOnce(): Promise<void> {
  if (!jmapClient.isConnected || !hasCalendarCapability()) return;
  const key = sessionKey();
  if (!key) return;
  if (key !== seenFor) {
    seen.clear();
    seenFor = key;
  }
  let list: CalendarEventNotification[];
  try {
    list = await getCalendarEventNotifications();
  } catch (error) {
    console.warn('[calendar] Failed to fetch calendar event notifications:', error);
    return;
  }
  // Another account by now: its own pull shows its own.
  if (sessionKey() !== key) return;
  const fresh = list.filter((n) => !seen.has(n.id));
  if (fresh.length === 0) return;
  for (const n of fresh) {
    seen.add(n.id);
    const shown = eventNotificationToast(n, translate as Translate);
    if (shown) toast[shown.type](shown.title, shown.message);
  }
  void useCalendarStore.getState().refresh().catch(() => undefined);
  try {
    await destroyCalendarEventNotifications(fresh.map((n) => n.id));
  } catch (error) {
    // Worst case they are shown again after a restart.
    console.warn('[calendar] Failed to acknowledge calendar event notifications:', error);
  }
}

function pullSoon(): void {
  if (pullTimer) clearTimeout(pullTimer);
  // Sign-in fans out its own requests first; a burst of pushes is one pull.
  pullTimer = setTimeout(() => {
    pullTimer = null;
    void pullCalendarEventNotifications();
  }, 1000);
}

/** Pull event notifications for the rest of the session. Idempotent. */
export function startCalendarEventNotificationSync(): void {
  if (syncStarted) return;
  syncStarted = true;
  onStateChangeType('CalendarEventNotification', pullSoon);
  useAuthStore.subscribe((state, prev) => {
    if (state.session !== prev.session && state.session) pullSoon();
  });
  // Pushes stop while the app is in the background.
  AppState.addEventListener('change', (state) => {
    if (state === 'active') pullSoon();
  });
  pullSoon();
}

/** Forget what was shown (tests). */
export function resetCalendarEventNotifications(): void {
  seen.clear();
  seenFor = null;
  inFlight = null;
  again = false;
  if (pullTimer) clearTimeout(pullTimer);
  pullTimer = null;
}
