import { getDomain } from 'tldts';

// Anything that would make tldts read the input as a URL rather than a bare
// host: a scheme, userinfo, port, path, query or fragment.
const NOT_A_HOST = /[\s/\\:@?#%[\]]/;

/**
 * The registrable domain of a host: the public suffix plus one label, by the
 * public suffix list, private suffixes included (`alice.github.io` and
 * `bob.github.io` are two domains). Lowercased, a trailing dot dropped.
 * Null for an IP address, a single label, a bare public suffix, or anything
 * longer than a DNS name can be.
 */
export function registrableDomain(host: string): string | null {
  const name = host.trim().toLowerCase().replace(/\.$/, '');
  if (!name || name.length > 253 || NOT_A_HOST.test(name)) return null;
  return getDomain(name, { allowPrivateDomains: true });
}

/**
 * DMARC relaxed alignment (RFC 7489 §3.1): two hosts align when they are
 * the same, or share one registrable domain. So `news.bank.example` and
 * `mailer.bank.example` align, but two tenants of a shared suffix
 * (`evil.co.uk` and `bank.co.uk`, or two github.io sites) never do.
 */
export function domainsAlign(a: string, b: string): boolean {
  if (a === b) return true;
  const domain = registrableDomain(a);
  return !!domain && domain === registrableDomain(b);
}
