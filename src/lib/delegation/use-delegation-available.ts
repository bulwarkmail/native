import { useAuthStore } from '../../stores/auth-store';
import { supportsDelegation } from '../../api/delegation';
import { delegationPolicy } from './policy';
import { usePolicyStore } from '../../stores/policy-store';

/**
 * Whether Settings lists Delegates for the active account: not hidden by
 * the policy, and the server has someone to share with and something to
 * share (webmail settings-app supportsSharing). Re-read with every session.
 */
export function useDelegationAvailable(): boolean {
  // The organisation policy, re-read when it changes.
  const effective = usePolicyStore((s) => s.effective);
  return useAuthStore((s) => {
    if (!s.session) return false;
    const policy = delegationPolicy(effective);
    return !policy.hidden && supportsDelegation(policy);
  });
}
