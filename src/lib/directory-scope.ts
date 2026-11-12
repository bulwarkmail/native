import { jmapClient } from '../api/jmap-client';
import { getIdentities } from '../api/identity';
import type { Principal } from '../api/types';

// The admin policy's directory rules (`directorySameDomainOnly`,
// `directoryHiddenLocalparts`; webmail lib/directory-scope.ts) for every
// list of the server's accounts the app shows: the contacts directory,
// sharing, delegation and free/busy, which all read listPrincipals. They
// narrow what the app shows, not what the server answers.
//
// The rules come from the active account's policy through a provider that
// lib/org-policy-effects.ts sets, so the API layer doesn't import the
// stores. Without one there are no rules.

export interface DirectoryRules {
  sameDomainOnly: boolean;
  /** Account names (the part before the @) left out, lowercase. */
  hiddenLocalparts: string[];
}

let rulesProvider: (() => DirectoryRules | null) | null = null;

export function setDirectoryRulesProvider(next: (() => DirectoryRules | null) | null): void {
  rulesProvider = next;
}

/** The rules of a policy's top-level fields (normalised: the policy file is written by hand). */
export function directoryRulesOf(policy: { directorySameDomainOnly?: unknown; directoryHiddenLocalparts?: unknown } | null | undefined): DirectoryRules | null {
  if (!policy) return null;
  const hiddenLocalparts = (Array.isArray(policy.directoryHiddenLocalparts) ? policy.directoryHiddenLocalparts : [])
    .filter((part): part is string => typeof part === 'string')
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
  const sameDomainOnly = policy.directorySameDomainOnly === true;
  return sameDomainOnly || hiddenLocalparts.length > 0 ? { sameDomainOnly, hiddenLocalparts } : null;
}

export interface DirectoryScope {
  /** Domains of the account's own addresses; null without the domain rule. Empty keeps no one. */
  ownDomains: string[] | null;
  hiddenLocalparts: string[];
}

function domainOf(address: string | null | undefined): string {
  const value = (address ?? '').trim().toLowerCase();
  const at = value.lastIndexOf('@');
  return at > 0 ? value.slice(at + 1) : '';
}

/** The address a principal is matched by: its email, else a name that holds one. */
export function principalAddress(principal: { email?: string | null; name?: string | null }): string {
  const email = principal.email?.trim();
  if (email) return email;
  const name = principal.name?.trim() ?? '';
  return name.includes('@') ? name : '';
}

const IDENTITY_DOMAINS_TTL_MS = 5 * 60 * 1000;
let identityDomains: { login: string; loadedAt: number; domains: Promise<string[]> } | null = null;

/** The domains of the account's identities (its aliases too), asked once per login for a few minutes. */
function identityDomainsOf(login: string): Promise<string[]> {
  if (identityDomains && identityDomains.login === login && Date.now() - identityDomains.loadedAt < IDENTITY_DOMAINS_TTL_MS) {
    return identityDomains.domains;
  }
  const domains = getIdentities()
    .then((list) => list.map((identity) => domainOf(identity.email)).filter(Boolean), (): string[] => []);
  identityDomains = { login, loadedAt: Date.now(), domains };
  return domains;
}

/** The scope for a listing of the active account, or null when the policy sets no rules. */
export async function directoryScopeFor(principals: readonly Principal[]): Promise<DirectoryScope | null> {
  const rules = rulesProvider?.() ?? null;
  if (!rules) return null;
  if (!rules.sameDomainOnly) return { ownDomains: null, hiddenLocalparts: rules.hiddenLocalparts };
  const own = new Set<string>();
  // Stalwart's master login is account%admin: the account decides.
  const username = jmapClient.username ?? '';
  const login = domainOf(username.split('%')[0]);
  if (login) own.add(login);
  for (const domain of await identityDomainsOf(`${jmapClient.serverUrl}|${username}`)) own.add(domain);
  const self = principals.find((p) => p.id === jmapClient.accountId);
  const selfDomain = self ? domainOf(principalAddress(self)) : '';
  if (selfDomain) own.add(selfDomain);
  return { ownDomains: [...own], hiddenLocalparts: rules.hiddenLocalparts };
}

/** Whether an account stays in a list under the scope. An entry without an address has no domain to stay by. */
export function inDirectoryScope(email: string | null | undefined, scope: DirectoryScope): boolean {
  const address = (email ?? '').trim().toLowerCase();
  const at = address.lastIndexOf('@');
  if (scope.hiddenLocalparts.includes(at >= 0 ? address.slice(0, at) : address)) return false;
  return scope.ownDomains === null || (at > 0 && scope.ownDomains.includes(address.slice(at + 1)));
}

/** A principal listing as the app shows it: with the policy's rules. One that can't be scoped counts as failed. */
export async function scopePrincipalListing<L extends { principals: Principal[]; status: string }>(listing: L): Promise<L> {
  try {
    const scope = await directoryScopeFor(listing.principals);
    if (!scope) return listing;
    return { ...listing, principals: listing.principals.filter((p) => inDirectoryScope(principalAddress(p), scope)) };
  } catch {
    return { ...listing, principals: [], status: 'error' };
  }
}
