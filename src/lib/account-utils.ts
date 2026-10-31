// Registry cap. Raised from 5: the per-account cost is one stored credential
// set and one cached snapshot; the SSE socket budget is bounded separately
// (MAX_SSE_STREAMS), so nothing scales with this number at runtime.
export const MAX_ACCOUNTS = 10;

/** A new account would take the registry past MAX_ACCOUNTS. */
export class AccountLimitError extends Error {
  readonly limit = MAX_ACCOUNTS;

  constructor() {
    super(`Maximum of ${MAX_ACCOUNTS} accounts reached`);
    this.name = 'AccountLimitError';
  }
}

export function generateAccountId(username: string, serverUrl: string): string {
  let host = serverUrl;
  try {
    host = new URL(serverUrl).hostname;
  } catch {
    host = serverUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
  return `${username}@${host}`;
}

/** What naming an account in a list needs (structural: no AccountEntry import). */
export interface NamedAccount {
  id: string;
  displayName?: string;
  email?: string;
  username: string;
}

/**
 * The bold title and the line under it for an account in a list (webmail
 * lib/account-utils.ts accountRowText, 3bb9f7df8). Usually the name over the
 * address. One person signed in to two mailboxes has the same name, and
 * often the same picture, on both, so the rows only differed in the small
 * address line: when another account shares the name, the address becomes
 * the title and the name is left out. A name that is just the address again
 * is left out too.
 */
export function accountRowText(
  account: NamedAccount,
  accounts: readonly NamedAccount[],
): { title: string; subtitle: string | null } {
  const key = (value: string) => value.trim().toLowerCase();
  const nameOf = (a: NamedAccount) => a.displayName || a.username;
  const name = nameOf(account);
  const address = account.email || account.username;
  const shared = accounts.some((a) => a.id !== account.id && key(nameOf(a)) === key(name));
  if (!name || shared || key(name) === key(address)) return { title: address, subtitle: null };
  return { title: name, subtitle: address };
}
