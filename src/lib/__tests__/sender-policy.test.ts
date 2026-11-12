import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// A group identity gets the group's organisation signature, not the
// account's (webmail lib/org/signature-state.ts policyForSender).

const { client } = vi.hoisted(() => ({
  client: {
    serverUrl: 'https://mail.example.org' as string | null,
    username: 'ada@example.org' as string | null,
    currentSession: null as unknown,
  },
}));
vi.mock('../../api/jmap-client', () => ({ jmapClient: client }));
vi.mock('../../stores/auth-store', async () => {
  const { create } = await import('zustand');
  return { useAuthStore: create(() => ({ activeAccountId: null as string | null, session: null as unknown })) };
});

import { usePolicyStore } from '../../stores/policy-store';
import { resolvePolicy } from '../org-policy';
import { orgSignatureSetup } from '../org-signature';
import { policyForSender } from '../sender-policy';
import { ADA, givenPolicy } from './org-policy-helpers';

const RAW = {
  organisation: { signature: { text: 'Example Ltd' } },
  scopes: [
    { id: 'team', match: { groups: ['team@example.org'] }, policy: { organisation: { signature: { text: 'The team desk' } } } },
  ],
};

function signatureFor(email: string): string | undefined {
  const effective = usePolicyStore.getState().effective;
  return orgSignatureSetup(policyForSender(effective, email), { name: 'Ada', email }, null, '').signature?.text;
}

beforeEach(() => {
  client.currentSession = {
    accounts: {
      a1: { name: 'ada@example.org', isPersonal: true },
      g1: { name: 'team@example.org', isPersonal: false },
      g2: { name: 'sales@example.org', isPersonal: false },
    },
  };
  givenPolicy(RAW);
  const cached = usePolicyStore.getState().byAccount[ADA].policy;
  // Ada is a member of both groups; her account's own policy (no group scope
  // names her account) is the global one, as activate resolves it.
  usePolicyStore.setState({ effective: resolvePolicy(cached, { email: 'ada@example.org', groups: [] }) });
});

describe('policyForSender', () => {
  it('gives a group identity the group scope', () => {
    expect(signatureFor('team@example.org')).toBe('The team desk');
    expect(signatureFor('Team@Example.org')).toBe('The team desk');
  });

  it("keeps the account's policy for personal identities and groups no scope names", () => {
    expect(signatureFor('ada@example.org')).toBe('Example Ltd');
    expect(signatureFor('sales@example.org')).toBe('Example Ltd');
  });

  it("keeps the account's policy for an address of a group the account isn't in", () => {
    client.currentSession = { accounts: { a1: { name: 'ada@example.org', isPersonal: true } } };
    expect(signatureFor('team@example.org')).toBe('Example Ltd');
  });

  it('is what the composer and quick reply sign with', () => {
    const compose = readFileSync(join(__dirname, '../../screens/ComposeScreen.tsx'), 'utf8');
    expect(compose).toContain('orgSignatureSetup(policyForSender(orgPolicy, primaryIdentity?.email), primaryIdentity');
    expect(compose).toContain('orgSignatureSetup(policyForSender(usePolicyStore.getState().effective, identity?.email), identity');
    const quick = readFileSync(join(__dirname, '../../components/email/QuickReplyBox.tsx'), 'utf8');
    expect(quick).toContain('orgSignatureSetup(policyForSender(policy.effective, identity?.email), identity');
  });
});
