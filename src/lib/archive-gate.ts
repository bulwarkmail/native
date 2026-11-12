// The organisation's "archiving off" (policy archiveActionEnabled) for code
// that runs without the policy store loaded: the widgets and the push task.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { isFeatureEnabled, resolvePolicy, sanitizePolicy } from './org-policy';

export interface ArchiveGateAccount {
  id: string;
  email?: string;
  username?: string;
  webmailUrl?: string;
}

/**
 * Whether the account's organisation lets it archive (policy
 * archiveActionEnabled), from the policy the app cached for it
 * (stores/policy-store.ts, which this runtime may not have loaded). On
 * without a webmail or a cached policy from it.
 */
export async function readArchiveEnabled(account: ArchiveGateAccount | undefined): Promise<boolean> {
  if (!account?.webmailUrl) return true;
  try {
    const raw = await AsyncStorage.getItem('org-policy-cache');
    const byAccount = raw
      ? (JSON.parse(raw) as { state?: { byAccount?: Record<string, { policy?: unknown; webmailUrl?: string }> } }).state?.byAccount
      : undefined;
    const cached = byAccount?.[account.id];
    const policy = cached?.webmailUrl === account.webmailUrl ? sanitizePolicy(cached.policy) : null;
    if (!policy) return true;
    const email = (account.email || account.username || '').trim().toLowerCase();
    return isFeatureEnabled(resolvePolicy(policy, { email, groups: [] }), 'archiveActionEnabled');
  } catch {
    return true;
  }
}

/** readArchiveEnabled for an account of the app's registry, by its id. */
export async function readArchiveEnabledFor(accountId: string): Promise<boolean> {
  try {
    const raw = await AsyncStorage.getItem('account-registry');
    const accounts = raw ? (JSON.parse(raw) as { state?: { accounts?: unknown } }).state?.accounts : undefined;
    const account = Array.isArray(accounts)
      ? (accounts as ArchiveGateAccount[]).find((a) => a?.id === accountId)
      : undefined;
    return readArchiveEnabled(account);
  } catch {
    return true;
  }
}
