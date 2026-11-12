import React from 'react';
import { useAccountStore, type AccountEntry } from '../stores/account-store';
import { policySubjectFor, usePolicyStore, type CachedPolicy } from '../stores/policy-store';
import { DEFAULT_ORGANISATION, organisationFor, type OrganisationParts } from './org-organisation';

// The organisation settings (lib/org-organisation.ts) of one signed-in
// account: its cached policy from the webmail it signed in through, with
// its domain and group scopes. An account without a webmail, or whose
// cached policy came from another webmail, has none.

function resolve(cached: CachedPolicy | undefined, account: AccountEntry | undefined): OrganisationParts {
  if (!account?.webmailUrl || !cached || cached.webmailUrl !== account.webmailUrl) return DEFAULT_ORGANISATION;
  return organisationFor(cached.policy, policySubjectFor(account));
}

/** The organisation settings of an account (local registry id); the active one for null. */
export function organisationForAccount(accountId?: string | null): OrganisationParts {
  const policy = usePolicyStore.getState();
  const id = accountId ?? policy.accountId ?? useAccountStore.getState().activeAccountId;
  if (!id) return DEFAULT_ORGANISATION;
  return resolve(policy.byAccount[id], useAccountStore.getState().getAccountById(id));
}

/** Whether the account's cached policy is the full one (not the public part a refused token gets). */
export function hasFullPolicy(accountId: string): boolean {
  const cached = usePolicyStore.getState().byAccount[accountId];
  const account = useAccountStore.getState().getAccountById(accountId);
  return !!cached && !!account?.webmailUrl && cached.webmailUrl === account.webmailUrl && !cached.partial;
}

/** {@link organisationForAccount} as a hook. */
export function useAccountOrganisation(accountId?: string | null): OrganisationParts {
  const activeId = usePolicyStore((s) => s.accountId);
  const id = accountId ?? activeId;
  const cached = usePolicyStore((s) => (id ? s.byAccount[id] : undefined));
  // Activating again follows a new session (its group accounts).
  const effective = usePolicyStore((s) => s.effective);
  const account = useAccountStore((s) => (id ? s.accounts.find((a) => a.id === id) : undefined));
  return React.useMemo(() => resolve(cached, account), [cached, account, effective]);
}
