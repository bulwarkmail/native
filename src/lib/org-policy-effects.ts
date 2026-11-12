import { useAccountStore } from '../stores/account-store';
import { useOfflineCacheStore } from '../stores/offline-cache-store';
import { usePolicyStore } from '../stores/policy-store';
import { devicesForAccount } from './device-policy';

// What the organisation policy does by itself, beyond the settings rules
// the policy store applies. Loading lib/device-policy.ts sets the device
// rules the download guards and the offline sync read. Started once, from
// startPolicySync.

/**
 * An account whose organisation forbids offline mail keeps none: what it
 * kept before goes (webmail: noOffline wipes the local store).
 */
export function dropForbiddenOfflineMail(): void {
  for (const { id } of useAccountStore.getState().accounts) {
    if (devicesForAccount(id).noOffline) void useOfflineCacheStore.getState().clearAccount(id);
  }
}

let started = false;

/** Start following the policy; returns the stop. */
export function startOrgPolicyEffects(): () => void {
  if (started) return () => undefined;
  started = true;
  const stops: Array<() => void> = [];

  const onPolicy = () => dropForbiddenOfflineMail();
  stops.push(usePolicyStore.subscribe((state, prev) => {
    if (state.byAccount !== prev.byAccount || state.effective !== prev.effective) onPolicy();
  }));
  onPolicy();

  return () => {
    for (const stop of stops.splice(0)) stop();
    started = false;
  };
}
