import { describe, it, expect, beforeEach, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { CALENDAR_AUTHORITY, CONTACTS_AUTHORITY, type RunStatus } from '../../device-sync/types';
import {
  DEVICE_SYNC_STORAGE_KEY,
  deviceSyncPushTypes,
  persistedAccounts,
  syncOnInApp,
} from '../../device-sync/app/prefs';

type StoreModule = typeof import('../device-sync-store');

// A fresh store module, hydrated from whatever AsyncStorage holds now.
async function freshStore(): Promise<StoreModule> {
  vi.resetModules();
  const mod = await import('../device-sync-store');
  await mod.waitForDeviceSyncHydration();
  return mod;
}

async function stored(): Promise<Record<string, any>> {
  const raw = await AsyncStorage.getItem(DEVICE_SYNC_STORAGE_KEY);
  return raw ? JSON.parse(raw).state.accounts : {};
}

const ALICE = 'alice@mail.example.org';
const BOB = 'bob@mail.example.org';

const run = (outcome: RunStatus['outcome']): RunStatus => ({
  at: 1,
  outcome,
  durationMs: 10,
  conflicts: 0,
  itemErrors: 0,
  stats: {
    downloaded: { created: 0, updated: 0, deleted: 0 },
    uploaded: { created: 0, updated: 0, deleted: 0 },
    entries: 0,
    skipped: 0,
  },
});

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('selection', () => {
  it("syncs the personal account's collections unless turned off and shared ones only when turned on", async () => {
    const { isCollectionSelected } = await freshStore();
    expect(isCollectionSelected({}, CONTACTS_AUTHORITY, { key: 'c/b1', isPersonal: true })).toBe(true);
    expect(isCollectionSelected({}, CONTACTS_AUTHORITY, { key: 'd/b9', isPersonal: false })).toBe(false);
    expect(isCollectionSelected({ 'c/b1': false }, CONTACTS_AUTHORITY, { key: 'c/b1', isPersonal: true })).toBe(false);
    expect(isCollectionSelected({ 'd/b9': true }, CONTACTS_AUTHORITY, { key: 'd/b9', isPersonal: false })).toBe(true);
    // The webmail's allow-list book stays off unless the user picks it.
    const trusted = { key: 'c/b2', isPersonal: true, name: 'Trusted Senders' };
    expect(isCollectionSelected({}, CONTACTS_AUTHORITY, trusted)).toBe(false);
    expect(isCollectionSelected({ 'c/b2': true }, CONTACTS_AUTHORITY, trusted)).toBe(true);
    expect(isCollectionSelected({}, CALENDAR_AUTHORITY, trusted)).toBe(true);
  });

  it('lists the collections that sync, per authority, from explicit choices and the default', async () => {
    const m = await freshStore();
    const store = m.useDeviceSyncStore.getState();
    store.setCollectionSelected(ALICE, CONTACTS_AUTHORITY, 'c/b2', false);
    store.setCollectionSelected(ALICE, CONTACTS_AUTHORITY, 'd/b9', true);
    store.setCollectionSelected(ALICE, CALENDAR_AUTHORITY, 'c/cal1', false);
    const entry = m.accountDeviceSync(ALICE);
    const books = [
      { key: 'c/b1', isPersonal: true },
      { key: 'c/b2', isPersonal: true },
      { key: 'd/b9', isPersonal: false },
      { key: 'd/b8', isPersonal: false },
    ];
    expect(m.effectiveSelection(entry, CONTACTS_AUTHORITY, books)).toEqual(['c/b1', 'd/b9']);
    // The calendar choice does not leak into the contacts selection.
    expect(m.selectionFor(entry, CONTACTS_AUTHORITY)).toEqual({ 'c/b2': false, 'd/b9': true });
    expect(m.selectionFor(entry, CALENDAR_AUTHORITY)).toEqual({ 'c/cal1': false });
  });

  it('gives the engine its preferences, with the calendar app reminding until the user chose', async () => {
    const m = await freshStore();
    expect(m.accountSyncPrefs(ALICE)).toEqual({
      contactsSelection: {},
      calendarSelection: {},
      newContactsAddressBook: undefined,
      reminderOwner: 'device',
    });
    m.useDeviceSyncStore.getState().setReminderOwner(ALICE, 'bulwark');
    m.useDeviceSyncStore.getState().setNewContactsAddressBook(ALICE, 'c/b2');
    expect(m.accountSyncPrefs(ALICE)).toMatchObject({ reminderOwner: 'bulwark', newContactsAddressBook: 'c/b2' });
    m.useDeviceSyncStore.getState().setNewContactsAddressBook(ALICE, null);
    expect(m.accountSyncPrefs(ALICE).newContactsAddressBook).toBeUndefined();
  });
});

describe('actions', () => {
  it('records what the user turned on in the app, apart from removals and suspensions', async () => {
    const m = await freshStore();
    const store = m.useDeviceSyncStore.getState();
    store.setEnabled(ALICE, CONTACTS_AUTHORITY, true);
    expect(syncOnInApp(m.accountDeviceSync(ALICE), CONTACTS_AUTHORITY)).toBe(true);
    expect(syncOnInApp(m.accountDeviceSync(ALICE), CALENDAR_AUTHORITY)).toBe(false);
    store.setRemovedInAndroidSettings(ALICE, true);
    expect(syncOnInApp(m.accountDeviceSync(ALICE), CONTACTS_AUTHORITY)).toBe(false);
    store.setRemovedInAndroidSettings(ALICE, false);
    expect(m.accountDeviceSync(ALICE).removedInAndroidSettings).toBeUndefined();
    store.update(ALICE, { suspended: true });
    expect(m.anySyncOnInApp(m.accountDeviceSync(ALICE))).toBe(false);
  });

  it('keeps an interval per authority and defaults to an hour', async () => {
    const m = await freshStore();
    const store = m.useDeviceSyncStore.getState();
    expect(m.intervalFor(m.accountDeviceSync(ALICE), CONTACTS_AUTHORITY)).toBe(m.DEFAULT_INTERVAL_SECONDS);
    store.setIntervalSeconds(ALICE, CONTACTS_AUTHORITY, 900);
    store.setIntervalSeconds(ALICE, CALENDAR_AUTHORITY, 0);
    expect(m.intervalFor(m.accountDeviceSync(ALICE), CONTACTS_AUTHORITY)).toBe(900);
    expect(m.intervalFor(m.accountDeviceSync(ALICE), CALENDAR_AUTHORITY)).toBe(0);
    store.setIntervalSeconds(ALICE, CALENDAR_AUTHORITY, -5);
    expect(m.intervalFor(m.accountDeviceSync(ALICE), CALENDAR_AUTHORITY)).toBe(0);
  });

  it('records run statuses and the states the engine synced, and knows its own echo', async () => {
    const m = await freshStore();
    const store = m.useDeviceSyncStore.getState();
    store.recordRunStatus(ALICE, CONTACTS_AUTHORITY, run('ok'));
    store.recordRunStatus(ALICE, CALENDAR_AUTHORITY, run('io'));
    store.recordKnownState(ALICE, 'c', 'ContactCard', 's1');
    store.recordKnownState(ALICE, 'c', 'CalendarEvent', 'e1');
    const entry = m.accountDeviceSync(ALICE);
    expect(entry.lastRun[CONTACTS_AUTHORITY]?.outcome).toBe('ok');
    expect(entry.lastRun[CALENDAR_AUTHORITY]?.outcome).toBe('io');
    expect(m.isKnownState(ALICE, 'c', 'ContactCard', 's1')).toBe(true);
    expect(m.isKnownState(ALICE, 'c', 'ContactCard', 's2')).toBe(false);
    expect(m.isKnownState(ALICE, 'd', 'ContactCard', 's1')).toBe(false);
    expect(m.isKnownState(BOB, 'c', 'ContactCard', 's1')).toBe(false);
  });

  it('forgets an account entirely', async () => {
    const m = await freshStore();
    m.useDeviceSyncStore.getState().setEnabled(ALICE, CONTACTS_AUTHORITY, true);
    m.useDeviceSyncStore.getState().setEnabled(BOB, CONTACTS_AUTHORITY, true);
    m.useDeviceSyncStore.getState().forget(ALICE);
    expect(Object.keys(m.useDeviceSyncStore.getState().accounts)).toEqual([BOB]);
  });
});

describe('persistence', () => {
  it('writes every change at once under device-sync:v1', async () => {
    const m = await freshStore();
    m.useDeviceSyncStore.getState().setEnabled(ALICE, CALENDAR_AUTHORITY, true);
    // No write delay: the change is in AsyncStorage before any timer runs.
    await Promise.resolve();
    expect((await stored())[ALICE].enabled).toEqual({ [CALENDAR_AUTHORITY]: true });
  });

  it('reads the stored preferences back on the next start', async () => {
    let m = await freshStore();
    m.useDeviceSyncStore.getState().setCollectionSelected(ALICE, CONTACTS_AUTHORITY, 'd/b9', true);
    m.useDeviceSyncStore.getState().update(ALICE, { androidAccountName: 'alice' });
    await Promise.resolve();
    m = await freshStore();
    const entry = m.accountDeviceSync(ALICE);
    expect(entry.contactsSelection).toEqual({ 'd/b9': true });
    expect(entry.androidAccountName).toBe('alice');
  });

  it('waits for the stored state before a headless writer may set anything', async () => {
    await AsyncStorage.setItem(DEVICE_SYNC_STORAGE_KEY, JSON.stringify({
      state: { accounts: { [ALICE]: { contactsSelection: { 'c/b1': false }, calendarSelection: {}, reminderOwner: 'bulwark', intervalSeconds: {}, lastRun: {} } } },
      version: 0,
    }));
    vi.resetModules();
    const m = await import('../device-sync-store');
    await m.waitForDeviceSyncHydration();
    expect(m.useDeviceSyncStore.persist.hasHydrated()).toBe(true);
    // A run status recorded after hydration keeps the stored preferences.
    m.useDeviceSyncStore.getState().recordRunStatus(ALICE, CONTACTS_AUTHORITY, run('ok'));
    await Promise.resolve();
    const entry = (await stored())[ALICE];
    expect(entry.contactsSelection).toEqual({ 'c/b1': false });
    expect(entry.reminderOwner).toBe('bulwark');
    expect(entry.lastRun[CONTACTS_AUTHORITY].outcome).toBe('ok');
  });

  it('drops malformed entries and fields instead of failing to start', async () => {
    await AsyncStorage.setItem(DEVICE_SYNC_STORAGE_KEY, JSON.stringify({
      state: {
        accounts: {
          [ALICE]: {
            contactsSelection: 'nope',
            reminderOwner: 'someone',
            lastRun: [],
            enabled: { [CONTACTS_AUTHORITY]: true },
            knownStates: { c: { ContactCard: 's1' }, d: 'broken' },
            primaryJmapAccounts: 7,
            androidAccountName: 12,
          },
          [BOB]: 42,
        },
      },
      version: 0,
    }));
    const m = await freshStore();
    expect(Object.keys(m.useDeviceSyncStore.getState().accounts)).toEqual([ALICE]);
    const entry = m.accountDeviceSync(ALICE);
    expect(entry.contactsSelection).toEqual({});
    expect(entry.calendarSelection).toEqual({});
    expect(entry.reminderOwner).toBeNull();
    expect(entry.lastRun).toEqual({});
    expect(entry.enabled).toEqual({ [CONTACTS_AUTHORITY]: true });
    expect(entry.knownStates).toEqual({ c: { ContactCard: 's1' } });
    expect(entry.primaryJmapAccounts).toBeUndefined();
    expect(entry.androidAccountName).toBeUndefined();
    // Readers built on the entry keep working.
    expect(m.computePushRoutes(m.useDeviceSyncStore.getState().accounts)).toEqual({});
  });
});

describe('routes and push types', () => {
  it('knows which JMAP accounts feed an authority', async () => {
    const m = await freshStore();
    const store = m.useDeviceSyncStore.getState();
    store.rememberPrimaryJmapAccount(ALICE, CONTACTS_AUTHORITY, 'c');
    store.recordKnownState(ALICE, 'g', 'AddressBook', 'x');
    store.recordKnownState(ALICE, 'h', 'CalendarEvent', 'y');
    store.setCollectionSelected(ALICE, CONTACTS_AUTHORITY, 'd/b9', true);
    store.setCollectionSelected(ALICE, CONTACTS_AUTHORITY, 'e/b1', false);
    const entry = m.accountDeviceSync(ALICE);
    expect(m.feedingJmapAccounts(entry, CONTACTS_AUTHORITY)).toEqual(['c', 'd', 'g']);
    expect(m.feedingJmapAccounts(entry, CALENDAR_AUTHORITY)).toEqual(['h']);
  });

  it('routes every feeding JMAP account to the Android accounts that sync it', async () => {
    const m = await freshStore();
    const store = m.useDeviceSyncStore.getState();
    store.update(ALICE, {
      androidAccountName: 'alice',
      enabled: { [CONTACTS_AUTHORITY]: true, [CALENDAR_AUTHORITY]: true },
      primaryJmapAccounts: { [CONTACTS_AUTHORITY]: 'c', [CALENDAR_AUTHORITY]: 'c' },
    });
    store.setCollectionSelected(ALICE, CALENDAR_AUTHORITY, 'team/cal', true);
    // Bob syncs nothing yet, a removed account and a suspended one route nowhere.
    store.update(BOB, { androidAccountName: 'bob', enabled: {} });
    store.update('carol@x', { androidAccountName: 'carol', enabled: { [CONTACTS_AUTHORITY]: true }, removedInAndroidSettings: true, primaryJmapAccounts: { [CONTACTS_AUTHORITY]: 'k' } });
    store.update('dave@x', { androidAccountName: 'dave', enabled: { [CONTACTS_AUTHORITY]: true }, suspended: true, primaryJmapAccounts: { [CONTACTS_AUTHORITY]: 'k' } });
    expect(m.computePushRoutes(m.useDeviceSyncStore.getState().accounts)).toEqual({
      c: [{ accountName: 'alice', authorities: [CONTACTS_AUTHORITY, CALENDAR_AUTHORITY] }],
      team: [{ accountName: 'alice', authorities: [CALENDAR_AUTHORITY] }],
    });
  });

  it('adds the contact and calendar push types while they sync', () => {
    expect(deviceSyncPushTypes(undefined)).toEqual([]);
    expect(deviceSyncPushTypes({ enabled: { [CONTACTS_AUTHORITY]: true } })).toEqual(['ContactCard', 'AddressBook']);
    expect(deviceSyncPushTypes({ enabled: { [CONTACTS_AUTHORITY]: true, [CALENDAR_AUTHORITY]: true } }))
      .toEqual(['ContactCard', 'AddressBook', 'CalendarEvent', 'Calendar']);
    expect(deviceSyncPushTypes({ enabled: { [CALENDAR_AUTHORITY]: true }, removedInAndroidSettings: true })).toEqual([]);
  });

  it('reads the persisted accounts without the store, tolerating garbage', () => {
    expect(persistedAccounts(null)).toEqual({});
    expect(persistedAccounts('{not json')).toEqual({});
    expect(persistedAccounts(JSON.stringify({ state: { accounts: [] } }))).toEqual({});
    expect(persistedAccounts(JSON.stringify({ state: { accounts: { [ALICE]: { enabled: {} } } } })))
      .toEqual({ [ALICE]: { enabled: {} } });
  });
});
