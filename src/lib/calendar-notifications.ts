import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { CalendarEvent } from '../api/types';
import { jmapClient } from '../api/jmap-client';
import { useAuthStore } from '../stores/auth-store';
import { loadEventsInRange, useCalendarStore } from '../stores/calendar-store';
import { useSettingsStore } from '../stores/settings-store';
import { useLocaleStore } from '../stores/locale-store';
import { hasCalendarCapability } from './capabilities';
import { onStateChangeType } from './state-change-bus';
import { getUpcomingAlerts, type ScheduledAlert } from './calendar-alert-scheduler';
import type { CalendarReminderTarget } from '../navigation/pending-calendar-open';

// Local reminders for calendar events and tasks. The webmail polls
// `getPendingAlerts` every minute while a tab is open; a phone is mostly
// asleep, so instead we schedule OS-level local notifications for the alerts
// that fall due in the next few days and cancel the ones that no longer
// apply. The events come from their own upcoming window, not from the month
// the calendar happens to show, and the sync runs from launch, so reminders
// don't depend on the Calendar tab being open. Honours the
// `calendarNotificationsEnabled` setting.

const CHANNEL_ID = 'calendar-reminders';
const DAY_MS = 24 * 60 * 60 * 1000;
const HORIZON_MS = 7 * DAY_MS;
// The events loaded for the horizon: from a day back (an end-relative alert
// of an event that already started) to a week past it (alerts set up to a
// week before the start).
const LOOKBEHIND_MS = DAY_MS;
const LOOKAHEAD_MS = 7 * DAY_MS;
// iOS keeps at most 64 pending local notifications per app; leave room for
// the rest of the app.
const MAX_SCHEDULED = 48;
const DATA_TAG = 'bulwark-calendar-alert';

let permissionGranted = false;
let permissionRequested = false;
// Only the Calendar tab asks for notification permission; the launch-time
// sync uses what was granted and never prompts out of the blue.
let mayAskPermission = false;
// The language the Android channel was last named in; null until created.
let channelLocale: string | null = null;
let rescheduleTimer: ReturnType<typeof setTimeout> | null = null;
let rescheduling: Promise<void> | null = null;
let queued = false;
let syncStarted = false;
let tasksLoadedFor: string | null = null;

function isGranted(status: Notifications.NotificationPermissionsStatus): boolean {
  return status.granted || status.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
}

async function ensurePermission(): Promise<boolean> {
  if (permissionGranted) return true;
  try {
    const current = await Notifications.getPermissionsAsync();
    let granted = isGranted(current);
    if (!granted && current.canAskAgain && mayAskPermission && !permissionRequested) {
      permissionRequested = true;
      granted = isGranted(await Notifications.requestPermissionsAsync());
    }
    permissionGranted = granted;
  } catch {
    return false;
  }
  return permissionGranted;
}

// The channel's name shows in the system notification settings, so it is
// (re)named in the app language; setting an existing channel only renames it.
async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  const { locale, t } = useLocaleStore.getState();
  if (channelLocale === locale) return;
  try {
    await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
      name: t('calendar.notifications.channel_name', 'Calendar reminders'),
      importance: Notifications.AndroidImportance.HIGH,
      sound: 'default',
      vibrationPattern: [0, 250, 250, 250],
    });
  } catch {
    // Channel creation failing only degrades to the default channel.
  }
  channelLocale = locale;
}

function alertKeyOf(request: Notifications.NotificationRequest): string | null {
  const data = request.content.data as { tag?: string; key?: string } | undefined;
  return data?.tag === DATA_TAG && typeof data.key === 'string' ? data.key : null;
}

// A reminder worded in another language than the app's now. Ones scheduled
// before reminders recorded their language count as current.
function isStaleLanguage(request: Notifications.NotificationRequest, locale: string): boolean {
  const data = request.content.data as { locale?: unknown } | undefined;
  return typeof data?.locale === 'string' && data.locale !== locale;
}

/** Cancel every calendar reminder this app scheduled. */
export async function cancelAllCalendarNotifications(): Promise<void> {
  try {
    const pending = await Notifications.getAllScheduledNotificationsAsync();
    await Promise.all(
      pending
        .filter((r) => alertKeyOf(r) !== null)
        .map((r) => Notifications.cancelScheduledNotificationAsync(r.identifier)),
    );
  } catch {
    // Nothing to do; the OS keeps whatever it has.
  }
}

async function scheduleOne(alert: ScheduledAlert, locale: string): Promise<void> {
  const data: Record<string, unknown> = {
    tag: DATA_TAG,
    key: alert.key,
    // The language the title and body are in, to reword it on a switch.
    locale,
    eventId: alert.eventId,
    kind: alert.kind,
    // Enough to find the event again when the reminder is tapped.
    serverId: alert.serverId,
    accountId: alert.accountId,
    recurrenceId: alert.recurrenceId,
    startMs: alert.startMs,
    appAccountId: useAuthStore.getState().activeAccountId ?? undefined,
  };
  for (const k of Object.keys(data)) if (data[k] === undefined) delete data[k];
  await Notifications.scheduleNotificationAsync({
    content: {
      title: alert.title,
      body: alert.body,
      sound: 'default',
      data,
    },
    trigger: {
      type: Notifications.SchedulableTriggerInputTypes.DATE,
      date: new Date(alert.fireTimeMs),
      ...(Platform.OS === 'android' ? { channelId: CHANNEL_ID } : {}),
    },
  });
}

function isSignedOut(): boolean {
  const { hasRestoredSession, isAuthenticated } = useAuthStore.getState();
  return hasRestoredSession && !isAuthenticated;
}

/**
 * The events whose alerts can fire within the horizon, straight from the
 * server. `null` when that can't be known (offline, no session yet, the
 * request failed): the caller then leaves the scheduled reminders alone
 * instead of cancelling what it can't re-derive.
 */
async function loadUpcomingEvents(now: number): Promise<CalendarEvent[] | null> {
  if (!jmapClient.isConnected) return null;
  if (!hasCalendarCapability()) return [];
  if (useCalendarStore.getState().calendars.length === 0) {
    await useCalendarStore.getState().fetchCalendars();
  }
  const { calendars } = useCalendarStore.getState();
  if (calendars.length === 0) return null;
  try {
    return await loadEventsInRange(
      calendars,
      calendars.map((c) => c.id),
      new Date(now - LOOKBEHIND_MS).toISOString(),
      new Date(now + HORIZON_MS + LOOKAHEAD_MS).toISOString(),
    );
  } catch {
    return null;
  }
}

// Task reminders read the store's tasks, which the Calendar tab loads. When
// it hasn't, and tasks are switched on, scan them once per account.
async function ensureTasksLoaded(): Promise<void> {
  let accountId: string;
  try {
    accountId = jmapClient.accountId;
  } catch {
    return;
  }
  if (tasksLoadedFor === accountId) return;
  tasksLoadedFor = accountId;
  const { tasks, taskOnlyCalendarIds, fetchTasks } = useCalendarStore.getState();
  if (tasks.length > 0 || taskOnlyCalendarIds.length > 0) return;
  if (!useSettingsStore.getState().enableCalendarTasks) return;
  await fetchTasks();
}

/**
 * Derive the reminders from the upcoming window and reconcile them with
 * what the OS has pending: cancel the reminders this code scheduled that are
 * no longer wanted (event deleted or moved, reminder removed, task
 * completed) and add the new ones. Concurrent calls coalesce.
 */
export async function rescheduleCalendarNotifications(): Promise<void> {
  if (rescheduling) {
    queued = true;
    return rescheduling;
  }
  rescheduling = (async () => {
    try {
      const settings = useSettingsStore.getState();
      // Until the settings load, the switch holds its default, not the
      // user's choice.
      if (!settings.hydrated) return;
      if (!settings.calendarNotificationsEnabled || isSignedOut()) {
        await cancelAllCalendarNotifications();
        return;
      }
      if (!(await ensurePermission())) return;
      await ensureChannel();

      const now = Date.now();
      const events = await loadUpcomingEvents(now);
      if (!events) return;
      await ensureTasksLoaded();
      const { tasks, calendars } = useCalendarStore.getState();
      // Reminders fire while the app is closed, so they are worded now, in
      // the app language.
      const { locale, t } = useLocaleStore.getState();
      const wanted = getUpcomingAlerts(events, tasks, calendars, {
        now,
        horizonMs: HORIZON_MS,
        limit: MAX_SCHEDULED,
      }, t);
      const wantedByKey = new Map(wanted.map((a) => [a.key, a]));

      const pending = await Notifications.getAllScheduledNotificationsAsync();
      const present = new Set<string>();
      for (const request of pending) {
        const key = alertKeyOf(request);
        if (key === null) continue;
        if (wantedByKey.has(key) && !isStaleLanguage(request, locale)) {
          present.add(key);
        } else {
          await Notifications.cancelScheduledNotificationAsync(request.identifier);
        }
      }
      for (const alert of wanted) {
        if (present.has(alert.key)) continue;
        try {
          await scheduleOne(alert, locale);
        } catch {
          // A single bad trigger must not block the rest.
        }
      }
    } catch {
      // Notifications are best-effort.
    } finally {
      rescheduling = null;
      if (queued) {
        queued = false;
        void rescheduleCalendarNotifications();
      }
    }
  })();
  return rescheduling;
}

function scheduleSoon(): void {
  if (rescheduleTimer) clearTimeout(rescheduleTimer);
  // Debounce: a refresh sets events and tasks in two steps, and a push
  // reaches both the store and the state-change bus.
  rescheduleTimer = setTimeout(() => {
    rescheduleTimer = null;
    void rescheduleCalendarNotifications();
  }, 1500);
}

// expo-notifications drops a notification that fires while the app is in
// the foreground unless a handler asks for it. Only calendar reminders go
// through expo-notifications (mail push is posted by the native messaging
// services), so show those and leave anything else as it was.
function installForegroundHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async (notification) => {
      const show = alertKeyOf(notification.request) !== null;
      return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
    },
  });
}

/** The event or task a calendar reminder notification points at; null for anything else. */
export function reminderTargetOf(request: Notifications.NotificationRequest): CalendarReminderTarget | null {
  if (alertKeyOf(request) === null) return null;
  const data = request.content.data as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  const eventId = str(data.eventId);
  if (!eventId) return null;
  return {
    kind: data.kind === 'task' ? 'task' : 'event',
    eventId,
    serverId: str(data.serverId),
    accountId: str(data.accountId),
    recurrenceId: str(data.recurrenceId),
    startMs: typeof data.startMs === 'number' && Number.isFinite(data.startMs) ? data.startMs : undefined,
    appAccountId: str(data.appAccountId),
  };
}

// Responses already acted on: the cold-start response is reported both by
// getLastNotificationResponseAsync and, on some platforms, the listener.
const handledResponses = new Set<string>();

/**
 * Call `open` when the user taps a calendar reminder: the one that launched
 * the app and any tapped while it runs. Only reminders scheduled here are
 * handled; mail push is posted by the native messaging services and its taps
 * arrive through the native tap store (push-notifications), never here.
 * Returns the unsubscribe.
 */
export function startCalendarReminderTapHandling(
  open: (target: CalendarReminderTarget) => void,
): () => void {
  let active = true;
  const handle = (response: Notifications.NotificationResponse | null) => {
    if (!active || !response) return;
    if (response.actionIdentifier !== Notifications.DEFAULT_ACTION_IDENTIFIER) return;
    const { request } = response.notification;
    const target = reminderTargetOf(request);
    if (!target || handledResponses.has(request.identifier)) return;
    handledResponses.add(request.identifier);
    // Don't reopen it on the next sign-in or app start.
    void Promise.resolve()
      .then(() => Notifications.clearLastNotificationResponseAsync())
      .catch(() => undefined);
    open(target);
  };
  void Notifications.getLastNotificationResponseAsync().then(handle, () => undefined);
  const subscription = Notifications.addNotificationResponseReceivedListener(handle);
  return () => {
    active = false;
    subscription.remove();
  };
}

/**
 * Keep local reminders in sync for the rest of the session: at launch,
 * sign-in and account switch, when calendar data changes on the server or
 * in the app, when the app comes back to the foreground, and when the
 * setting flips. Idempotent. `askPermission` lets the sync ask for
 * notification permission; the Calendar tab passes it.
 */
export function startCalendarNotificationSync(options?: { askPermission?: boolean }): void {
  if (options?.askPermission && !mayAskPermission) {
    mayAskPermission = true;
    if (syncStarted) scheduleSoon();
  }
  if (syncStarted) return;
  syncStarted = true;
  installForegroundHandler();
  // Edits in the app, a refresh after a push, tasks loading. Moving the
  // calendar to another window changes no reminder.
  useCalendarStore.subscribe((state, prev) => {
    const sameWindow =
      state.loadedRange?.after === prev.loadedRange?.after &&
      state.loadedRange?.before === prev.loadedRange?.before;
    if (state.tasks !== prev.tasks || (state.events !== prev.events && sameWindow)) {
      scheduleSoon();
    }
  });
  useSettingsStore.subscribe((state, prev) => {
    if (
      state.calendarNotificationsEnabled !== prev.calendarNotificationsEnabled ||
      state.hydrated !== prev.hydrated
    ) {
      scheduleSoon();
    }
  });
  useAuthStore.subscribe((state, prev) => {
    if (state.session !== prev.session || state.isAuthenticated !== prev.isAuthenticated) {
      scheduleSoon();
    }
  });
  // Reword the pending reminders and rename the channel in the new language.
  useLocaleStore.subscribe((state, prev) => {
    if (state.locale !== prev.locale) scheduleSoon();
  });
  onStateChangeType('CalendarEvent', scheduleSoon);
  onStateChangeType('Calendar', scheduleSoon);
  AppState.addEventListener('change', (state) => {
    if (state === 'active') scheduleSoon();
  });
  scheduleSoon();
}
