import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { delegationPolicy } from '../delegation/policy';
import { recoveryPolicy } from '../recovery/policy';
import { sanitizePolicy, type OrgPolicy } from '../org-policy';
import { usePolicyStore } from '../../stores/policy-store';

// Delegates and "Recover deleted items" follow the organisation policy
// (webmail components/settings/delegates/delegates-settings.tsx,
// hooks/use-deleted-items-recovery.ts, components/email/trash-recovery-link.tsx).
// Both used to answer fixed defaults whatever the admin set.

function policyWith(raw: Record<string, unknown>): OrgPolicy {
  const policy = sanitizePolicy({ features: {}, restrictions: {}, defaults: {}, ...raw });
  if (!policy) throw new Error('policy did not sanitize');
  return policy;
}

const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');

afterEach(() => {
  usePolicyStore.setState({ effective: null });
});

describe('delegationPolicy', () => {
  it('shows everything without a policy', () => {
    expect(delegationPolicy(null)).toEqual({
      hidden: false, allowedValues: null, calendarsEnabled: true, contactsEnabled: true, filesEnabled: true,
    });
  });

  it('reads the hidden page, the rights limit and the app gates', () => {
    const policy = policyWith({
      restrictions: { delegation: { hidden: true }, sharingRights: { allowedValues: ['read'] } },
      features: { calendarEnabled: false, contactsEnabled: true, filesEnabled: false },
    });
    expect(delegationPolicy(policy)).toEqual({
      hidden: true, allowedValues: ['read'], calendarsEnabled: false, contactsEnabled: true, filesEnabled: false,
    });
  });

  it("reads the active account's policy from the store by default", () => {
    usePolicyStore.setState({ effective: policyWith({ restrictions: { delegation: { hidden: true } } }) });
    expect(delegationPolicy().hidden).toBe(true);
  });
});

describe('recoveryPolicy', () => {
  it('shows everything without a policy', () => {
    expect(recoveryPolicy(null)).toEqual({ hidden: false, days: 0 });
  });

  it('reads the hidden page and the day limit, clamped as the webmail does', () => {
    expect(recoveryPolicy(policyWith({
      restrictions: { deletedItemsRecovery: { hidden: true } },
      organisation: { recovery: { days: 30 } },
    }))).toEqual({ hidden: true, days: 30 });
    expect(recoveryPolicy(policyWith({ organisation: { recovery: { days: 99999 } } })).days).toBe(3650);
    expect(recoveryPolicy(policyWith({ organisation: { recovery: { days: -4 } } })).days).toBe(0);
    expect(recoveryPolicy(policyWith({ organisation: { recovery: { days: '30' } } })).days).toBe(0);
  });

  it("reads the active account's policy from the store by default", () => {
    usePolicyStore.setState({ effective: policyWith({ organisation: { recovery: { days: 14 } } }) });
    expect(recoveryPolicy().days).toBe(14);
  });
});

describe('policy wiring', () => {
  it('re-reads the policy when it changes', () => {
    expect(read('components/email/TrashRecoveryLink.tsx')).toMatch(/const days = usePolicyStore\(\(s\) => recoveryPolicy\(s\.effective\)\.days\);/);
    expect(read('components/settings/RecoverDeletedSettings.tsx')).toMatch(/const days = usePolicyStore\(\(s\) => recoveryPolicy\(s\.effective\)\.days\);/);
    expect(read('lib/recovery/use-deleted-items-recovery.ts')).toMatch(/const off = usePolicyStore\(\(s\) => recoveryPolicy\(s\.effective\)\.hidden\);/);
    expect(read('components/settings/DelegateSettings.tsx')).toMatch(/const policy = useMemo\(\(\) => delegationPolicy\(effectivePolicy\), \[effectivePolicy\]\);/);
    expect(read('lib/delegation/use-delegation-available.ts')).toMatch(/const policy = delegationPolicy\(effective\);/);
  });
});
