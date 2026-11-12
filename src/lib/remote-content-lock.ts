// Whether the organisation keeps remote content in mail from loading at all
// (webmail hooks/use-third-party-mode.ts externalContentLockedToBlock and
// remoteContentBlockedByOrg, 84de2395f, 128f61646): no third-party traffic,
// or the External content setting locked to "block" (or limited to "block"
// as its only allowed value) in the policy of the message's account. Then
// neither a trusted sender nor a one-off "Load images" lets it through, in
// the reader, a reply's quote or a reopened draft.
//
// The policy that may lock it isn't known until the first fetch of the
// account's webmail answers: the config and the policy arrive together,
// and noThirdPartyTraffic counts as on until then, so nothing loads before.

import { noThirdPartyTraffic, policySubjectFor, usePolicyStore } from '../stores/policy-store';
import { useAccountStore } from '../stores/account-store';
import { resolvePolicy, type OrgPolicy } from './org-policy';

type PolicyView = ReturnType<typeof usePolicyStore.getState>;

/**
 * The External content setting locked to "block" by the organisation, or
 * limited to "block" as its only allowed value. A lock without a value
 * locks the organisation's default (as the settings store applies it).
 */
export function externalContentLockedToBlock(policy: Pick<OrgPolicy, 'restrictions' | 'defaults'> | null | undefined): boolean {
  if (!policy) return false;
  const restriction = policy.restrictions?.externalContentPolicy;
  const allowed = restriction?.allowedValues;
  if (Array.isArray(allowed) && allowed.length > 0 && !allowed.includes('allow') && !allowed.includes('ask')) return true;
  if (restriction?.locked !== true) return false;
  const value = Object.prototype.hasOwnProperty.call(restriction, 'value')
    ? restriction.value
    : policy.defaults?.externalContentPolicy;
  return value === 'block';
}

/**
 * The effective policy of a signed-in account (AccountEntry id): the active
 * one's as the store resolved it, another one's resolved from its cached
 * policy for its own domain and group scopes. Null without one.
 */
export function policyForAccount(state: PolicyView, accountId?: string | null): OrgPolicy | null {
  if (!accountId || accountId === state.accountId) return state.effective;
  const account = useAccountStore.getState().getAccountById(accountId);
  const cached = state.byAccount[accountId];
  if (!account?.webmailUrl || !cached || cached.webmailUrl !== account.webmailUrl) return null;
  return resolvePolicy(cached.policy, policySubjectFor(account));
}

/**
 * Whether the organisation keeps remote content from loading for the
 * account a message belongs to (the active one when left out).
 */
export function remoteContentBlockedByOrg(state: PolicyView, accountId?: string | null): boolean {
  return noThirdPartyTraffic(state) || externalContentLockedToBlock(policyForAccount(state, accountId));
}

/** remoteContentBlockedByOrg as React state. */
export function useRemoteContentBlockedByOrg(accountId?: string | null): boolean {
  return usePolicyStore((s) => remoteContentBlockedByOrg(s, accountId));
}

/**
 * The reader's gate: remote content stays blocked when the organisation
 * blocks it, whatever trust or a one-off load says; otherwise unless the
 * sender is trusted, the user loaded it once, or the setting allows it.
 */
export function readerBlocksRemoteContent(input: {
  blockedByOrg: boolean;
  trusted: boolean;
  allowOnce: boolean;
  externalContentPolicy: string;
}): boolean {
  if (input.blockedByOrg) return true;
  return !input.trusted && !input.allowOnce && input.externalContentPolicy !== 'allow';
}
