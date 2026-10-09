// Re-stamping a held send onto the session's current primary account.
//
// A queued send names the JMAP account it was written in. When the server
// renumbers that account (a migration, a restore), the session stops serving
// the old id and replay holds the entry `account_unavailable` for good. This
// says when it is safe to move it onto the primary instead, so it goes out
// without the user retyping it. The send-queue rules still hold:
// - never sent twice: only an entry that was never attempted (no request
//   for it was ever made) moves, and the send itself still goes through
//   markSending;
// - never from the wrong account: the primary must hold an identity with the
//   entry's identity id and the address the message is from (identity ids
//   collide across accounts, so the id alone proves nothing);
// - JMAP ids of the old account mean nothing on the new one: an entry with
//   attachments (blob ids) stays held, and the store drops the draft and the
//   replied-to ids when it re-stamps.
// Pure: no store, no network.

import type { Identity } from '../api/types';
import type { QueuedSend } from '../stores/send-queue-store';

/**
 * The entry is one a re-stamp may move: queued, held account_unavailable,
 * never attempted and no attachments. "Never attempted" is the lasting
 * `everAttempted` marker, not only `attemptStartedAt`: the user's Retry
 * (requeue) clears that and `lastError`, and an entry that was sent once,
 * failed or went uncertain and came back must never be moved to another
 * account. `lastError` is checked too, for rows stored before the marker.
 */
export function mayRestamp(entry: QueuedSend): boolean {
  return entry.state === 'queued'
    && entry.heldReason === 'account_unavailable'
    && !entry.attemptStartedAt
    && !entry.everAttempted
    && !entry.lastError
    && !(entry.outgoing.attachments?.length);
}

function normalizedAddress(email: string | undefined): string {
  return (email ?? '').trim().toLowerCase();
}

/**
 * The JMAP account to re-stamp `entry` onto, or null to leave it held.
 *
 * What this cannot tell apart: an unserved id is either the user's own
 * account renumbered, or a shared account whose access was revoked. In the
 * second case the message goes out from the primary instead of the shared
 * account. That is only allowed because the primary holds the very identity
 * (id and address) the message is from, so it is sent as the user, from an
 * address the user may send from; it never goes out as somebody else. Only
 * the live primary, only when the session does not serve the entry's own
 * account (releaseHold covers that), and only when the primary's identities
 * hold the entry's identity id with the address the message is from.
 */
export function restampTarget(
  entry: QueuedSend,
  live: { primaryId: string | null; servesEntryAccount: boolean; identities: readonly Identity[] },
): string | null {
  const { primaryId } = live;
  if (!primaryId || live.servesEntryAccount || primaryId === entry.jmapAccountId) return null;
  if (!mayRestamp(entry)) return null;
  const from = normalizedAddress(entry.outgoing.from?.[0]?.email);
  if (!from) return null;
  const identity = live.identities.find((i) => i.id === entry.identityId);
  if (!identity || normalizedAddress(identity.email) !== from) return null;
  return primaryId;
}
