// What the Outbox buttons do. The store's state machine is the authority
// (requeue only from failed/uncertain, discard never from sending); these
// helpers add the account guards the store cannot know about.
import { createDraft } from '../api/email';
import { resolveSendMailboxes } from '../api/sent-lookup';
import { useAccountStore } from '../stores/account-store';
import { useSendQueueStore, type QueuedSend } from '../stores/send-queue-store';
import { clientServesActiveAccount } from './active-client-account';
import { flushSendQueue } from './send-queue-replay';

export class OutboxActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutboxActionError';
  }
}

function requireActive(entry: QueuedSend): void {
  if (useAccountStore.getState().activeAccountId !== entry.appAccountId || !clientServesActiveAccount()) {
    throw new OutboxActionError('Switch to the sending account first');
  }
}

/** Retry (failed) or Send again (uncertain, after the user confirmed): requeue, then replay. */
export async function requeueAndFlush(entry: QueuedSend): Promise<void> {
  requireActive(entry);
  await useSendQueueStore.getState().requeue(entry.id);
  await flushSendQueue();
}

/**
 * Save the message as a server draft in the entry's own account, then drop
 * the entry. Refuses unless the entry is still queued/failed/uncertain.
 */
export async function saveEntryAsDraft(entry: QueuedSend): Promise<void> {
  requireActive(entry);
  const live = (useSendQueueStore.getState().entries[entry.appAccountId] ?? []).find((e) => e.id === entry.id);
  if (!live || live.state === 'sending') throw new OutboxActionError('This message is being sent');
  const { draftsId } = await resolveSendMailboxes(live.jmapAccountId);
  if (!draftsId) throw new OutboxActionError('No Drafts folder');
  await createDraft(live.outgoing, draftsId, undefined, live.jmapAccountId);
  await useSendQueueStore.getState().discard(live.id);
}
