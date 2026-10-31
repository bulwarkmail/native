// Telling apart accounts that read the same. One address on two servers (or
// two ports of one host) is two accounts, and the places that name an
// account in one line (global search chips and hit lines, the add-account
// screen, push notifications) showed two identical "User A". The switcher
// and the account settings already show the server with its port when that
// isn't the default (account-utils serverHostLabel); these do the same, but
// only where another account would otherwise read the same.

import { accountRowText, nonDefaultPort, serverHostLabel, type NamedAccount } from './account-utils';

const key = (value: string) => value.trim().toLowerCase();

/** The server as the switcher names it; the full URL when two only differ in scheme. */
function serverName(serverUrl: string, others: readonly string[]): string {
  const host = serverHostLabel(serverUrl);
  const clash = others.some((u) => key(u.replace(/\/+$/, '')) !== key(serverUrl.replace(/\/+$/, ''))
    && key(serverHostLabel(u)) === key(host));
  return clash ? serverUrl.replace(/\/+$/, '') : host;
}

/**
 * `label` per id, with the server added in brackets when another item has
 * the same label: "usera@example.org (mail.example.org:8016)".
 */
export function labelsWithServer(
  items: ReadonlyArray<{ id: string; label: string; serverUrl?: string }>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of items) {
    const twins = items.filter((o) => o.id !== item.id && key(o.label) === key(item.label));
    if (twins.length === 0 || !item.serverUrl) {
      out.set(item.id, item.label);
      continue;
    }
    const server = serverName(item.serverUrl, twins.map((o) => o.serverUrl ?? ''));
    out.set(item.id, `${item.label} (${server})`);
  }
  return out;
}

export interface ServerAccount extends NamedAccount {
  serverUrl: string;
}

/**
 * The one-line name of each account (a chip, a search hit's account): the
 * name, or the address when another account has the same name
 * (accountRowText), plus the server when that still reads the same.
 */
export function distinctAccountLabels(accounts: readonly ServerAccount[]): Map<string, string> {
  return labelsWithServer(accounts.map((a) => ({
    id: a.id,
    label: accountRowText(a, accounts).title,
    serverUrl: a.serverUrl,
  })));
}

/**
 * The server line under an account row: shown, as in the account settings,
 * when the server is on a port other than the default, and also when another
 * account has the same address. Null when the row doesn't need one.
 */
export function accountServerLine(account: ServerAccount, accounts: readonly ServerAccount[]): string | null {
  const address = key(account.email || account.username);
  const shared = accounts.some((a) => a.id !== account.id && key(a.email || a.username) === address);
  if (!shared && !nonDefaultPort(account.serverUrl)) return null;
  return serverName(account.serverUrl, accounts.filter((a) => a.id !== account.id).map((a) => a.serverUrl));
}

/**
 * The servers the accounts are on, each once, the active account's first:
 * the add-account screen offers "Another account on …" for each.
 */
export function distinctServerUrls(
  accounts: ReadonlyArray<{ id: string; serverUrl: string }>,
  activeAccountId: string | null,
): string[] {
  const ordered = [
    ...accounts.filter((a) => a.id === activeAccountId),
    ...accounts.filter((a) => a.id !== activeAccountId),
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of ordered) {
    if (!a.serverUrl) continue;
    const k = key(a.serverUrl.replace(/\/+$/, ''));
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(a.serverUrl);
  }
  return out;
}

/** What the push task reads from the stored account registry. */
export interface RegistryLabelAccount {
  id: string;
  username?: string;
  serverUrl?: string;
}

/**
 * The account a push notification names (the relay's label, the username),
 * with the server when another signed-in account has the same username.
 */
export function pushAccountLabel(
  accountId: string,
  label: string,
  registry: readonly RegistryLabelAccount[],
): string {
  if (!label || !registry.some((a) => a.id === accountId)) return label;
  const items = registry.map((a) => ({
    id: a.id,
    label: a.id === accountId ? label : a.username ?? '',
    serverUrl: a.serverUrl,
  }));
  return labelsWithServer(items).get(accountId) ?? label;
}

/**
 * The account line of a push that more than one login could own (see
 * matchAccountsForPush): the label, and when those logins are on different
 * servers, the servers it may have come from.
 */
export function ambiguousPushLabel(
  candidateIds: readonly string[],
  label: string,
  registry: readonly RegistryLabelAccount[],
): string {
  const urls = candidateIds
    .map((id) => registry.find((a) => a.id === id)?.serverUrl)
    .filter((u): u is string => !!u);
  const servers: string[] = [];
  for (const url of urls) {
    const name = serverName(url, urls);
    if (!servers.includes(name)) servers.push(name);
  }
  if (servers.length < 2) return label;
  return label ? `${label} (${servers.join(', ')})` : servers.join(', ');
}
