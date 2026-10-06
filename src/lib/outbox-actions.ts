// What the Outbox buttons do. The store's state machine is the authority
// (requeue only from failed/uncertain, discard never from sending); these
// helpers add the account guards the store cannot know about.
import { createDraft } from '../api/email';
import { resolveSendMailboxes } from '../api/sent-lookup';
import { useAccountStore } from '../stores/account-store';
import { useSendQueueStore, SendQueueStateError, type QueuedSend } from '../stores/send-queue-store';
import { clientServesActiveAccount } from './active-client-account';
import { generateUUID } from './uuid';
import { checkSentBeforeResend, flushSendQueue, ProofLookupError, ResendTooRecentError } from './send-queue-replay';

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

/** The row state an action was offered for: `held` is a queued entry replay holds. */
export type RetryFrom = 'failed' | 'uncertain' | 'held';

function liveMatches(live: QueuedSend | undefined, expected: RetryFrom): live is QueuedSend {
  if (!live) return false;
  if (expected === 'held') return live.state === 'queued' && !!live.heldReason;
  return live.state === expected;
}

/**
 * Retry (failed or held) or Send again (uncertain, after the user confirmed):
 * requeue, then replay. Refuses unless the live entry is still in
 * `expectedState`, so a stale row cannot requeue an uncertain entry without
 * its confirmation.
 */
export async function requeueAndFlush(entry: QueuedSend, expectedState: RetryFrom): Promise<void> {
  requireActive(entry);
  const live = (useSendQueueStore.getState().entries[entry.appAccountId] ?? []).find((e) => e.id === entry.id);
  if (!liveMatches(live, expectedState)) throw new OutboxActionError('This message changed. Check the Outbox.');
  await useSendQueueStore.getState().requeue(entry.id);
  await flushSendQueue();
}

/**
 * Send again (uncertain, after the user confirmed). Looks for proof that it
 * went out first: with proof the entry is completed and this resolves
 * `already_sent` (the caller says so); only after a lookup that went through
 * without proof is it requeued and replayed (`requeued`). A failed or
 * inconclusive lookup changes nothing: OutboxActionError('proof_check_failed').
 * Within a couple of minutes of the attempt nothing is checked or changed:
 * OutboxActionError('too_recent').
 */
export async function sendAgain(entry: QueuedSend): Promise<'already_sent' | 'requeued'> {
  requireActive(entry);
  const live = (useSendQueueStore.getState().entries[entry.appAccountId] ?? []).find((e) => e.id === entry.id);
  if (!liveMatches(live, 'uncertain')) throw new OutboxActionError('This message changed. Check the Outbox.');
  let outcome: 'already_sent' | 'not_found';
  try {
    outcome = await checkSentBeforeResend(live);
  } catch (err) {
    if (err instanceof ResendTooRecentError) {
      throw new OutboxActionError('This message was sent moments ago', 'too_recent');
    }
    if (err instanceof ProofLookupError) {
      throw new OutboxActionError('Could not check whether this message was already sent', 'proof_check_failed');
    }
    throw err;
  }
  if (outcome === 'already_sent') return 'already_sent';
  // Re-checks the account and that the entry is still uncertain.
  await requeueAndFlush(live, 'uncertain');
  return 'requeued';
}

/**
 * Save the message as a server draft in the entry's own account. The entry is
 * discarded FIRST: a flush may be about to send it, and a draft kept next to
 * a sent message is worse than a refused action. If discard rejects (sending
 * or gone) nothing is created. If the account changed before the draft is
 * written, nothing is written and the entry goes back as it was
 * (OutboxActionError('wrong_account')). If creating the draft fails, the
 * captured entry goes back into the Outbox under a fresh id as `failed` with
 * that error (same Message-ID), never as `queued`, and the error is
 * OutboxActionError('draft_failed_restored').
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
    // Re-checked right before the write: a switch can land during the lookup.
    // Nothing was written, so the entry goes back as it was.
    try {
      requireActive(captured);
    } catch (switched) {
      await restoreCaptured(captured, captured.state, captured.lastError);
      throw switched;
    }
    // Replaces the entry's own server draft the way the composer's autosave does.
    await createDraft(captured.outgoing, draftsId, captured.draftId, captured.jmapAccountId);
  } catch (err) {
    if (err instanceof OutboxActionError) throw err;
    // Back as `failed`, never `queued`: the draft may have been created after
    // all (a lost reply), and a queued entry would then be sent on its own.
    await restoreCaptured(captured, 'failed', err instanceof Error && err.message ? err.message : String(err));
    throw new OutboxActionError('The draft could not be saved. The message is back in the Outbox.', 'draft_failed_restored');
  }
}

/** Put a discarded entry back under a fresh id (same Message-ID); OutboxActionError('draft_lost') if that fails. */
async function restoreCaptured(captured: QueuedSend, state: QueuedSend['state'], lastError: string | undefined): Promise<void> {
  const { messageId: _derived, lastError: _e, heldReason, ...rest } = captured;
  const back: Omit<QueuedSend, 'messageId'> = { ...rest, id: generateUUID(), state };
  if (lastError) back.lastError = lastError;
  // A hold belongs to a queued entry only.
  if (heldReason && state === 'queued') back.heldReason = heldReason;
  try {
    await useSendQueueStore.getState().enqueue(back);
  } catch {
    throw new OutboxActionError('The draft could not be saved and the message could not be restored', 'draft_lost');
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
      case 'too_recent': return {
        key: 'outbox.error.too_recent',
        fallback: 'This message was sent moments ago. Wait a minute, then check Sent before sending it again.',
      };
      case 'proof_check_failed': return {
        key: 'outbox.error.proof_check_failed',
        fallback: 'Could not check whether this message was already sent. Nothing was sent. Try again later.',
      };
      default: return { key: 'outbox.error.changed', fallback: 'This message changed. Check the Outbox.' };
    }
  }
  if (err instanceof SendQueueStateError) {
    return { key: 'outbox.error.changed', fallback: 'This message changed. Check the Outbox.' };
  }
  return { raw: err instanceof Error ? err.message : String(err) };
}
