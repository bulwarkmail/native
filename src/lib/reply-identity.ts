// Identity selection for replies, drafts and new messages. Port of the
// webmail's lib/reply-identity.ts.

import type { Identity } from '../api/types';
import { isSelfSent } from './reply-recipients';

interface ReplyRecipient {
  email?: string | null;
  name?: string | null;
}

export interface ReplyRecipients {
  to?: ReplyRecipient[];
  cc?: ReplyRecipient[];
  bcc?: ReplyRecipient[];
  /**
   * Addresses the message was delivered to, from `deliveryAddresses`. Only
   * looked at when To/Cc/Bcc have no match: mail to a catch-all alias that is
   * not in the headers (GitHub notifications, lists, Bcc) only shows the alias
   * there (webmail #1353).
   */
  deliveredTo?: string[];
}

/**
 * Headers that name the address a message was delivered to, most trusted
 * first. Stalwart adds `Delivered-To` with the envelope recipient on local
 * delivery, so on our own server it is the alias itself. The X- ones come
 * from upstream providers that forwarded or fetched the message.
 */
const DELIVERY_HEADERS = ['delivered-to', 'x-original-to', 'x-delivered-to', 'x-original-delivered-to'];

const ANGLE_ADDRESS = /<\s*([^<>\s@]+@[^<>\s@]+)\s*>/;
const BARE_ADDRESS = /([^\s<>"',;:@]+@[^\s<>"',;:@]+)/;

function addressInHeader(value: string): string | null {
  const match = value.match(ANGLE_ADDRESS) ?? value.match(BARE_ADDRESS);
  return match ? match[1].replace(/\.$/, '') : null;
}

/**
 * The delivery addresses of a message, in header order (the topmost
 * `Delivered-To` is the last hop, our own server), without duplicates.
 * Takes the JMAP `headers` list (or a name to value record); names are
 * matched case-insensitively since servers differ in how they spell them.
 */
export function deliveryAddresses(
  headers?: Array<{ name: string; value: string }> | Record<string, string | string[]> | null,
): string[] {
  if (!headers) return [];
  const entries: Array<[string, unknown]> = Array.isArray(headers)
    ? headers.map((h) => [h?.name ?? '', h?.value])
    : Object.entries(headers);
  const byName = new Map<string, string[]>();
  for (const [name, value] of entries) {
    const key = String(name).toLowerCase();
    if (!DELIVERY_HEADERS.includes(key)) continue;
    const values = Array.isArray(value) ? value : [value];
    byName.set(key, [...(byName.get(key) ?? []), ...values.filter((v): v is string => typeof v === 'string')]);
  }

  const seen = new Set<string>();
  const addresses: string[] = [];
  for (const name of DELIVERY_HEADERS) {
    for (const value of byName.get(name) ?? []) {
      const address = addressInHeader(value);
      if (!address) continue;
      const key = address.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      addresses.push(address);
    }
  }
  return addresses;
}

function headerAddresses(recipients: ReplyRecipients): string[] {
  return [...(recipients.to || []), ...(recipients.cc || []), ...(recipients.bcc || [])]
    .map((recipient) => recipient.email?.trim())
    .filter((email): email is string => Boolean(email));
}

function cleanAddresses(addresses?: string[]): string[] {
  return (addresses || [])
    .map((address) => address?.trim())
    .filter((address): address is string => Boolean(address));
}

function normalizeEmailAddress(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeBaseEmailAddress(email: string): string {
  const normalized = normalizeEmailAddress(email);
  const atIndex = normalized.indexOf('@');

  if (atIndex <= 0) {
    return normalized;
  }

  const localPart = normalized.slice(0, atIndex);
  const domain = normalized.slice(atIndex + 1);
  const plusIndex = localPart.indexOf('+');

  return `${plusIndex >= 0 ? localPart.slice(0, plusIndex) : localPart}@${domain}`;
}

function domainOf(email: string): string {
  const at = email.indexOf('@');
  return at > 0 ? email.slice(at + 1).toLowerCase() : '';
}

/**
 * Pick the identity a message was delivered to, among the user's own. Never
 * rewrites `From:` - it only chooses which configured address sends. Null
 * when none matches (caller keeps the default identity).
 *
 * Recipients are scanned in To, then Cc, then Bcc order, exact matches before
 * `+tag`-stripped ones. Scanning the identities instead would let the identity
 * list's order decide, so `To: team@, Cc: you@` would reply as you rather
 * than as the team - the exact case this is meant to fix.
 *
 * The delivery addresses (`deliveredTo`) are tried only after To/Cc/Bcc found
 * nothing.
 */
export function findReplyIdentityId(
  identities: Identity[],
  recipients?: ReplyRecipients,
): string | null {
  if (identities.length === 0 || !recipients) {
    return null;
  }

  return (
    matchOwnIdentity(identities, headerAddresses(recipients)) ??
    matchOwnIdentity(identities, cleanAddresses(recipients.deliveredTo))
  );
}

function matchOwnIdentity(identities: Identity[], receivedAddresses: string[]): string | null {
  if (receivedAddresses.length === 0) {
    return null;
  }

  const byExact = new Map<string, string>();
  const byBase = new Map<string, { id: string; untagged: boolean }>();
  for (const identity of identities) {
    const exact = normalizeEmailAddress(identity.email);
    const base = normalizeBaseEmailAddress(identity.email);
    if (!byExact.has(exact)) {
      byExact.set(exact, identity.id);
    }
    // For a `+tag` delivery with no exact identity, the untagged identity is the
    // answer; a differently-tagged sibling would disclose an unrelated tag.
    const untagged = exact === base;
    const existing = byBase.get(base);
    if (!existing || (untagged && !existing.untagged)) {
      byBase.set(base, { id: identity.id, untagged });
    }
  }

  for (const address of receivedAddresses) {
    const exactId = byExact.get(normalizeEmailAddress(address));
    if (exactId) {
      return exactId;
    }
  }

  for (const address of receivedAddresses) {
    const baseMatch = byBase.get(normalizeBaseEmailAddress(address));
    if (baseMatch) {
      return baseMatch.id;
    }
  }

  return null;
}

/**
 * Pick the identity to use for a NEW message started while viewing a specific
 * mailbox/account. Matches the active mailbox's address to a configured
 * identity (exact, then `+tag`-stripped). Returns `null` when no address is
 * given or none matches, so the caller keeps the primary identity.
 */
export function findComposeIdentityId(
  identities: Identity[],
  accountEmail?: string | null,
): string | null {
  const email = accountEmail?.trim();
  if (identities.length === 0 || !email) {
    return null;
  }

  const exact = normalizeEmailAddress(email);
  const exactIdentity = identities.find((identity) => normalizeEmailAddress(identity.email) === exact);
  if (exactIdentity) {
    return exactIdentity.id;
  }

  const base = normalizeBaseEmailAddress(email);
  const baseIdentity = identities.find((identity) => normalizeBaseEmailAddress(identity.email) === base);

  return baseIdentity?.id ?? null;
}

/**
 * Address whose identity `findComposeIdentityId` should preselect, based on the
 * mailbox currently open.
 *
 * A shared/group folder has no login of its own - it is reached through the
 * user's - so the owner of the open folder is the right default sender there.
 * `accountName` is the JMAP `Account.name`, which RFC 8620 describes as "e.g.,
 * the email address of the account"; a server that puts a human label there
 * produces no match (the `@` test keeps that explicit) and the caller keeps
 * its default identity.
 */
export function resolveComposeAccountEmail(
  mailboxes: Array<{ id: string; isShared?: boolean; accountName?: string }>,
  selectedMailbox?: string | null,
  activeAccountEmail?: string | null,
): string | undefined {
  const current = selectedMailbox
    ? mailboxes.find((mailbox) => mailbox.id === selectedMailbox)
    : undefined;

  if (current?.isShared && current.accountName?.includes('@')) {
    return current.accountName;
  }

  return activeAccountEmail ?? undefined;
}

/**
 * Restore the identity a draft was composed with from its saved From. A draft
 * stores only the From address+name, not an identityId, so when two identities
 * share an address (a default + an alias with a different display name) the name
 * has to disambiguate - an email-only match picks the wrong one. Falls back to
 * email, then `+tag`-stripped email. Returns null when none match (caller keeps
 * the default).
 */
export function findDraftIdentityId(
  identities: Identity[],
  from?: { email?: string | null; name?: string | null } | null,
): string | null {
  const email = from?.email?.trim();
  if (identities.length === 0 || !email) {
    return null;
  }

  const wantEmail = normalizeEmailAddress(email);
  const wantName = (from?.name ?? '').trim();

  const nameAndEmail = identities.find(
    (i) => normalizeEmailAddress(i.email) === wantEmail && (i.name ?? '').trim() === wantName,
  );
  if (nameAndEmail) {
    return nameAndEmail.id;
  }

  const exact = identities.find((i) => normalizeEmailAddress(i.email) === wantEmail);
  if (exact) {
    return exact.id;
  }

  const wantBase = normalizeBaseEmailAddress(email);
  const base = identities.find((i) => normalizeBaseEmailAddress(i.email) === wantBase);
  return base?.id ?? null;
}

/**
 * How far `resolveReplyFrom` goes when matching received addresses:
 * `exact` stops at the user's configured identities (steps 1-2 below),
 * `domain` also takes the same-domain catch-all step (3), which rewrites
 * `From:` to an address the user has not configured. Deployments where the
 * extra addresses on a domain are distribution lists rather than aliases
 * want `exact` (webmail #1000).
 */
export type ReplyIdentityMatchMode = 'exact' | 'domain';

export interface ReplyFromResolution {
  /** Identity to use for JMAP `identityId` and the SMTP envelope MAIL FROM. */
  identityId: string;
  /**
   * Override for the outgoing `From:` header. Populated when the incoming
   * message was delivered to an address on a domain the user owns (by
   * identity) but that isn't itself a configured identity - typical
   * domain-catch-all deployments. When set, the composer should put this
   * address (and `overrideName`) in the message's From header while sending
   * through the chosen identity.
   */
  overrideEmail?: string;
  overrideName?: string;
}

/**
 * Pick the identity + optional header-From override for replying to a message.
 *
 * Decision order:
 *   1. If a recipient address exactly matches an identity, reply as that
 *      identity with no override.
 *   2. Else if a recipient matches an identity after stripping `+tag`
 *      sub-addressing, reply as that identity with no override.
 *   3. Else if a recipient address is on a domain that one of the identities
 *      uses, treat that recipient as a catch-all alias: return the matching
 *      identity + the recipient as a header-From override. Skipped in
 *      `exact` match mode.
 *   4. Else run steps 1-3 again on the delivery addresses (`deliveredTo`),
 *      so a catch-all alias that only shows up in `Delivered-To` still
 *      becomes the From override (webmail #1353). They come second so a
 *      catch-all address in To/Cc keeps winning over the mailbox it was
 *      delivered to.
 *   5. Else return `null` (caller falls back to primary identity).
 */
export function resolveReplyFrom(
  identities: Identity[],
  recipients?: ReplyRecipients,
  matchMode: ReplyIdentityMatchMode = 'domain',
): ReplyFromResolution | null {
  if (identities.length === 0 || !recipients) {
    return null;
  }

  const inHeaders = [...(recipients.to || []), ...(recipients.cc || []), ...(recipients.bcc || [])]
    .flatMap((r) => {
      const email = r.email?.trim();
      if (!email) return [];
      return [{ email, name: r.name?.trim() || undefined }];
    });
  const delivered = cleanAddresses(recipients.deliveredTo).map((email) => ({ email, name: undefined }));

  return (
    resolveFromAddresses(identities, inHeaders, matchMode) ??
    resolveFromAddresses(identities, delivered, matchMode)
  );
}

function resolveFromAddresses(
  identities: Identity[],
  received: { email: string; name: string | undefined }[],
  matchMode: ReplyIdentityMatchMode,
): ReplyFromResolution | null {
  if (received.length === 0) {
    return null;
  }

  const identityEmails = new Set(identities.map((i) => normalizeEmailAddress(i.email)));
  const identityBaseEmails = new Set(identities.map((i) => normalizeBaseEmailAddress(i.email)));

  const exactIdentity = identities.find((i) =>
    received.some((r) => normalizeEmailAddress(r.email) === normalizeEmailAddress(i.email)),
  );
  if (exactIdentity) {
    return { identityId: exactIdentity.id };
  }

  const baseIdentity = identities.find((i) =>
    received.some((r) => normalizeBaseEmailAddress(r.email) === normalizeBaseEmailAddress(i.email)),
  );
  if (baseIdentity) {
    return { identityId: baseIdentity.id };
  }

  if (matchMode !== 'domain') {
    return null;
  }

  const ownedDomains = new Set(identities.map((i) => domainOf(i.email)).filter(Boolean));

  const catchAll = received.find((r) => {
    const email = normalizeEmailAddress(r.email);
    if (identityEmails.has(email) || identityBaseEmails.has(normalizeBaseEmailAddress(email))) {
      return false;
    }
    return ownedDomains.has(domainOf(email));
  });

  if (catchAll) {
    const anchor = identities.find((i) => domainOf(i.email) === domainOf(catchAll.email)) || identities[0];
    return {
      identityId: anchor.id,
      overrideEmail: catchAll.email,
      overrideName: catchAll.name,
    };
  }

  return null;
}

/**
 * Identity (and optional From override) for a reply or forward:
 *   1. Replying to our own message in a thread (#703): the identity that sent
 *      it. The recipients are the other party's, and on a catch-all domain
 *      they would even become a From override.
 *   2. The own identity in To, Cc or Bcc (`findReplyIdentityId`).
 *      Unconditional: it only ever picks a configured address.
 *   3. With `catchAll`, the same-domain catch-all From override of
 *      `resolveReplyFrom` (To/Cc/Bcc, then the delivery addresses), unless
 *      `matchMode` is `exact`. Callers pass it only for an opted-in reply,
 *      never a forward: a reply continues a thread whose participants know
 *      the addressing, a forward shows the rewritten From to someone new.
 *   4. The own identity the message was delivered to (`deliveredTo`, from
 *      Delivered-To and the like): unconditional, like step 2 (#1353).
 * Null when nothing matches (the caller keeps its default identity).
 */
export function resolveReplyIdentity(
  identities: Identity[],
  original: ReplyRecipients & { from?: ReplyRecipient | null },
  opts: { ownEmails: string[]; catchAll: boolean; matchMode?: ReplyIdentityMatchMode },
): ReplyFromResolution | null {
  if (identities.length === 0) {
    return null;
  }

  const senderEmail = original.from?.email?.trim();
  if (senderEmail && isSelfSent({ from: [{ email: senderEmail }] }, opts.ownEmails)) {
    const senderId = findDraftIdentityId(identities, original.from);
    if (senderId) {
      return { identityId: senderId };
    }
  }

  const recipients = { to: original.to, cc: original.cc, bcc: original.bcc };
  const ownId = findReplyIdentityId(identities, recipients);
  if (ownId) {
    return { identityId: ownId };
  }

  const deliveredTo = original.deliveredTo;
  if (opts.catchAll) {
    const resolved = resolveReplyFrom(identities, { ...recipients, deliveredTo }, opts.matchMode);
    if (resolved) {
      return resolved;
    }
  }

  const deliveredId = findReplyIdentityId(identities, { deliveredTo });
  return deliveredId ? { identityId: deliveredId } : null;
}
