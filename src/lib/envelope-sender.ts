// The SMTP envelope sender for a From override (webmail #1009). The override
// is asked for as MAIL FROM so the Return-Path does not reveal the identity's
// address; a server that only accepts the identity's own address there gets
// that once instead (see sendEmail).

import type { Identity } from '../api/types';

const normalize = (email: string | null | undefined): string => (email ?? '').trim().toLowerCase();

/** A wildcard identity ("*@example.com", RFC 8621 §6) names no concrete address. */
const isWildcard = (identity: Identity): boolean => identity.email.includes('*');

/** The identity of the account whose own address the override is, if any. */
function owningIdentity(identities: readonly Identity[], selected: Identity, overrideEmail: string): Identity | undefined {
  if (!overrideEmail) return undefined;
  if (normalize(selected.email) === overrideEmail) return selected;
  return identities.find((identity) => !isWildcard(identity) && normalize(identity.email) === overrideEmail);
}

/**
 * The identity a send goes through: the one that owns the override address,
 * so the server accepts it as the envelope sender, else the selected one.
 * Its id must reach both sendEmail and the queued row, so an uncertain send
 * can still be proven by its submission.
 */
export function pickSubmissionIdentity(
  identities: readonly Identity[],
  selected: Identity,
  overrideEmail: string | null | undefined,
): Identity {
  return owningIdentity(identities, selected, normalize(overrideEmail)) ?? selected;
}

/**
 * The address a server refusing the override as MAIL FROM gets instead (and
 * so shows in the Return-Path), for the From row's notice. Null when there is
 * no override, an identity owns it, or the identity is a wildcard (the server
 * then derives MAIL FROM from the header From itself).
 */
export function envelopeFallbackIdentity(
  identities: readonly Identity[],
  selected: Identity,
  overrideEmail: string | null | undefined,
): string | null {
  const override = normalize(overrideEmail);
  if (!override || owningIdentity(identities, selected, override) || isWildcard(selected)) return null;
  return selected.email;
}

/** The OutgoingEmail envelope fields for a From override. */
export function overrideEnvelope(
  identities: readonly Identity[],
  selected: Identity,
  overrideEmail: string,
): { envelopeMailFrom?: string; envelopeFallbackMailFrom?: string } {
  const requested = overrideEmail.trim();
  // Sent through the identity that owns it: the server derives MAIL FROM.
  if (!requested || owningIdentity(identities, selected, normalize(requested))) return {};
  const fallback = envelopeFallbackIdentity(identities, selected, requested);
  return fallback ? { envelopeMailFrom: requested, envelopeFallbackMailFrom: fallback } : { envelopeMailFrom: requested };
}
