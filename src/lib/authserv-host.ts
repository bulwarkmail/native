import { useAccountStore } from '../stores/account-store';
import { serverHostOf } from './authserv';

// The host whose Authentication-Results count for a message: that of the app
// account the message belongs to, from its registry entry. Never the live
// client's: JMAP ids collide across accounts, and the message shown may not
// be the signed-in account's.

/** The authserv host of an app account, for render. Null when unknown. */
export function useAuthservHost(appAccountId: string | undefined): string | null {
  return useAccountStore((s) => authservHostIn(s.accounts, appAccountId));
}

/** The authserv host of an app account, read now (outside render). */
export function authservHostFor(appAccountId: string | undefined): string | null {
  return authservHostIn(useAccountStore.getState().accounts, appAccountId);
}

function authservHostIn(
  accounts: readonly { id: string; serverUrl: string }[],
  appAccountId: string | undefined,
): string | null {
  if (!appAccountId) return null;
  return serverHostOf(accounts.find((a) => a.id === appAccountId)?.serverUrl);
}
