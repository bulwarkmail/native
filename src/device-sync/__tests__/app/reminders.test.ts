import { describe, it, expect, vi, beforeEach } from 'vitest';

// Android's side: the device's auto-sync, the account's calendar sync and the calendar permission.
const h = vi.hoisted(() => ({ available: true, master: true, automatic: true, permitted: true }));

vi.mock('../../native', () => ({
  isDeviceSyncAvailable: () => h.available,
  getSyncSettings: vi.fn(async () => ({
    masterAutomatic: h.master,
    authorities: {
      'com.android.contacts': { syncable: 1, automatic: false, periodicSeconds: 0, active: false, pending: false },
      'com.android.calendar': { syncable: 1, automatic: h.automatic, periodicSeconds: 3600, active: false, pending: false },
    },
  })),
}));

vi.mock('../../app/permissions', () => ({
  hasSyncPermissions: vi.fn(async () => h.permitted),
}));

import { CALENDAR_AUTHORITY, CONTACTS_AUTHORITY } from '../../types';
import type { CalendarEvent } from '../../../api/types';
import { useDeviceSyncStore, waitForDeviceSyncHydration } from '../../../stores/device-sync-store';
import { onDeviceRemindersChange, remindedOnDevice } from '../../app/reminders';

const ALICE = 'alice@mail.example.org';

function event(id: string, calendarIds: Record<string, boolean>): CalendarEvent {
  return { id, calendarIds, title: id, start: '2026-09-24T12:00:00', duration: 'PT1H' } as CalendarEvent;
}

function calendarSync(extra: Record<string, unknown> = {}): void {
  useDeviceSyncStore.setState({
    accounts: {
      [ALICE]: {
        contactsSelection: {},
        calendarSelection: { 'c/work': false, 'team/shared-on': true },
        reminderOwner: 'device',
        intervalSeconds: {},
        lastRun: {},
        androidAccountName: 'alice',
        enabled: { [CALENDAR_AUTHORITY]: true },
        ...extra,
      },
    },
  });
}

/** Waits until the calendar app reminds of Alice's synced events (Android's side is read when the filter is asked for). */
async function remindedByCalendarApp(): Promise<void> {
  await vi.waitFor(() => expect(remindedOnDevice(ALICE, 'c')).not.toBeNull());
}

beforeEach(async () => {
  await waitForDeviceSyncHydration();
  Object.assign(h, { available: true, master: true, automatic: true, permitted: true });
  calendarSync();
  await remindedByCalendarApp();
});

describe('remindedOnDevice', () => {
  it("picks the events of the account's synced calendars", () => {
    const onDevice = remindedOnDevice(ALICE, 'c')!;
    // Own calendars sync unless turned off.
    expect(onDevice(event('a', { personal: true }))).toBe(true);
    expect(onDevice(event('b', { work: true }))).toBe(false);
    expect(onDevice(event('c', { work: true, personal: true }))).toBe(true);
    // Shared calendars: namespaced ids in calendarIds, raw ones in originalCalendarIds.
    expect(onDevice({
      ...event('d', { 'team:shared-on': true }),
      accountId: 'team',
      originalCalendarIds: { 'shared-on': true },
    })).toBe(true);
    expect(onDevice({
      ...event('e', { 'team:other': true }),
      accountId: 'team',
      originalCalendarIds: { other: true },
    })).toBe(false);
  });

  it('leaves everything to Bulwark when Bulwark reminds, or calendars do not sync', () => {
    calendarSync({ reminderOwner: 'bulwark' });
    expect(remindedOnDevice(ALICE, 'c')).toBeNull();
    calendarSync({ enabled: { [CONTACTS_AUTHORITY]: true } });
    expect(remindedOnDevice(ALICE, 'c')).toBeNull();
    calendarSync({ removedInAndroidSettings: true });
    expect(remindedOnDevice(ALICE, 'c')).toBeNull();
    expect(remindedOnDevice('someone@else', 'c')).toBeNull();
    expect(remindedOnDevice(null, 'c')).toBeNull();
  });

  it('counts the calendar app as the owner until the user chose', () => {
    calendarSync({ reminderOwner: null });
    expect(remindedOnDevice(ALICE, 'c')?.(event('a', { personal: true }))).toBe(true);
  });

  it('does nothing where device sync is not available', () => {
    h.available = false;
    expect(remindedOnDevice(ALICE, 'c')).toBeNull();
  });
});

describe("remindedOnDevice while the device calendar can't receive events", () => {
  it('leaves the reminders to Bulwark while calendar sync is paused in Android settings', async () => {
    h.automatic = false;
    await vi.waitFor(() => expect(remindedOnDevice(ALICE, 'c')).toBeNull());
  });

  it("leaves them to Bulwark while Android's auto-sync is off: Android then runs manual syncs only", async () => {
    h.master = false;
    await vi.waitFor(() => expect(remindedOnDevice(ALICE, 'c')).toBeNull());
  });

  it('leaves them to Bulwark while the calendar permission is revoked', async () => {
    h.permitted = false;
    await vi.waitFor(() => expect(remindedOnDevice(ALICE, 'c')).toBeNull());
  });

  it('hands them back to the calendar app once it syncs again, and tells the scheduler both times', async () => {
    const listener = vi.fn();
    const off = onDeviceRemindersChange(listener);
    h.automatic = false;
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(remindedOnDevice(ALICE, 'c')).toBeNull();

    h.automatic = true;
    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(2));
    expect(remindedOnDevice(ALICE, 'c')).not.toBeNull();
    off();
  });
});

describe('onDeviceRemindersChange', () => {
  it('fires for the owner and the calendar selection, not for sync bookkeeping', () => {
    const listener = vi.fn();
    const off = onDeviceRemindersChange(listener);
    const store = useDeviceSyncStore.getState();

    store.recordKnownState(ALICE, 'c', 'CalendarEvent', 's1');
    store.setIntervalSeconds(ALICE, CALENDAR_AUTHORITY, 900);
    expect(listener).not.toHaveBeenCalled();

    store.setReminderOwner(ALICE, 'bulwark');
    expect(listener).toHaveBeenCalledTimes(1);
    store.setReminderOwner(ALICE, 'device');
    store.setCollectionSelected(ALICE, CALENDAR_AUTHORITY, 'c/work', true);
    expect(listener).toHaveBeenCalledTimes(3);
    off();
    store.setEnabled(ALICE, CALENDAR_AUTHORITY, false);
    expect(listener).toHaveBeenCalledTimes(3);
  });
});
