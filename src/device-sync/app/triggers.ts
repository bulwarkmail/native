/**
 * What makes the running app ask Android for device syncs
 * (docs/device-sync.md, "Triggers"), started once from the app's launch
 * effect:
 *
 * - StateChanges on the live stream for `AddressBook`/`ContactCard` and
 *   `Calendar`/`CalendarEvent` (the stream serves the active account), except
 *   the states the engine synced itself;
 * - the app returning to the foreground, and the launch itself: every account
 *   with sync on, after the accounts were reconciled with Android's;
 * - accounts of our type changing (removed in Android Settings);
 * - the preferences changing: the native push router's routes follow them.
 *
 * The app's own contact and calendar edits call `requestDeviceSync` from the
 * stores. Every request is coalesced per account and authority (./request).
 */
import { AppState, type AppStateStatus } from 'react-native';
import { onAccountsChanged } from '../native';
import { AUTHORITIES, type Authority } from '../types';
import { onStateChangeType } from '../../lib/state-change-bus';
import { useAccountStore } from '../../stores/account-store';
import {
  feedingJmapAccounts,
  isKnownState,
  syncOnInApp,
  useDeviceSyncStore,
} from '../../stores/device-sync-store';
import { deviceSyncAvailable } from './available';
import { reconcileDeviceAccounts, refreshPushRoutes } from './lifecycle';
import { STATE_TYPES_BY_AUTHORITY } from './prefs';
import { requestDeviceSync } from './request';

/** Foreground syncs of one account and authority at most this often. */
export const FOREGROUND_MIN_INTERVAL_MS = 60_000;
const ROUTES_DELAY_MS = 1000;

let stopTriggers: (() => void) | null = null;
const lastForegroundRequest = new Map<string, number>();

/** A StateChange of the active account's stream. */
export function handleStateChange(authority: Authority, type: string, jmapAccountId: string, state: string): void {
  const registryId = useAccountStore.getState().activeAccountId;
  if (!registryId) return;
  const entry = useDeviceSyncStore.getState().accounts[registryId];
  if (!entry || !syncOnInApp(entry, authority)) return;
  // The engine's own upload echoing back.
  if (isKnownState(registryId, jmapAccountId, type, state)) return;
  // A shared account nothing is synced from, once the app knows which
  // accounts feed the device.
  if (entry.primaryJmapAccounts?.[authority] && !feedingJmapAccounts(entry, authority).includes(jmapAccountId)) return;
  requestDeviceSync(authority, registryId, { jmapAccountId, type, state });
}

/** Launch and every return to the foreground. */
export async function handleForeground(now: number = Date.now()): Promise<void> {
  await reconcileDeviceAccounts();
  const { accounts } = useDeviceSyncStore.getState();
  for (const account of useAccountStore.getState().accounts) {
    for (const authority of AUTHORITIES) {
      if (!syncOnInApp(accounts[account.id], authority)) continue;
      const key = `${account.id}\n${authority}`;
      const last = lastForegroundRequest.get(key);
      if (last !== undefined && now - last < FOREGROUND_MIN_INTERVAL_MS) continue;
      lastForegroundRequest.set(key, now);
      requestDeviceSync(authority, account.id);
    }
  }
}

/** Starts the triggers; idempotent. Returns the stop function (for tests). */
export function startDeviceSyncTriggers(): () => void {
  if (stopTriggers) return stopTriggers;
  if (!deviceSyncAvailable()) return () => undefined;
  const cleanups: Array<() => void> = [];

  for (const authority of AUTHORITIES) {
    for (const type of STATE_TYPES_BY_AUTHORITY[authority]) {
      cleanups.push(onStateChangeType(type, (jmapAccountId, state) => {
        handleStateChange(authority, type, jmapAccountId, state);
      }));
    }
  }

  let appState: AppStateStatus = AppState.currentState;
  const appStateSubscription = AppState.addEventListener('change', (next) => {
    const cameBack = next === 'active' && appState !== 'active';
    appState = next;
    if (cameBack) void handleForeground();
  });
  cleanups.push(() => appStateSubscription.remove());

  try {
    cleanups.push(onAccountsChanged(() => { void reconcileDeviceAccounts(); }));
  } catch {
    // Without the event, launch and foreground still reconcile.
  }

  let routesTimer: ReturnType<typeof setTimeout> | null = null;
  cleanups.push(useDeviceSyncStore.subscribe((state, prev) => {
    if (state.accounts === prev.accounts) return;
    if (routesTimer) clearTimeout(routesTimer);
    routesTimer = setTimeout(() => {
      routesTimer = null;
      void refreshPushRoutes();
    }, ROUTES_DELAY_MS);
  }));
  cleanups.push(() => {
    if (routesTimer) clearTimeout(routesTimer);
  });

  void handleForeground();

  stopTriggers = () => {
    for (const cleanup of cleanups) cleanup();
    stopTriggers = null;
    lastForegroundRequest.clear();
  };
  return stopTriggers;
}
