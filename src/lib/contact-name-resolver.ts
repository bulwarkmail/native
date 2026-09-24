import React from 'react';
import type { ContactCard } from '../api/types';
import { useAccountStore } from '../stores/account-store';
import { useContactsStore } from '../stores/contacts-store';
import { useSettingsStore } from '../stores/settings-store';
import { getContactDisplayName } from './contact-utils';

// Port of the webmail's hooks/use-contact-name-resolver.ts (8cbc5bc5,
// 6f99c017): names for participants whose event data carries only a bare
// address.

/** Domains are related when one extends the other at a label boundary —
 *  "node-example.com" vs "example.com" (host-prefixed) or "mail.example.com" vs
 *  "example.com" (subdomain). Stalwart deployments commonly expose one account
 *  under several such domains, so a participant address and the contact card
 *  holding that person's name may differ in domain while naming the same
 *  person. A pure string suffix ("xexample.com" vs "example.com") is NOT
 *  related — the character at the split must be "." or "-". */
function isRelatedDomain(a: string, b: string): boolean {
  if (a === b) return true;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  if (!longer.endsWith(shorter)) return false;
  const boundary = longer[longer.length - shorter.length - 1];
  return boundary === '.' || boundary === '-';
}

interface IdentityLike {
  name?: string;
  email?: string;
}

interface AccountLike {
  name?: string;
  email?: string;
  username?: string;
}

/**
 * Build an email → display-name lookup. Resolution order (first hit wins):
 *
 *  1. Contact card holding the exact address — the user's curated data, so it
 *     outranks everything else.
 *  2. Contact card with the same local part on a related domain (the
 *     alias-domain case above). Only applied when exactly one name matches;
 *     two cards disagreeing means we cannot know which person it is.
 *  3. The account's display name for the user's own addresses — the organizer
 *     of a self-created event is the user, and Stalwart strips the participant
 *     name on its iCalendar round-trip.
 *  4. The identity From-name.
 *
 * Cards with no resolvable name contribute nothing, so whatever name the event
 * itself carries always stays authoritative and this resolver is a pure
 * fallback for bare addresses.
 */
export function buildContactNameResolver(
  contacts: ReadonlyArray<ContactCard>,
  identities: ReadonlyArray<IdentityLike> = [],
  accounts: ReadonlyArray<AccountLike> = [],
): (email: string) => string | undefined {
  const contactNamesByEmail = new Map<string, string>();
  const contactNamesByLocalPart = new Map<string, Array<{ domain: string; name: string }>>();
  const accountNamesByEmail = new Map<string, string>();
  const identityNamesByEmail = new Map<string, string>();

  /** Register `name` for `address` unless it is just the address itself —
   *  several name sources default to the email and would add nothing over the
   *  bare address every renderer already shows. */
  const register = (map: Map<string, string>, name: string | undefined, address: string | undefined) => {
    const trimmedName = name?.trim();
    const key = address?.trim().toLowerCase();
    if (!trimmedName || !key || map.has(key)) return;
    if (trimmedName.toLowerCase() === key) return;
    map.set(key, trimmedName);
  };

  for (const contact of contacts) {
    const name = getContactDisplayName(contact).trim();
    if (!name || !contact.emails) continue;
    // getContactDisplayName falls back to the first email address, so a card
    // whose "name" is just one of its addresses is equally useless here.
    const nameIsJustAnAddress = Object.values(contact.emails).some(
      (e) => e.address?.trim().toLowerCase() === name.toLowerCase(),
    );
    if (nameIsJustAnAddress) continue;
    for (const { address } of Object.values(contact.emails)) {
      const key = address?.trim().toLowerCase();
      if (!key || contactNamesByEmail.has(key)) continue;
      contactNamesByEmail.set(key, name);
      const [localPart, ...rest] = key.split('@');
      const domain = rest.join('@');
      if (localPart && domain) {
        const bucket = contactNamesByLocalPart.get(localPart) ?? [];
        bucket.push({ domain, name });
        contactNamesByLocalPart.set(localPart, bucket);
      }
    }
  }

  for (const account of accounts) {
    register(accountNamesByEmail, account.name, account.email);
    // A short login username ("zhang") is not an address; only match
    // usernames that actually carry a domain.
    if (account.username?.includes('@')) {
      register(accountNamesByEmail, account.name, account.username);
    }
  }

  for (const identity of identities) {
    register(identityNamesByEmail, identity.name, identity.email);
  }

  return (email: string) => {
    const key = email?.trim().toLowerCase();
    if (!key) return undefined;

    // 1. Exact address on a contact card.
    const exact = contactNamesByEmail.get(key);
    if (exact) return exact;

    // 2. Same local part on a related domain. Ambiguous matches resolve to
    // nothing rather than to a guess.
    const [localPart, ...rest] = key.split('@');
    const domain = rest.join('@');
    if (localPart && domain) {
      const candidates = new Set<string>();
      for (const candidate of contactNamesByLocalPart.get(localPart) ?? []) {
        if (isRelatedDomain(candidate.domain, domain)) candidates.add(candidate.name);
      }
      if (candidates.size === 1) return candidates.values().next().value;
    }

    // 3. The user's own account display name, then 4. the identity From-name.
    return accountNamesByEmail.get(key) ?? identityNamesByEmail.get(key);
  };
}

/**
 * Participant rows show a contact's display name when the event data itself
 * carries only a bare address. Memoised on the contact, account and identity
 * lists, so it recomputes only when one of them actually changes.
 */
export function useContactNameResolver(): (email: string) => string | undefined {
  const contacts = useContactsStore((s) => s.contacts);
  const identities = useSettingsStore((s) => s.identities);
  const accounts = useAccountStore((s) => s.accounts);
  return React.useMemo(
    () =>
      buildContactNameResolver(
        contacts,
        identities,
        // AccountEntry calls the display name `displayName`; map it onto the
        // generic `name` the resolver works with.
        accounts.map((a) => ({ name: a.displayName, email: a.email, username: a.username })),
      ),
    [contacts, identities, accounts],
  );
}
