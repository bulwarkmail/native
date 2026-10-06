import { jmapClient } from '../api/jmap-client';
import { opScope, type OpScope } from '../api/op-scope';
import type { Calendar, CalendarEvent } from '../api/types';
import { loadEventsInRange, useCalendarStore, type LoadPin } from '../stores/calendar-store';
import { isShownAccount } from '../stores/email-store';
import { clientServesAccount, clientServesRegistryAccount } from '../lib/active-client-account';
import { uiStarted } from './ui-presence';

// The widgets' calendar and tasks, loaded for the account a refresh is for
// (the registry's active one). Ids repeat across accounts (Stalwart numbers
// them per account), so the store's cached calendars or tasks, which may be
// another account's, are never handed out in their place: when the load
// can't run or fails, null, and the widget keeps what it had (already
// blanked on an account change). Required lazily by the widget code, like
// the store itself.

interface WidgetLoad {
  /** With the app closed, the store's loads are pinned to the account. */
  pin?: LoadPin;
  scope: OpScope;
}

/**
 * How to load `accountId` now, or null when it can't be. With the app's UI
 * running the store belongs to its screens: only the account they show, on
 * the connection serving it. Without it nothing is shown (or the mail cache
 * names a stale account), so the loads are pinned to `accountId`.
 */
function beginWidgetLoad(accountId: string): WidgetLoad | null {
  if (!jmapClient.isConnected) return null;
  if (uiStarted()) {
    if (!isShownAccount(accountId) || !clientServesAccount(accountId)) return null;
    return { scope: opScope() };
  }
  if (!clientServesRegistryAccount(accountId)) return null;
  const scope = opScope();
  return { pin: { appAccountId: accountId, scope }, scope };
}

/** Whether what the store holds now is still `accountId`'s, from the load's connection. */
function stillFor(load: WidgetLoad, accountId: string): boolean {
  if (jmapClient.connectionGen !== load.scope.gen) return false;
  return load.pin
    ? clientServesRegistryAccount(accountId)
    : isShownAccount(accountId) && clientServesAccount(accountId);
}

/** `accountId`'s calendars and the events of its visible calendars in [after, before]; null when not loaded. */
export async function loadWidgetCalendar(
  accountId: string,
  after: string,
  before: string,
): Promise<{ calendars: Calendar[]; hiddenCalendarIds: string[]; events: CalendarEvent[] } | null> {
  const load = beginWidgetLoad(accountId);
  if (!load) return null;
  // Always refetch: the persisted list can predate a calendar deleted and
  // re-created on the server under the same id, or be another account's.
  if (!(await useCalendarStore.getState().fetchCalendars(load.pin))) return null;
  if (!stillFor(load, accountId)) return null;
  const { calendars, hiddenCalendarIds } = useCalendarStore.getState();
  const visible = calendars.filter((c) => !hiddenCalendarIds.includes(c.id));
  const events = visible.length === 0
    ? []
    : await loadEventsInRange(calendars, visible.map((c) => c.id), after, before, load.scope);
  if (!stillFor(load, accountId)) return null;
  return { calendars, hiddenCalendarIds, events };
}

/**
 * `accountId`'s tasks and calendars; null when not loaded. `reload`: rescan
 * even when the app's screens already hold the tasks.
 */
export async function loadWidgetTasks(
  accountId: string,
  reload: boolean,
): Promise<{ tasks: CalendarEvent[]; calendars: Calendar[] } | null> {
  const load = beginWidgetLoad(accountId);
  if (!load) return null;
  const held = useCalendarStore.getState();
  // The app's screens loaded the shown account's tasks already.
  const fresh = !load.pin && !reload && held.tasks.length > 0;
  if (!fresh) {
    // The calendars route the scan and name the tasks' lists.
    if (!(await useCalendarStore.getState().fetchCalendars(load.pin))) return null;
    if (!(await useCalendarStore.getState().fetchTasks(load.pin))) return null;
  }
  if (!stillFor(load, accountId)) return null;
  const { tasks, calendars } = useCalendarStore.getState();
  return { tasks, calendars };
}

/** Reload the tasks after a widget tick, for the account the tick was for. */
export async function reloadWidgetTasks(accountId: string): Promise<void> {
  const load = beginWidgetLoad(accountId);
  if (!load) return;
  await useCalendarStore.getState().fetchTasks(load.pin);
}
