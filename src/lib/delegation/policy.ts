// What the organisation policy says about Delegates (webmail
// components/settings/delegates/delegates-settings.tsx): the admin can hide
// the page (restriction `delegation`), limit the rights offered
// (`sharingRights.allowedValues`, read and/or write) and switch calendars,
// contacts or files off (`calendarEnabled`, `contactsEnabled`,
// `filesEnabled`). Read from the active account's policy (policy store); an
// account without a webmail has none: shown, every right, every app.

import { isFeatureEnabled, type OrgPolicy } from '../org-policy';
import { usePolicyStore } from '../../stores/policy-store';

export interface DelegationPolicy {
  /** The admin hid the page. */
  hidden: boolean;
  /** `sharingRights.allowedValues`; null = no limit. */
  allowedValues: unknown[] | null;
  calendarsEnabled: boolean;
  contactsEnabled: boolean;
  filesEnabled: boolean;
}

export function delegationPolicy(policy: OrgPolicy | null = usePolicyStore.getState().effective): DelegationPolicy {
  const allowed = policy?.restrictions.sharingRights?.allowedValues;
  return {
    hidden: policy?.restrictions.delegation?.hidden === true,
    allowedValues: Array.isArray(allowed) ? allowed : null,
    calendarsEnabled: isFeatureEnabled(policy, 'calendarEnabled'),
    contactsEnabled: isFeatureEnabled(policy, 'contactsEnabled'),
    filesEnabled: isFeatureEnabled(policy, 'filesEnabled'),
  };
}
