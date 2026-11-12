/**
 * Who is outside the organisation, for the "External" sender chip and the
 * confirm before sending outside it (policy `organisation.externalMail`).
 * Port of the webmail's lib/external-mail.ts (pure part) and the
 * externalMail section of lib/admin/organisation-policy.ts.
 *
 * Internal are the domains of the user's own identities plus the domains
 * the admin lists; a listed domain covers its subdomains (example.com
 * covers eu.example.com). With no internal domain known at all nobody can
 * be told apart, so nothing counts as external. Domains are compared in
 * ASCII (punycode) form on both sides.
 */

import { toAsciiDomain, toAsciiEmail } from './idn';
import { internalMailDomains, policyInternalDomains } from './avatar-internal-domains';

export interface ExternalMailPolicy {
  /** "External" chip on mail from senders outside the organisation domains. */
  senderLabel: boolean;
  /** Confirm before sending to recipients outside the organisation domains. */
  recipientWarning: boolean;
  /** More organisation domains, added to the identities' own. */
  domains: string[];
  /** Recipients in the user's contacts don't trigger the warning. */
  trustContacts: boolean;
}

export const DEFAULT_EXTERNAL_MAIL: ExternalMailPolicy = { senderLabel: false, recipientWarning: false, domains: [], trustContacts: true };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** The externalMail section of a policy's `organisation` part, with the defaults for what it leaves out. */
export function externalMailPolicyOf(organisation: unknown): ExternalMailPolicy {
  const raw = isRecord(organisation) && isRecord(organisation.externalMail) ? organisation.externalMail : {};
  return {
    senderLabel: raw.senderLabel === true,
    recipientWarning: raw.recipientWarning === true,
    domains: policyInternalDomains(organisation),
    trustContacts: raw.trustContacts !== false,
  };
}

/** The bare address of "Name <a@b>" or "a@b". */
function bareAddress(address: string | null | undefined): string {
  const raw = String(address ?? '').trim();
  const bracket = raw.match(/<([^<>]*)>\s*$/);
  return (bracket ? bracket[1] : raw).trim();
}

/** The domain of an address in lowercased ASCII form; '' without a usable one. */
export function addressDomain(address: string | null | undefined): string {
  const bare = bareAddress(address);
  const at = bare.lastIndexOf('@');
  if (at < 0) return '';
  const domain = bare.slice(at + 1).trim().replace(/\.+$/, '');
  return (domain && toAsciiDomain(domain)) || '';
}

/** The address as a lookup key: the domain in ASCII form, all lowercased. */
export function addressKey(address: string): string {
  return toAsciiEmail(bareAddress(address)).toLowerCase();
}

/** True when `domain` (ASCII) is one of `internal` or a subdomain of one. */
export function domainMatches(domain: string, internal: readonly string[]): boolean {
  if (!domain) return false;
  const d = domain.toLowerCase();
  return internal.some((entry) => d === entry || d.endsWith(`.${entry}`));
}

/** The identities' domains, then the admin's, in ASCII form and deduplicated. */
export function internalDomains(identityEmails: readonly string[], policyDomains: readonly string[]): string[] {
  return internalMailDomains(identityEmails, policyDomains);
}

/** Whether mail to this address leaves the organisation. An address without a domain isn't counted. */
export function isExternalAddress(address: string, internal: readonly string[]): boolean {
  if (internal.length === 0) return false;
  const domain = addressDomain(address);
  return !!domain && !domainMatches(domain, internal);
}

export type RecipientField = 'to' | 'cc' | 'bcc';

export interface ExternalRecipient {
  address: string;
  domain: string;
  field: RecipientField;
}

/**
 * The recipients outside the organisation, each address once (in the first
 * field it appears in). `trusted` is asked for the rest, with the address as
 * addressKey makes it: with "trust contacts" on, a contact doesn't count.
 */
export function externalRecipients(
  recipients: { to: readonly string[]; cc: readonly string[]; bcc: readonly string[] },
  internal: readonly string[],
  trusted?: (key: string) => boolean,
): ExternalRecipient[] {
  const out: ExternalRecipient[] = [];
  const seen = new Set<string>();
  for (const field of ['to', 'cc', 'bcc'] as const) {
    for (const raw of recipients[field]) {
      const address = String(raw ?? '').trim();
      const key = addressKey(address);
      if (!address || seen.has(key)) continue;
      seen.add(key);
      if (!isExternalAddress(address, internal)) continue;
      if (trusted?.(key)) continue;
      out.push({ address, domain: addressDomain(address), field });
    }
  }
  return out;
}

export interface ExternalSender {
  address: string;
  /** ASCII domain; '' for an address without one. */
  domain: string;
}

/**
 * The From addresses that are outside the organisation. A message counts as
 * external when any of them is, and an address without a domain counts too:
 * no organisation sends like that. A forged internal From is not caught
 * here; the sender check warns about that.
 */
export function externalSenders(
  from: readonly { email?: string | null }[] | null | undefined,
  internal: readonly string[],
): ExternalSender[] {
  if (!from || internal.length === 0) return [];
  const out: ExternalSender[] = [];
  for (const sender of from) {
    const address = String(sender?.email ?? '').trim();
    const domain = addressDomain(address);
    if (domain && domainMatches(domain, internal)) continue;
    out.push({ address, domain });
  }
  return out;
}

/**
 * Whether every From address of a message is inside the organisation. False
 * without a From or without known domains (webmail senderIsInternal).
 */
export function senderIsInternal(
  from: readonly { email?: string | null }[] | null | undefined,
  internal: readonly string[],
): boolean {
  if (!from || from.length === 0 || internal.length === 0) return false;
  return externalSenders(from, internal).length === 0;
}
