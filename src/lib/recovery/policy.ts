// What the organisation policy says about "Recover deleted items" (webmail
// hooks/use-deleted-items-recovery.ts, components/email/trash-recovery-link.tsx):
// the admin can hide the page (restriction `deletedItemsRecovery`) and limit
// the list to the last N days (`organisation.recovery.days`, 0 = everything
// the server keeps; webmail lib/admin/organisation-policy.ts clamps it to
// 0..3650). Read from the active account's policy (policy store); an account
// without a webmail has none: shown, no limit.

import type { OrgPolicy } from '../org-policy';
import { usePolicyStore } from '../../stores/policy-store';

export interface RecoveryPolicy {
  /** The admin hid the page: nothing is asked of the server. */
  hidden: boolean;
  /** Days of deleted mail to list; 0 = all the server keeps. */
  days: number;
}

const MAX_DAYS = 3650;

function recoveryDays(organisation: Record<string, unknown> | undefined): number {
  const recovery = organisation?.recovery;
  const days = recovery && typeof recovery === 'object' ? (recovery as Record<string, unknown>).days : undefined;
  if (typeof days !== 'number' || !Number.isFinite(days)) return 0;
  return Math.min(MAX_DAYS, Math.max(0, Math.round(days)));
}

export function recoveryPolicy(policy: OrgPolicy | null = usePolicyStore.getState().effective): RecoveryPolicy {
  return {
    hidden: policy?.restrictions.deletedItemsRecovery?.hidden === true,
    days: recoveryDays(policy?.organisation),
  };
}
