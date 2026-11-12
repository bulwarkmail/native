import { useOfflineCacheStore, type OfflineChoice } from '../stores/offline-cache-store';
import { deviceRulesFor } from './device-rules';
import type { OrgDevices } from './org-organisation';

// What an account keeps on this device (webmail lib/offline/scope.ts), from
// three sources in this order: the organisation's device policy, the
// account's own choice, the device-wide setting. The policy only ever
// lowers: it can forbid offline mail and cap its window and total, and
// nothing below it raises a cap or turns back on what it forbids.
//
// The app keeps message bodies only, no attachments, so the policy's
// attachment caps (noOfflineAttachments, offlineMaxAttachmentMb) have
// nothing to cap here; offlineMaxTotalMb caps the account's total.

/** The device-wide settings: offline mail on, and the defaults for accounts without a choice of their own. */
export interface OfflineDefaults {
  enabled: boolean;
  days: number;
  maxMB: number;
}

export interface OfflineScope {
  enabled: boolean;
  days: number;
  maxMB: number;
  /** What the organisation decides, for the settings page ("Set by your organisation"). */
  locked: { offline: boolean; days: boolean; maxTotal: boolean };
}

/** The windows and totals a user picks from. */
export const DAY_CHOICES: readonly number[] = [1, 3, 7, 14, 30, 90];
export const MB_CHOICES: readonly number[] = [25, 50, 100, 250, 500];

type OfflineCaps = Pick<OrgDevices, 'noOffline' | 'offlineMaxDays' | 'offlineMaxTotalMb'>;

/** The smaller of a value and a cap, where 0 is none for both. */
function capped(value: number, cap: number): number {
  if (!(cap > 0)) return value;
  return value > 0 ? Math.min(value, cap) : cap;
}

export function effectiveOfflineScope(
  choice: OfflineChoice | null | undefined,
  defaults: OfflineDefaults,
  policy: OfflineCaps,
): OfflineScope {
  return {
    enabled: defaults.enabled && !policy.noOffline,
    days: capped(choice?.days ?? defaults.days, policy.offlineMaxDays),
    maxMB: capped(choice?.maxMB ?? defaults.maxMB, policy.offlineMaxTotalMb),
    locked: {
      offline: policy.noOffline,
      days: policy.offlineMaxDays > 0,
      maxTotal: policy.offlineMaxTotalMb > 0,
    },
  };
}

/** The scope of an account (local registry id) right now. */
export function offlineScopeFor(accountId: string, defaults: OfflineDefaults): OfflineScope {
  return effectiveOfflineScope(useOfflineCacheStore.getState().choices[accountId], defaults, deviceRulesFor(accountId));
}

/** The choices on offer under a cap: the ones below it, and the cap itself when it falls between them. */
export function optionsUnderCap(choices: readonly number[], cap: number): number[] {
  // A cap above every choice takes nothing away.
  if (!(cap > 0) || cap >= Math.max(...choices)) return [...choices];
  return [...choices.filter((v) => v < cap), cap];
}

/**
 * Whether a cap takes a choice away, so the setting says it is the
 * organisation's (webmail 510ae2f7a): a cap above every choice is no news.
 */
export function capTakesChoice(choices: readonly number[], cap: number): boolean {
  return optionsUnderCap(choices, cap).join() !== choices.join();
}
