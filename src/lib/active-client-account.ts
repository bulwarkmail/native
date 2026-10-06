import { jmapClient } from '../api/jmap-client';
import { useAccountStore } from '../stores/account-store';

const trimUrl = (url: string | null | undefined) => (url ?? '').trim().replace(/\/+$/, '');

/**
 * A server URL reduced to what identifies it: scheme, host (case-insensitive,
 * with its port) and path, minus trailing slashes. A different host, port,
 * scheme or path never compares equal. A URL with userinfo, a query or a
 * fragment has no key and never matches.
 */
function serverKey(url: string | null | undefined): string | null {
  const trimmed = trimUrl(url);
  try {
    const u = new URL(trimmed);
    if (u.username || u.password || u.search || u.hash || /[?#]/.test(trimmed)) return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return trimmed || null;
  }
}

/**
 * A username trimmed, with only the domain after the last `@` lowercased:
 * domains are case-insensitive, local parts (and bare login names) are not.
 */
function userKey(username: string | null | undefined): string {
  const value = (username ?? '').trim();
  const at = value.lastIndexOf('@');
  return at < 0 ? value : `${value.slice(0, at)}@${value.slice(at + 1).toLowerCase()}`;
}

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
  const entryServer = serverKey(entry.serverUrl);
  const user = userKey(jmapClient.username);
  return entryServer !== null
    && entryServer === serverKey(jmapClient.serverUrl)
    && user !== ''
    && userKey(entry.username) === user;
}
