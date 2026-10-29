import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';

const h = vi.hoisted(() => ({
  available: true,
  appState: [] as Array<(state: string) => void>,
  accountsChanged: [] as Array<() => void>,
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'android', Version: 34, select: <T,>(s: { android?: T; default?: T }) => s.android ?? s.default },
  NativeModules: {},
  NativeEventEmitter: class {
    addListener() {
      return { remove: () => undefined };
    }
  },
  AppState: {
    currentState: 'active',
    addEventListener: (_type: string, listener: (state: string) => void) => {
      h.appState.push(listener);
      return { remove: () => { h.appState = h.appState.filter((l) => l !== listener); } };
    },
  },
}));

vi.mock('../../native', () => ({
  isDeviceSyncAvailable: () => h.available,
  requestSync: vi.fn(async () => undefined),
  onAccountsChanged: vi.fn((listener: () => void) => {
    h.accountsChanged.push(listener);
    return () => { h.accountsChanged = h.accountsChanged.filter((l) => l !== listener); };
  }),
}));

vi.mock('../../app/lifecycle', () => ({
  reconcileDeviceAccounts: vi.fn(async () => undefined),
  refreshPushRoutes: vi.fn(async () => undefined),
}));

import * as native from '../../native';
import * as lifecycle from '../../app/lifecycle';
import { CALENDAR_AUTHORITY, CONTACTS_AUTHORITY } from '../../types';
import { dispatchStateChange } from '../../../lib/state-change-bus';
import { useAccountStore, type AccountEntry } from '../../../stores/account-store';
import { useDeviceSyncStore, waitForDeviceSyncHydration } from '../../../stores/device-sync-store';
import { cancelDeviceSyncRequests, requestDeviceSync, TRIGGER_DELAY_MS } from '../../app/request';
import {
  FOREGROUND_MIN_INTERVAL_MS,
  handleForeground,
  handleStateChange,
  startDeviceSyncTriggers,
} from '../../app/triggers';

const ALICE = 'alice@mail.example.org';
const BOB = 'bob@mail.example.org';
const requestSync = vi.mocked(native.requestSync);

function account(id: string): AccountEntry {
  return {
    id,
    serverUrl: 'https://mail.example.org',
    username: id.split('@')[0],
    displayName: id,
    email: id,
    avatarColor: '#000',
    lastLoginAt: 0,
    isConnected: true,
    hasError: false,
    isDefault: false,
  };
}

// Alice syncs contacts and calendars; Bob only calendars.
function syncing(): void {
  useDeviceSyncStore.setState({
    accounts: {
      [ALICE]: {
        contactsSelection: {},
        calendarSelection: { 'team/cal': true },
        reminderOwner: null,
        intervalSeconds: {},
        lastRun: {},
        androidAccountName: 'alice',
        enabled: { [CONTACTS_AUTHORITY]: true, [CALENDAR_AUTHORITY]: true },
      },
      [BOB]: {
        contactsSelection: {},
        calendarSelection: {},
        reminderOwner: null,
        intervalSeconds: {},
        lastRun: {},
        androidAccountName: 'bob',
        enabled: { [CALENDAR_AUTHORITY]: true },
      },
    },
  });
}

let stop: (() => void) | null = null;

beforeEach(async () => {
  await AsyncStorage.clear();
  await waitForDeviceSyncHydration();
  vi.clearAllMocks();
  vi.useFakeTimers();
  h.available = true;
  cancelDeviceSyncRequests();
  useAccountStore.setState({ accounts: [account(ALICE), account(BOB)], activeAccountId: ALICE });
  syncing();
});

afterEach(() => {
  stop?.();
  stop = null;
  cancelDeviceSyncRequests();
  vi.useRealTimers();
});

describe('requestDeviceSync', () => {
  it('makes one sync of the edits and echoes of 5 seconds', async () => {
    requestDeviceSync(CONTACTS_AUTHORITY);
    await vi.advanceTimersByTimeAsync(2000);
    requestDeviceSync(CONTACTS_AUTHORITY, ALICE);
    requestDeviceSync(CONTACTS_AUTHORITY, ALICE, { jmapAccountId: 'c', type: 'ContactCard', state: 's2' });
    expect(requestSync).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(TRIGGER_DELAY_MS - 2000);
    expect(requestSync).toHaveBeenCalledTimes(1);
    expect(requestSync).toHaveBeenCalledWith('alice', CONTACTS_AUTHORITY, {});

    // The next change arms a new request.
    requestDeviceSync(CONTACTS_AUTHORITY);
    await vi.advanceTimersByTimeAsync(TRIGGER_DELAY_MS);
    expect(requestSync).toHaveBeenCalledTimes(2);
  });

  it('keeps accounts and authorities apart', async () => {
    requestDeviceSync(CONTACTS_AUTHORITY, ALICE);
    requestDeviceSync(CALENDAR_AUTHORITY, ALICE);
    requestDeviceSync(CALENDAR_AUTHORITY, BOB);
    await vi.advanceTimersByTimeAsync(TRIGGER_DELAY_MS);
    expect(requestSync.mock.calls.map(([name, authority]) => `${name} ${authority}`).sort()).toEqual([
      `alice ${CALENDAR_AUTHORITY}`,
      `alice ${CONTACTS_AUTHORITY}`,
      `bob ${CALENDAR_AUTHORITY}`,
    ]);
  });

  it('asks nothing for an authority the account does not sync, or without device sync', async () => {
    requestDeviceSync(CONTACTS_AUTHORITY, BOB);
    h.available = false;
    requestDeviceSync(CALENDAR_AUTHORITY, BOB);
    await vi.advanceTimersByTimeAsync(TRIGGER_DELAY_MS);
    expect(requestSync).not.toHaveBeenCalled();
  });

  it('drops a request when sync was turned off meanwhile', async () => {
    requestDeviceSync(CONTACTS_AUTHORITY, ALICE);
    useDeviceSyncStore.getState().setEnabled(ALICE, CONTACTS_AUTHORITY, false);
    await vi.advanceTimersByTimeAsync(TRIGGER_DELAY_MS);
    expect(requestSync).not.toHaveBeenCalled();
  });

  it('can be cancelled', async () => {
    requestDeviceSync(CONTACTS_AUTHORITY, ALICE);
    requestDeviceSync(CALENDAR_AUTHORITY, ALICE);
    cancelDeviceSyncRequests(ALICE, CONTACTS_AUTHORITY);
    await vi.advanceTimersByTimeAsync(TRIGGER_DELAY_MS);
    expect(requestSync).toHaveBeenCalledTimes(1);
    expect(requestSync).toHaveBeenCalledWith('alice', CALENDAR_AUTHORITY, {});
  });
});

describe('StateChanges of the live stream', () => {
  it('syncs the active account on a contact or calendar change', async () => {
    handleStateChange(CALENDAR_AUTHORITY, 'CalendarEvent', 'c', 'e7');
    await vi.advanceTimersByTimeAsync(TRIGGER_DELAY_MS);
    expect(requestSync).toHaveBeenCalledWith('alice', CALENDAR_AUTHORITY, {});
  });

  it('skips the echo of what the engine synced itself', async () => {
    useDeviceSyncStore.getState().recordKnownState(ALICE, 'c', 'ContactCard', 's9');
    handleStateChange(CONTACTS_AUTHORITY, 'ContactCard', 'c', 's9');
    await vi.advanceTimersByTimeAsync(TRIGGER_DELAY_MS);
    expect(requestSync).not.toHaveBeenCalled();
  });

  it('skips an echo that arrived before the engine recorded its state', async () => {
    handleStateChange(CONTACTS_AUTHORITY, 'ContactCard', 'c', 's10');
    // The engine's upload returns and records the state it moved the account to.
    useDeviceSyncStore.getState().recordKnownState(ALICE, 'c', 'ContactCard', 's10');
    await vi.advanceTimersByTimeAsync(TRIGGER_DELAY_MS);
    expect(requestSync).not.toHaveBeenCalled();
  });

  it('still syncs when an edit in the app joined the echo', async () => {
    handleStateChange(CONTACTS_AUTHORITY, 'ContactCard', 'c', 's11');
    requestDeviceSync(CONTACTS_AUTHORITY);
    useDeviceSyncStore.getState().recordKnownState(ALICE, 'c', 'ContactCard', 's11');
    await vi.advanceTimersByTimeAsync(TRIGGER_DELAY_MS);
    expect(requestSync).toHaveBeenCalledTimes(1);
  });

  it('ignores shared accounts nothing is synced from, once the personal account is known', async () => {
    handleStateChange(CALENDAR_AUTHORITY, 'CalendarEvent', 'other', 'x1');
    await vi.advanceTimersByTimeAsync(TRIGGER_DELAY_MS);
    // Unknown yet: anything may feed the device.
    expect(requestSync).toHaveBeenCalledTimes(1);

    useDeviceSyncStore.getState().rememberPrimaryJmapAccount(ALICE, CALENDAR_AUTHORITY, 'c');
    handleStateChange(CALENDAR_AUTHORITY, 'CalendarEvent', 'other', 'x2');
    await vi.advanceTimersByTimeAsync(TRIGGER_DELAY_MS);
    expect(requestSync).toHaveBeenCalledTimes(1);

    // The shared account a calendar was picked in does feed it.
    handleStateChange(CALENDAR_AUTHORITY, 'Calendar', 'team', 'x3');
    await vi.advanceTimersByTimeAsync(TRIGGER_DELAY_MS);
    expect(requestSync).toHaveBeenCalledTimes(2);
  });

  it('does nothing for an authority the active account does not sync', async () => {
    useAccountStore.setState({ activeAccountId: BOB });
    handleStateChange(CONTACTS_AUTHORITY, 'AddressBook', 'b', 'x');
    await vi.advanceTimersByTimeAsync(TRIGGER_DELAY_MS);
    expect(requestSync).not.toHaveBeenCalled();
  });
});

describe('foreground', () => {
  it('reconciles the accounts, then syncs everything that syncs, at most once a minute', async () => {
    await handleForeground(1_000_000);
    expect(lifecycle.reconcileDeviceAccounts).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(TRIGGER_DELAY_MS);
    expect(requestSync.mock.calls.map(([name, authority]) => `${name} ${authority}`).sort()).toEqual([
      `alice ${CALENDAR_AUTHORITY}`,
      `alice ${CONTACTS_AUTHORITY}`,
      `bob ${CALENDAR_AUTHORITY}`,
    ]);

    await handleForeground(1_000_000 + FOREGROUND_MIN_INTERVAL_MS - 1);
    await vi.advanceTimersByTimeAsync(TRIGGER_DELAY_MS);
    expect(requestSync).toHaveBeenCalledTimes(3);

    await handleForeground(1_000_000 + FOREGROUND_MIN_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(TRIGGER_DELAY_MS);
    expect(requestSync).toHaveBeenCalledTimes(6);
  });
});

describe('startDeviceSyncTriggers', () => {
  it('listens to the stream, the foreground, account changes and the preferences', async () => {
    stop = startDeviceSyncTriggers();
    // Launch counts as coming to the foreground.
    await vi.advanceTimersByTimeAsync(TRIGGER_DELAY_MS);
    expect(lifecycle.reconcileDeviceAccounts).toHaveBeenCalledTimes(1);
    requestSync.mockClear();

    dispatchStateChange({ '@type': 'StateChange', changed: { c: { AddressBook: 'a2', Email: 'm1' } } });
    await vi.advanceTimersByTimeAsync(TRIGGER_DELAY_MS);
    expect(requestSync).toHaveBeenCalledWith('alice', CONTACTS_AUTHORITY, {});

    for (const listener of h.appState) listener('background');
    for (const listener of h.appState) listener('active');
    await vi.advanceTimersByTimeAsync(0);
    expect(lifecycle.reconcileDeviceAccounts).toHaveBeenCalledTimes(2);

    for (const listener of h.accountsChanged) listener();
    expect(lifecycle.reconcileDeviceAccounts).toHaveBeenCalledTimes(3);

    useDeviceSyncStore.getState().rememberPrimaryJmapAccount(ALICE, CONTACTS_AUTHORITY, 'c');
    await vi.advanceTimersByTimeAsync(1000);
    expect(lifecycle.refreshPushRoutes).toHaveBeenCalled();

    // Started once only.
    expect(startDeviceSyncTriggers()).toBe(stop);
  });

  it('starts nothing without device sync', async () => {
    h.available = false;
    startDeviceSyncTriggers()();
    await vi.advanceTimersByTimeAsync(TRIGGER_DELAY_MS);
    expect(lifecycle.reconcileDeviceAccounts).not.toHaveBeenCalled();
    expect(native.onAccountsChanged).not.toHaveBeenCalled();
  });
});
