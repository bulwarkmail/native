// What the Outbox buttons do. The store's state machine is the authority
// (requeue only from failed/uncertain, discard never from sending); these
// helpers add the account guards the store cannot know about.
import { createDraft } from '../api/email';
import { resolveSendMailboxes } from '../api/sent-lookup';
import { useAccountStore } from '../stores/account-store';
import { useSendQueueStore, SendQueueStateError, type QueuedSend } from '../stores/send-queue-store';
import { clientServesActiveAccount } from './active-client-account';
import { generateUUID } from './uuid';
import { flushSendQueue } from './send-queue-replay';

export class OutboxActionError extends Error {
  constructor(message: string, readonly code: string = 'changed') {
    super(message);
    this.name = 'OutboxActionError';
  }
}

function requireActive(entry: QueuedSend): void {
  if (useAccountStore.getState().activeAccountId !== entry.appAccountId || !clientServesActiveAccount()) {
    throw new OutboxActionError('Switch to the sending account first', 'wrong_account');
  }
}

/**
 * Retry (failed) or Send again (uncertain, after the user confirmed): requeue,
 * then replay. Refuses unless the live entry is still in `expectedState`, so
 * a stale row cannot requeue an uncertain entry without its confirmation.
 */
export async function requeueAndFlush(entry: QueuedSend, expectedState: 'failed' | 'uncertain'): Promise<void> {
  requireActive(entry);
  const live = (useSendQueueStore.getState().entries[entry.appAccountId] ?? []).find((e) => e.id === entry.id);
  if (!live || live.state !== expectedState) throw new OutboxActionError('This message changed. Check the Outbox.');
  await useSendQueueStore.getState().requeue(entry.id);
  await flushSendQueue();
}

/**
 * Save the message as a server draft in the entry's own account. The entry is
 * discarded FIRST: a flush may be about to send it, and a draft kept next to
 * a sent message is worse than a refused action. If discard rejects (sending
 * or gone) nothing is created. If creating the draft then fails, the captured
 * entry goes back into the Outbox under a fresh id (same state, same
 * Message-ID) and the error is OutboxActionError('draft_failed_restored').
 */
export async function saveEntryAsDraft(entry: QueuedSend): Promise<void> {
  requireActive(entry);
  const live = (useSendQueueStore.getState().entries[entry.appAccountId] ?? []).find((e) => e.id === entry.id);
  if (!live || live.state === 'sending') throw new OutboxActionError('This message is being sent', 'sending');
  const captured: QueuedSend = { ...live };
  try {
    await useSendQueueStore.getState().discard(captured.id);
  } catch {
    throw new OutboxActionError('This message is being sent', 'sending');
  }
  try {
    const { draftsId } = await resolveSendMailboxes(captured.jmapAccountId);
    if (!draftsId) throw new Error('No Drafts folder');
    // Replaces the entry's own server draft the way the composer's autosave does.
    await createDraft(captured.outgoing, draftsId, captured.draftId, captured.jmapAccountId);
  } catch {
    const { messageId: _derived, ...rest } = captured;
    try {
      await useSendQueueStore.getState().enqueue({ ...rest, id: generateUUID() });
    } catch {
      throw new OutboxActionError('The draft could not be saved and the message could not be restored', 'draft_lost');
    }
    throw new OutboxActionError('The draft could not be saved. The message is back in the Outbox.', 'draft_failed_restored');
  }
}

export interface OutboxMessage { key: string; fallback: string }

/** Localizable text for an action error. */
export function outboxErrorMessage(err: unknown): OutboxMessage | { raw: string } {
  if (err instanceof OutboxActionError) {
    switch (err.code) {
      case 'sending': return { key: 'outbox.error.sending', fallback: 'This message is being sent.' };
      case 'draft_failed_restored': return { key: 'outbox.error.draft_restored', fallback: 'The draft could not be saved. The message is back in the Outbox.' };
      case 'draft_lost': return { key: 'outbox.error.draft_lost', fallback: 'The draft could not be saved and the message could not be restored.' };
      case 'wrong_account': return { key: 'outbox.error.wrong_account', fallback: 'Switch to the sending account first.' };
      default: return { key: 'outbox.error.changed', fallback: 'This message changed. Check the Outbox.' };
    }
  }
  if (err instanceof SendQueueStateError) {
    return { key: 'outbox.error.changed', fallback: 'This message changed. Check the Outbox.' };
  }
  return { raw: err instanceof Error ? err.message : String(err) };
}
