import { getDomain } from 'tldts';

// Anything that would make tldts read the input as a URL rather than a bare
// host (a scheme, userinfo, port, path, query or fragment), or that no DNS
// name holds: a C0 control or DEL.
// eslint-disable-next-line no-control-regex
const NOT_A_HOST = /[\s/\\:@?#%[\]\u0000-\u001f\u007f]/;

/**
 * The registrable domain of a host: the public suffix plus one label, by the
 * public suffix list, private suffixes included (`alice.github.io` and
 * `bob.github.io` are two domains). Lowercased, a trailing dot dropped.
 * Null for an IP address, a single label, a bare public suffix, an empty
 * label, or anything longer than a DNS name can be.
 */
export function registrableDomain(host: string): string | null {
  const name = host.trim().toLowerCase().replace(/\.$/, '');
  if (!name || name.length > 253 || NOT_A_HOST.test(name)) return null;
  // An empty label (`mx..bank.example`, a leading dot) is no host name.
  if (name.split('.').includes('')) return null;
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
