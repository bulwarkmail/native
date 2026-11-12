import { useAccountStore } from '../stores/account-store';
import { policySubjectFor, usePolicyStore } from '../stores/policy-store';
import { resolvePolicy, type OrgPolicy } from './org-policy';

/**
 * The policy that decides the organisation signature and disclaimer of
 * mail sent from `email` (webmail lib/org/signature-state.ts
 * policyForSender). An identity of a group the account is a member of gets
 * the group's scopes when a group scope names that group; everything else
 * (personal identities, an alias in another domain) gets the account's
 * effective policy, which is `effective` here.
 */
export function policyForSender(effective: OrgPolicy | null, email: string | null | undefined): OrgPolicy | null {
  const state = usePolicyStore.getState();
  const address = email?.trim().toLowerCase();
  if (!effective || !address || !state.accountId) return effective;
  const account = useAccountStore.getState().getAccountById(state.accountId);
  const cached = state.byAccount[state.accountId];
  if (!account?.webmailUrl || !cached || cached.webmailUrl !== account.webmailUrl) return effective;
  const subject = policySubjectFor(account);
  if (!subject.groups.includes(address)) return effective;
  const named = cached.policy.scopes.some((scope) => (scope.match.groups ?? []).includes(address));
  if (!named) return effective;
  return resolvePolicy(cached.policy, { email: subject.email, groups: [address] });
}
