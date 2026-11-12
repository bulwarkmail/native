// The organisation's own mail domains, for the BIMI logo of mail handed in
// on the same server (webmail lib/external-mail.ts internalDomains,
// hooks/use-brand-domain.ts, 531358eb3): the domains of the user's
// identities, then the ones the admin lists under External mail, in ASCII
// form, deduplicated. A domain covers its subdomains.

import React from 'react';
import { toAsciiDomain } from './idn';
import { useSettingsStore } from '../stores/settings-store';
import { usePolicyStore } from '../stores/policy-store';

const MAX_DOMAINS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asciiDomain(value: string): string {
  const domain = value.trim().replace(/^@/, '').replace(/\.+$/, '').toLowerCase();
  return domain ? (toAsciiDomain(domain) ?? '').toLowerCase() : '';
}

/** The admin's internal domains in a policy's organisation part (`externalMail.domains`). */
export function policyInternalDomains(organisation: unknown): string[] {
  const externalMail = isRecord(organisation) ? organisation.externalMail : undefined;
  const domains = isRecord(externalMail) ? externalMail.domains : undefined;
  return Array.isArray(domains) ? domains.filter((d): d is string => typeof d === 'string') : [];
}

/** The identities' domains first (so the cap never cuts them), then the admin's. */
export function internalMailDomains(identityEmails: readonly string[], policyDomains: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (domain: string) => {
    if (!domain || seen.has(domain) || out.length >= MAX_DOMAINS) return;
    seen.add(domain);
    out.push(domain);
  };
  for (const address of identityEmails) {
    const at = address.lastIndexOf('@');
    // A catch-all identity (`*@example.org`) still names its domain.
    if (at >= 0) add(asciiDomain(address.slice(at + 1)));
  }
  for (const domain of policyDomains) add(asciiDomain(domain));
  return out;
}

/** The active account's internal domains; the same array until identities or the policy change. */
export function useInternalMailDomains(): string[] {
  const identities = useSettingsStore((s) => s.identities);
  const policy = usePolicyStore((s) => s.effective);
  return React.useMemo(
    () => internalMailDomains(identities.map((i) => i.email ?? ''), policyInternalDomains(policy?.organisation)),
    [identities, policy],
  );
}
