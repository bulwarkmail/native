/**
 * Who reminds the user of synced events (docs/device-sync.md, "Reminder
 * owner"). When an account's calendars sync to the device and the calendar
 * app owns the reminders, the device fires them from its Reminders rows, so
 * Bulwark's own scheduler skips the events of those calendars. Tasks are not
 * synced and keep Bulwark's reminders.
 *
 * Only while the device calendar receives the server's events, as Android
 * last said: not while the account's calendar sync is paused in Android's
 * settings, the device's auto-sync is off (Android then runs manual syncs
 * only, and the periodic, pushed and app-triggered ones are not manual), or
 * the calendar permission is revoked. Bulwark reminds then, and until
 * Android's side was read: a double reminder is better than a missed one.
 */
import type { CalendarEvent } from '../../api/types';
import { getSyncSettings } from '../native';
import {
  isCollectionSelected,
  selectionFor,
  syncOnInApp,
  useDeviceSyncStore,
  waitForDeviceSyncHydration,
  type AccountDeviceSync,
} from '../../stores/device-sync-store';
import { collectionKey } from '../common/ids';
import { CALENDAR_AUTHORITY } from '../types';
import { deviceSyncAvailable } from './available';
import { hasSyncPermissions } from './permissions';

/** Whether the device's calendar app fires the reminders of an account's synced events. */
function deviceOwnsReminders(entry: AccountDeviceSync | undefined): entry is AccountDeviceSync {
  // Unasked means the calendar app, as the engine writes Reminders rows then.
  return !!entry && syncOnInApp(entry, CALENDAR_AUTHORITY) && (entry.reminderOwner ?? 'device') === 'device';
}

// ─── What Android says ─────────────────────────────────

/** App accounts whose device calendar receives the server's events, as last read from Android. */
let receiving = new Set<string>();
const androidListeners = new Set<() => void>();
let reads = 0;

async function calendarReceives(accountName: string | undefined): Promise<boolean> {
  if (!accountName) return false;
  try {
    const settings = await getSyncSettings(accountName);
    return settings.masterAutomatic !== false && !!settings.authorities?.[CALENDAR_AUTHORITY]?.automatic;
  } catch {
    return false;
  }
}

/**
 * Reads from Android whose device calendars receive the server's events;
 * a change calls the `onDeviceRemindersChange` listeners. Only the latest
 * read lands.
 */
async function readAndroid(): Promise<void> {
  const read = ++reads;
  await waitForDeviceSyncHydration();
  const owners = Object.entries(useDeviceSyncStore.getState().accounts).filter(([, entry]) => deviceOwnsReminders(entry));
  const next = new Set<string>();
  if (owners.length > 0 && (await hasSyncPermissions(CALENDAR_AUTHORITY))) {
    for (const [registryId, entry] of owners) {
      if (await calendarReceives(entry.androidAccountName)) next.add(registryId);
    }
  }
  if (read !== reads) return;
  if (next.size === receiving.size && [...next].every((id) => receiving.has(id))) return;
  receiving = next;
  for (const listener of [...androidListeners]) listener();
}

// ─── The filter ────────────────────────────────────────

/**
 * A test for the events whose reminders the device's calendar app fires for
 * this app account, so Bulwark schedules none; null when there are none.
 * `primaryJmapAccountId`: the JMAP account the app's calendar store loads
 * events from when they carry no `accountId` (the user's own). Android's side
 * is read again each time, for the next time: a change calls the
 * `onDeviceRemindersChange` listeners.
 */
export function remindedOnDevice(
  registryId: string | null | undefined,
  primaryJmapAccountId: string | null | undefined,
): ((event: CalendarEvent) => boolean) | null {
  if (!registryId || !deviceSyncAvailable()) return null;
  const entry = useDeviceSyncStore.getState().accounts[registryId];
  if (!deviceOwnsReminders(entry)) return null;
  void readAndroid();
  if (!receiving.has(registryId)) return null;
  const selection = selectionFor(entry, CALENDAR_AUTHORITY);
  const personal = entry.primaryJmapAccounts?.[CALENDAR_AUTHORITY] ?? primaryJmapAccountId ?? null;
  return (event) => {
    // Events of shared calendars carry their account and a namespaced copy
    // of calendarIds; the raw ids are in originalCalendarIds.
    const jmapAccountId = event.accountId ?? primaryJmapAccountId;
    if (!jmapAccountId) return false;
    const calendarIds = event.originalCalendarIds ?? event.calendarIds ?? {};
    return Object.entries(calendarIds).some(([calendarId, member]) =>
      !!member && isCollectionSelected(selection, CALENDAR_AUTHORITY, {
        key: collectionKey(jmapAccountId, calendarId),
        isPersonal: jmapAccountId === personal,
      }));
  };
}

// What decides which events the device reminds of, as one comparable string.
function reminderSignature(accounts: Record<string, AccountDeviceSync>): string {
  const parts: unknown[] = [];
  for (const registryId of Object.keys(accounts).sort()) {
    const entry = accounts[registryId];
    if (!deviceOwnsReminders(entry)) continue;
    parts.push([registryId, entry.calendarSelection, entry.primaryJmapAccounts?.[CALENDAR_AUTHORITY] ?? null]);
  }
  return JSON.stringify(parts);
}

/**
 * Calls `listener` whenever the set of events the device reminds of may have
 * changed (reminder owner, calendar sync on or off, the calendar selection,
 * whether Android lets the device calendar sync). Android's side is read
 * right away, so the first reminders are scheduled with it known. Returns
 * the unsubscribe.
 */
export function onDeviceRemindersChange(listener: () => void): () => void {
  let last = reminderSignature(useDeviceSyncStore.getState().accounts);
  const unsubscribe = useDeviceSyncStore.subscribe((state) => {
    const next = reminderSignature(state.accounts);
    if (next === last) return;
    last = next;
    listener();
  });
  const android = () => listener();
  androidListeners.add(android);
  if (deviceSyncAvailable()) void readAndroid();
  return () => {
    unsubscribe();
    androidListeners.delete(android);
  };
}
