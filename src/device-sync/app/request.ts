/**
 * Asks Android to sync one account's contacts or calendars because something
 * changed while the app runs (docs/device-sync.md, "Triggers"): a StateChange
 * on the live stream, the app's own contact or calendar edit, the app coming
 * back to the foreground.
 *
 * Requests are coalesced per account and authority: the first one arms a
 * 5-second timer and the rest ride along, so an edit and the StateChange
 * echoing it make one sync. A request caused only by StateChanges is dropped
 * when the timer fires if the engine has synced exactly those states in the
 * meantime (its own uploads echo back).
 *
 * The request is an ordinary (not manual) one: Android drops it while the
 * user has paused the account or the device's auto-sync is off.
 */
import { requestSync } from '../native';
import type { Authority } from '../types';
import { useAccountStore } from '../../stores/account-store';
import { isKnownState, syncOnInApp, useDeviceSyncStore } from '../../stores/device-sync-store';
import { deviceSyncAvailable } from './available';

export const TRIGGER_DELAY_MS = 5000;

/** The StateChange that asked for a sync. */
export interface StateReason {
  jmapAccountId: string;
  type: string;
  state: string;
}

interface Pending {
  timer: ReturnType<typeof setTimeout>;
  reasons: StateReason[];
  /** Asked for by something other than a StateChange: never skipped as an echo. */
  unconditional: boolean;
}

const pending = new Map<string, Pending>();

const slotKey = (registryId: string, authority: Authority) => `${registryId}\n${authority}`;

/**
 * Request a sync of `authority` for an app account (the active one when
 * `registryId` is omitted), coalesced for 5 seconds. A no-op unless the
 * account has device sync on for the authority.
 */
export function requestDeviceSync(authority: Authority, registryId?: string | null, reason?: StateReason): void {
  if (!deviceSyncAvailable()) return;
  const id = registryId ?? useAccountStore.getState().activeAccountId;
  if (!id) return;
  if (!syncOnInApp(useDeviceSyncStore.getState().accounts[id], authority)) return;
  const key = slotKey(id, authority);
  let slot = pending.get(key);
  if (!slot) {
    slot = {
      timer: setTimeout(() => fire(key, id, authority), TRIGGER_DELAY_MS),
      reasons: [],
      unconditional: false,
    };
    pending.set(key, slot);
  }
  if (reason) slot.reasons.push(reason);
  else slot.unconditional = true;
}

function fire(key: string, registryId: string, authority: Authority): void {
  const slot = pending.get(key);
  pending.delete(key);
  if (!slot) return;
  const entry = useDeviceSyncStore.getState().accounts[registryId];
  const accountName = entry?.androidAccountName;
  if (!accountName || !syncOnInApp(entry, authority)) return;
  const echoesOnly = !slot.unconditional
    && slot.reasons.every((r) => isKnownState(registryId, r.jmapAccountId, r.type, r.state));
  if (echoesOnly) return;
  void Promise.resolve()
    .then(() => requestSync(accountName, authority, {}))
    .catch(() => undefined);
}

/**
 * Drops waiting requests: of one authority of an account, of every authority
 * of an account, or all of them. Used before sync is turned off.
 */
export function cancelDeviceSyncRequests(registryId?: string, authority?: Authority): void {
  for (const [key, slot] of pending) {
    if (registryId && authority && key !== slotKey(registryId, authority)) continue;
    if (registryId && !key.startsWith(`${registryId}\n`)) continue;
    clearTimeout(slot.timer);
    pending.delete(key);
  }
}
