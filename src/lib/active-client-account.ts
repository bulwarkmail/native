import { jmapClient } from '../api/jmap-client';
import { useAccountStore } from '../stores/account-store';

const trimUrl = (url: string | null | undefined) => (url ?? '').trim().replace(/\/+$/, '');

/**
 * A server URL reduced to what identifies it: scheme, host (case-insensitive,
 * with its port) and path, minus trailing slashes. A different host, port,
 * scheme or path never compares equal.
 */
function serverKey(url: string | null | undefined): string {
  const trimmed = trimUrl(url);
  try {
    const u = new URL(trimmed);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return trimmed;
  }
}

const userKey = (username: string | null | undefined) => (username ?? '').trim().toLowerCase();

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
  if (serverKey(entry.serverUrl) !== serverKey(jmapClient.serverUrl)) return false;
  if (entry.username === jmapClient.username) return true;

  // Beyond an exact match only case and surrounding whitespace in the username
  // are forgiven. The registry keeps usernames case-sensitive (`Ada` and `ada`
  // on one host are two accounts), so when another account would match the
  // client just as loosely the client could belong to either: stay strict.
  const key = userKey(jmapClient.username);
  if (!key || userKey(entry.username) !== key) return false;
  const rivals = accounts.accounts.some((a) =>
    a.id !== entry.id
    && serverKey(a.serverUrl) === serverKey(entry.serverUrl)
    && userKey(a.username) === key);
  return !rivals;
}
