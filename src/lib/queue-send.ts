// Pure helpers for queueing a message that is sent while the device is known
// to be offline. Both the composer and the quick reply box use them.
import type { OutgoingEmail } from '../api/email';
import { stripMessageIdBrackets, useSendQueueStore, type QueuedSend } from '../stores/send-queue-store';

/**
 * True only when the device is known to be offline at the moment of sending
 * and every attachment has a blob id. Never true after a request was made:
 * callers evaluate it before any request, so a network error during an online
 * send is never auto-queued.
 */
export function shouldQueueSend(params: { online: boolean; uploadsDone: boolean }): boolean {
  return params.online === false && params.uploadsDone;
}

/** A queued entry needs both accounts; an empty JMAP account id cannot be replayed. */
export function hasQueueAccounts(appAccountId: string | null | undefined, jmapAccountId: string | null | undefined): boolean {
  return !!appAccountId && !!jmapAccountId;
}

/** Every attachment of `outgoing` carries a blob id. */
export function attachmentsUploaded(outgoing: OutgoingEmail): boolean {
  return (outgoing.attachments ?? []).every((a) => !!a.blobId);
}

export interface BuildQueuedSendParams {
  /** Entry id; must match /^[A-Za-z0-9_-]+$/ (a uuid does). */
  id: string;
  /** The composer's owner, not the active account. */
  appAccountId: string;
  jmapAccountId: string;
  identityId: string;
  outgoing: OutgoingEmail;
  draftId?: string | null;
  /** The user's chosen schedule; stored as an absolute ISO time. */
  scheduledAt?: Date;
  replyTo?: { emailIds: string[]; keyword: '$answered' | '$forwarded'; jmapAccountId?: string };
  now?: Date;
}

/** The queue entry for a send; the undo-send hold is deliberately not recorded. */
export function buildQueuedSend(p: BuildQueuedSendParams): Omit<QueuedSend, 'messageId'> {
  const entry: Omit<QueuedSend, 'messageId'> = {
    id: p.id,
    appAccountId: p.appAccountId,
    jmapAccountId: p.jmapAccountId,
    identityId: p.identityId,
    outgoing: p.outgoing,
    createdAt: (p.now ?? new Date()).toISOString(),
    state: 'queued',
  };
  if (p.draftId) entry.draftId = p.draftId;
  if (p.scheduledAt) entry.sendAt = p.scheduledAt.toISOString();
  if (p.replyTo && p.replyTo.emailIds.length) entry.replyTo = p.replyTo;
  return entry;
}

export interface ComposerRefs {
  /** The composer's Message-ID (messageIdRef). */
  messageId?: string | null;
  /** The composer's server draft (draftIdRef). */
  draftId?: string | null;
}

/**
 * The Outbox entry, in any state, that holds this message: same Message-ID,
 * or same server draft. Sending it again would send it twice.
 */
export function queuedEntryFor(entries: readonly QueuedSend[], refs: ComposerRefs): QueuedSend | undefined {
  const mid = refs.messageId ? stripMessageIdBrackets(refs.messageId) : '';
  const draftId = refs.draftId || '';
  if (!mid && !draftId) return undefined;
  return entries.find((e) => (!!mid && e.messageId === mid) || (!!draftId && e.draftId === draftId));
}

/** The Outbox could not be read, so whether this message is already queued is unknown. */
export class OutboxCheckError extends Error {
  constructor(readonly cause: unknown) {
    super('Could not check the Outbox');
    this.name = 'OutboxCheckError';
  }
}

/**
 * The guard the composer and the quick reply run before any send, online or
 * queued. The owner account is hydrated first so a row an earlier run left
 * counts; when hydration fails (storage error) it throws OutboxCheckError
 * rather than let a send through that the queue may already hold.
 */
export async function findAlreadyQueued(ownerAppAccountId: string | null | undefined, refs: ComposerRefs): Promise<QueuedSend | undefined> {
  const store = useSendQueueStore.getState();
  if (ownerAppAccountId && !store.hydrated[ownerAppAccountId]) {
    try {
      await store.hydrateAccount(ownerAppAccountId);
    } catch (err) {
      // An unread queue may hold this very message; sending now could send
      // it twice once the queue loads. Refuse instead of guessing.
      throw new OutboxCheckError(err);
    }
  }
  return queuedEntryFor(Object.values(useSendQueueStore.getState().entries).flat(), refs);
}

/**
 * The quick reply's owner (the viewer's account) is the active one in the auth
 * store and the one the app shows: during a switch they differ, and the box may
 * have remounted showing another account while its message is the owner's.
 */
export function quickReplyOwnerActive(
  owner: string | null | undefined,
  authActive: string | null | undefined,
  shownActive: string | null | undefined,
): boolean {
  return ownerStillActive(owner, authActive) && ownerStillActive(owner, shownActive);
}

/** The quick reply's owner (the app account active at mount) is still the active one. */
export function ownerStillActive(ownerAtMount: string | null | undefined, activeNow: string | null | undefined): boolean {
  return !!ownerAtMount && ownerAtMount === activeNow;
}
