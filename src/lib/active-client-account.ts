import { jmapClient } from '../api/jmap-client';
import { useAccountStore } from '../stores/account-store';

const trimUrl = (url: string | null | undefined) => (url ?? '').replace(/\/+$/, '');

/** The app account id (account-store id) the app shows as active, or null. */
export function activeAppAccountId(): string | null {
  return useAccountStore.getState().activeAccountId ?? null;
}

/**
 * During an account switch the client's session lags the account store (and
 * the other way round), so work started in that window may be for the account
 * being left. True only when the client's credentials belong to the account
 * the app shows as active.
 */
export function clientServesActiveAccount(): boolean {
  const accounts = useAccountStore.getState();
  const entry = accounts.activeAccountId ? accounts.getAccountById(accounts.activeAccountId) : undefined;
  if (!entry) return false;
  return entry.username === jmapClient.username
    && trimUrl(entry.serverUrl) === trimUrl(jmapClient.serverUrl);
}
