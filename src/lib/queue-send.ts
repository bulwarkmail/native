// Pure helpers for queueing a message that is sent while the device is known
// to be offline. Both the composer and the quick reply box use them.
import type { OutgoingEmail } from '../api/email';
import type { QueuedSend } from '../stores/send-queue-store';

/**
 * True only when the device is known to be offline at the moment of sending
 * and every attachment has a blob id. Never true after a request was made:
 * callers evaluate it before any request, so a network error during an online
 * send is never auto-queued.
 */
export function shouldQueueSend(params: { online: boolean; uploadsDone: boolean }): boolean {
  return params.online === false && params.uploadsDone;
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
  replyTo?: { emailIds: string[]; keyword: '$answered' | '$forwarded' };
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
