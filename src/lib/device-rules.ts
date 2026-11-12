import { NO_DEVICE_LIMITS, type OrgDevices } from './org-organisation';

// The organisation's device rules as the low-level helpers read them (the
// export helpers, the offline sync), without importing the policy and
// account stores: lib/device-policy.ts provides them once it is loaded
// (started with the policy sync). Until then, and without a policy, there
// are no limits.

type Provider = (accountId?: string | null) => OrgDevices;

let provider: Provider | null = null;

export function setDeviceRulesProvider(next: Provider | null): void {
  provider = next;
}

/** The device rules of an account (local registry id); the active one for null. */
export function deviceRulesFor(accountId?: string | null): OrgDevices {
  return provider?.(accountId) ?? NO_DEVICE_LIMITS;
}
