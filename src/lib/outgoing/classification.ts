/**
 * The classification label stage of sending, read from the stores (webmail
 * lib/outgoing/classification.ts labelsPolicyFor, automaticLabel,
 * reopenedLabelChoice, labelSourceHeaders; lib/org/signature-state.ts
 * policyForSender). The composer runs it with the user's pick, quick reply
 * with the original's label, else the default. A required label fails
 * closed: nothing is sent without one. Automatic mail (invitations, RSVP
 * replies, read receipts, unsubscribe mails, phishing reports) carries none.
 */

import { policySubjectFor, usePolicyStore } from '../../stores/policy-store';
import { useAccountStore } from '../../stores/account-store';
import { useSettingsStore } from '../../stores/settings-store';
import { resolvePolicy, type OrgPolicy } from '../org-policy';
import {
  draftLabelChoice,
  labelMissing,
  labelsPolicyOf,
  receivedLabel,
  registerLabelHeaderNames,
  resolveLabel,
  type ClassificationLabel,
  type HeaderSource,
  type LabelsPolicy,
} from '../classification-labels';
import { externalMailPolicyOf, internalDomains, senderIsInternal } from '../external-mail';

/**
 * The active account's policy for mail from `senderEmail`: a group address
 * the account belongs to sends under that group's own scope when one names
 * it, else the account's effective policy.
 */
export function policyForSender(senderEmail?: string | null): OrgPolicy | null {
  const state = usePolicyStore.getState();
  const effective = state.effective;
  const address = senderEmail?.trim().toLowerCase();
  if (!effective || !address || !state.accountId) return effective;
  const account = useAccountStore.getState().getAccountById(state.accountId);
  const cached = state.byAccount[state.accountId];
  if (!account || !cached || cached.webmailUrl !== account.webmailUrl) return effective;
  const subject = policySubjectFor(account);
  if (!subject.groups.includes(address)) return effective;
  const named = cached.policy.scopes.some((scope) => (scope.match.groups ?? []).includes(address));
  return named ? resolvePolicy(cached.policy, { email: subject.email, groups: [address] }) : effective;
}

/** The labels that apply to mail from `senderEmail`. */
export function labelsPolicyFor(senderEmail?: string | null): LabelsPolicy {
  return labelsPolicyOf(policyForSender(senderEmail)?.organisation);
}

/** The active account's internal domains: its identities' and the admin's. */
export function activeInternalDomains(): string[] {
  const identities = useSettingsStore.getState().identities ?? [];
  const policy = externalMailPolicyOf(usePolicyStore.getState().effective?.organisation);
  return internalDomains(identities.map((i) => i.email ?? ''), policy.domains);
}

/** The original of a reply, as far as its label goes. */
export function labelOriginalOf(
  headers: HeaderSource,
  from: readonly { email?: string | null }[] | null | undefined,
): { headers: HeaderSource; senderInternal: boolean } | null {
  if (!headers) return null;
  return { headers, senderInternal: senderIsInternal(from, activeInternalDomains()) };
}

/** The label of a quick reply: the original's (when an internal sender set it), else the default. */
export function automaticLabel(
  senderEmail: string | undefined,
  original: { headers: HeaderSource; from: readonly { email?: string | null }[] | null | undefined },
): { policy: LabelsPolicy; label: ClassificationLabel | null; missing: boolean } {
  const policy = labelsPolicyFor(senderEmail);
  const label = resolveLabel(policy, undefined, labelOriginalOf(original.headers, original.from));
  return { policy, label, missing: labelMissing(policy, label) };
}

/**
 * The pick a message opened again in the composer starts with: a draft's
 * X-Bulwark-Label, else the label its headers carry (a sent message brought
 * back by Undo or "Cancel and edit" carries SIO-Label only).
 */
export function reopenedLabelChoice(headers: HeaderSource, senderEmail?: string | null): string | null | undefined {
  const marked = draftLabelChoice(headers);
  if (marked !== undefined) return marked;
  return receivedLabel(headers, labelsPolicyFor(senderEmail))?.id;
}

/** Every extra header name any scope of the active account's policy gives its labels. */
function policyLabelHeaderNames(): string[] {
  const state = usePolicyStore.getState();
  const raw = state.accountId ? state.byAccount[state.accountId]?.policy : undefined;
  const names: string[] = [];
  const add = (organisation: unknown) => {
    const name = labelsPolicyOf(organisation).extraHeader;
    if (name) names.push(name);
  };
  add(raw?.organisation);
  for (const scope of raw?.scopes ?? []) add(scope.policy.organisation);
  return names;
}

registerLabelHeaderNames(policyLabelHeaderNames);
