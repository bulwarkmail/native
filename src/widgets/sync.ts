// Keeps the widgets current while the app runs. The launcher only asks for an
// update every 30 minutes and pushes only announce new mail, so the app
// refreshes the snapshot itself whenever what the widgets show may have
// changed: mail or calendar data, the theme or clock settings, and when the
// app goes to the background (the most likely moment to glance at a widget).

import { AppState, Platform } from 'react-native';
import { readRegistry, refreshSnapshot } from './build';
import { hasPlacedWidgets, updateAllWidgets } from './render';
import { emptySnapshot, saveSnapshot } from './snapshot';

/** Refreshes are spaced at least this far apart unless the app is leaving. */
const MIN_INTERVAL_MS = 45_000;

let timer: ReturnType<typeof setTimeout> | null = null;
let lastRun = 0;

async function run(): Promise<void> {
  timer = null;
  lastRun = Date.now();
  try {
    if (!(await hasPlacedWidgets())) return;
    await updateAllWidgets(await refreshSnapshot());
  } catch (err) {
    console.warn('[widgets] sync failed', err);
  }
}

function schedule(delayMs: number, urgent = false): void {
  const earliest = urgent ? 0 : Math.max(0, lastRun + MIN_INTERVAL_MS - Date.now());
  const wait = Math.max(delayMs, earliest);
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void run(); }, wait);
}

/** Start following app state; returns the cleanup. No-op off Android. */
export function startWidgetSync(): () => void {
  if (Platform.OS !== 'android') return () => {};
  const { useEmailStore } = require('../stores/email-store') as typeof import('../stores/email-store');
  const { useCalendarStore } = require('../stores/calendar-store') as typeof import('../stores/calendar-store');
  const { useSettingsStore } = require('../stores/settings-store') as typeof import('../stores/settings-store');

  schedule(3000, true);
  const unsubscribers = [
    useEmailStore.subscribe((state, prev) => {
      if (state.mailboxes !== prev.mailboxes || state.emails !== prev.emails) schedule(5000);
    }),
    useCalendarStore.subscribe((state, prev) => {
      if (state.events !== prev.events || state.tasks !== prev.tasks || state.calendars !== prev.calendars) schedule(8000);
    }),
    useSettingsStore.subscribe((state, prev) => {
      if (
        state.theme !== prev.theme
        || state.timeFormat !== prev.timeFormat
        || state.calendarFirstDayOfWeek !== prev.calendarFirstDayOfWeek
        || state.enableCalendarTasks !== prev.enableCalendarTasks
      ) {
        schedule(500, true);
      }
    }),
  ];
  const appState = AppState.addEventListener('change', (next) => {
    if (next === 'background') schedule(0, true);
  });
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
    appState.remove();
    if (timer) clearTimeout(timer);
    timer = null;
  };
}

/** Wipe what the widgets show after the last account signed out. */
export async function signOutWidgets(): Promise<void> {
  if (Platform.OS !== 'android') return;
  // Signed out of every account, not merely offline or mid-switch.
  if ((await readRegistry()).accounts.length > 0) return;
  const snapshot = { ...emptySnapshot(), generatedAt: Date.now() };
  await saveSnapshot(snapshot);
  await updateAllWidgets(snapshot);
}

/**
 * Called from the push headless task: new mail arrived while the app was in
 * the background. Skipped entirely when no widget is placed.
 */
export async function refreshWidgetsInBackground(): Promise<void> {
  if (Platform.OS !== 'android') return;
  try {
    if (!(await hasPlacedWidgets(0))) return;
    await updateAllWidgets(await refreshSnapshot());
  } catch (err) {
    console.warn('[widgets] background refresh failed', err);
  }
}
