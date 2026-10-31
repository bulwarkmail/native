// BIMI sender logos (webmail components/ui/avatar.tsx, lib/email-headers.ts
// brandIndicatorDomain, app/api/bimi/route.ts). The logo comes from the
// webmail the account signed in through: GET <webmail>/api/bimi?domain=<From
// domain> answers it as a PNG, or a 1x1 transparent PNG when the domain has
// none. The webmail caches its answers (6 h for a logo, 1 h for none); a
// domain without a logo is also remembered here for the session.

import type { Email } from '../api/types';
import {
  LIST_AUTH_RESULTS_PROPERTY,
  headerValues,
  isAuthenticationSpoofed,
  parseAuthenticationResults,
  type AuthenticationResults,
} from './email-headers';

function domainOf(address: string): string | undefined {
  const domain = address.slice(address.lastIndexOf('@') + 1).trim().toLowerCase().replace(/\.$/, '');
  return /^[^\s<>@]+\.[^\s<>@]+$/.test(domain) ? domain : undefined;
}

/** The Authentication-Results of a message as the list or the reader holds it. */
function authenticationResultsOf(email: Pick<Email, 'headers' | 'from'>): AuthenticationResults | undefined {
  let values: string[];
  if (email.headers) {
    values = headerValues(email.headers, 'Authentication-Results');
  } else {
    const raw = (email as { [LIST_AUTH_RESULTS_PROPERTY]?: unknown })[LIST_AUTH_RESULTS_PROPERTY];
    values = Array.isArray(raw) ? raw.filter((value): value is string => typeof value === 'string') : [];
  }
  return values.length > 0 ? parseAuthenticationResults(values) : undefined;
}

/**
 * The From domain of a message that passed DMARC for that domain, whose
 * BIMI logo may stand for the sender (webmail brandIndicatorDomain). The
 * logo says who the domain is, not that a message came from it, so a message
 * without a DMARC pass for its own From domain gets none. Undefined for no
 * message (rows that show the recipient).
 */
export function brandIndicatorDomain(email: Pick<Email, 'headers' | 'from'> | undefined): string | undefined {
  if (!email) return undefined;
  const fromEmail = email.from?.[0]?.email ?? undefined;
  const auth = authenticationResultsOf(email);
  if (!auth?.dmarc || auth.dmarc.result !== 'pass' || !fromEmail) return undefined;
  const domain = domainOf(fromEmail);
  if (!domain || isAuthenticationSpoofed(auth)) return undefined;
  const checked = auth.dmarc.domain ? domainOf(`@${auth.dmarc.domain}`) : domain;
  return checked === domain ? domain : undefined;
}

/** The logo URL on the account's webmail; null without a usable webmail address. */
export function bimiLogoUrl(webmailUrl: string | null | undefined, domain: string): string | null {
  const base = webmailUrl?.trim().replace(/\/+$/, '');
  if (!base || !/^https?:\/\/[^/]/i.test(base)) return null;
  return `${base}/api/bimi?domain=${encodeURIComponent(domain)}`;
}

/**
 * Whether the avatar of `email` may show the BIMI logo of `brandDomain`
 * (webmail Avatar showBrand): only under the sender favicon switch, only for
 * the address shown (a thread row may show another participant than the
 * message whose DMARC pass named the domain), and only from a webmail.
 */
export function showBrandLogo(options: {
  senderFavicons: boolean;
  email: string | null | undefined;
  brandDomain: string | null | undefined;
  webmailUrl: string | null | undefined;
}): boolean {
  const { senderFavicons, email, brandDomain, webmailUrl } = options;
  if (!senderFavicons || !brandDomain || !email) return false;
  if (domainOf(email) !== brandDomain) return false;
  const url = bimiLogoUrl(webmailUrl, brandDomain);
  return url !== null && !failedBrandLogos.has(url);
}

// Logos that didn't load or answered "no logo", for the session.
const failedBrandLogos = new Set<string>();

export function markBrandLogoFailed(url: string): void {
  failedBrandLogos.add(url);
}

export function hasBrandLogoFailed(url: string): boolean {
  return failedBrandLogos.has(url);
}

/** The webmail's "no logo" answer is a 1x1 transparent PNG. */
export function isNoLogoImage(size: { width?: number; height?: number } | null | undefined): boolean {
  return !!size && typeof size.width === 'number' && size.width <= 1;
}

export function resetBrandLogosForTests(): void {
  failedBrandLogos.clear();
}
