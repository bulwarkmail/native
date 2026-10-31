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

/**
 * The port of `serverUrl` when it is not the scheme's default (443 for
 * https, 80 for http), else null. Read from the text, since React Native's
 * URL keeps a default port where the WHATWG one drops it.
 */
export function nonDefaultPort(serverUrl: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/?#]*@)?(?:\[[^\]]*\]|[^:/?#]*):(\d+)(?=[/?#]|$)/i.exec(serverUrl.trim());
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const port = String(Number(m[2]));
  if ((scheme === 'https' && port === '443') || (scheme === 'http' && port === '80')) return null;
  return port;
}

/** `serverUrl`'s host, with its port when that is not the default. */
export function serverHostLabel(serverUrl: string): string {
  let host: string;
  try {
    host = new URL(serverUrl).hostname;
  } catch {
    return serverUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
  const port = nonDefaultPort(serverUrl);
  return port ? `${host}:${port}` : host;
}

/** The id an account got before ports were part of it: username@host. */
function hostOnlyAccountId(username: string, serverUrl: string): string {
  let host = serverUrl;
  try {
    host = new URL(serverUrl).hostname;
  } catch {
    host = serverUrl.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  }
  return `${username}@${host}`;
}

/** The default port of `serverUrl`'s scheme: 80 for http, 443 otherwise. */
function defaultPortOf(serverUrl: string): string {
  return /^http:/i.test(serverUrl.trim()) ? '80' : '443';
}

/** What the registry tells generateAccountId (structural: no AccountEntry import). */
export interface KnownAccount {
  id: string;
  username: string;
  serverUrl: string;
}

let knownAccounts: readonly KnownAccount[] = [];

/**
 * The registry's accounts, so generateAccountId keeps the ids accounts were
 * signed in under. The account store feeds this whenever it changes; the
 * headless push task, which reads the registry from storage, feeds it too.
 */
export function setKnownAccounts(accounts: readonly KnownAccount[]): void {
  knownAccounts = accounts;
}

/**
 * The local id of the account `username` has on `serverUrl`:
 * username@host, plus `:port` when the server is not on its scheme's
 * default port. Two servers on one host are two accounts.
 *
 * Accounts were once keyed by username@host only. One signed in that way on
 * a server with a port keeps that id, and with it its credentials, caches,
 * outbox, push registration and settings: when the registry holds the
 * host-only id for the same server, that is the answer. A second server on
 * the same host then gets the id with its port, and the two stay apart.
 * Accounts on the default ports have the same id either way, with one
 * exception: when the registry holds username@host for a server on another
 * port of that host (kept from before ports counted), the default-port
 * server gets username@host:443 (or :80 for http), so the two don't share
 * credentials and caches. It keeps that id once it has it.
 */
export function generateAccountId(username: string, serverUrl: string): string {
  const legacy = hostOnlyAccountId(username, serverUrl);
  const host = serverHostLabel(serverUrl);
  const id = `${username}@${host}`;
  if (id === legacy) {
    const explicit = `${id}:${defaultPortOf(serverUrl)}`;
    if (knownAccounts.some((a) => a.id === explicit)) return explicit;
    const taken = knownAccounts.some((a) => a.id === id && `${a.username}@${serverHostLabel(a.serverUrl)}` !== id);
    return taken ? explicit : id;
  }
  const kept = knownAccounts.find((a) => a.id === legacy
    && a.username === username
    && `${a.username}@${serverHostLabel(a.serverUrl)}` === id);
  return kept ? kept.id : id;
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
