// Shared set-up for the organisation policy tests: an account signed in
// through a webmail, with a cached policy (as policy-store keeps it).
import { useAccountStore, type AccountEntry } from '../../stores/account-store';
import { usePolicyStore } from '../../stores/policy-store';
import { sanitizePolicy } from '../org-policy';

export const WEBMAIL = 'https://webmail.example.org';
export const ADA = 'ada@example.org@mail.example.org';

export function account(id: string, username: string, extra: Partial<AccountEntry> = {}): AccountEntry {
  return {
    id, serverUrl: 'https://mail.example.org', username, displayName: username, email: username, avatarColor: '#000',
    lastLoginAt: 1, isConnected: true, hasError: false, isDefault: false, webmailUrl: WEBMAIL,
    ...extra,
  };
}

/** Sign Ada in (the active account) with this policy JSON cached for her; null for none. */
export function givenPolicy(raw: unknown, opts: { partial?: boolean; accounts?: AccountEntry[] } = {}): void {
  const accounts = opts.accounts ?? [account(ADA, 'ada@example.org')];
  useAccountStore.setState({ accounts, activeAccountId: accounts[0]?.id ?? null });
  const policy = raw === null ? null : sanitizePolicy(raw);
  usePolicyStore.setState({
    accountId: accounts[0]?.id ?? null,
    byAccount: policy
      ? Object.fromEntries(accounts.map((a) => [a.id, { policy, partial: opts.partial ?? false, fetchedAt: 1, webmailUrl: WEBMAIL }]))
      : {},
  });
}
