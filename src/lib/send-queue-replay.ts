// Replays the offline send queue once the connection is back, and settles any
// send whose outcome is unknown before it is ever sent again.
//
// The rule above all others: a message is never sent twice. So
// - an entry is sent only after `markSending` resolved (persisted, and won the
//   compare-and-set); a rejection means it is not sent;
// - only a refusal that proves the server did not submit the message makes an
//   entry `failed`; any other error, including ones this code does not know,
//   makes it `uncertain`;
// - right after markSending, the account is checked again; if it changed,
//   the entry goes back to `queued` (releaseUnsent) without a request;
// - reconciliation never resends. An `uncertain` entry is resolved only on
//   positive proof that it was submitted (then completed); anything else -
//   no copy, draft-only copies, an incomplete or failed lookup - leaves it
//   `uncertain` for the user to decide in the Outbox;
// - an entry whose attempt started less than RECONCILE_GRACE_MS ago is not
//   reconciled yet: the server may still be processing that request.
// A queue replays only through its own account: entries of another app
// account wait until it is active again (no detached clients).

import { AuthenticationError, jmapClient } from '../api/jmap-client';
import { patchKeywordsForEmails, sendEmail } from '../api/email';
import { RecipientsRejectedError, ScheduleTooLateError, SendRefusedError, type RejectedRecipient } from '../api/jmap-result';
import { findCopiesByMessageId, findSubmissionsForEmails, resolveSendMailboxes } from '../api/sent-lookup';
import { useNetworkStore } from '../stores/network-store';
import { useSendQueueStore, type QueuedSend } from '../stores/send-queue-store';
import { useLocaleStore } from '../stores/locale-store';
import { toast } from '../stores/toast-store';
import { activeAppAccountId, clientServesActiveAccount } from './active-client-account';
import { trustRecipients, trustedSendersBookSyncOn } from './trust-recipients';

/** How far before the attempt the copy lookup starts (generous: device clocks drift). */
export const RECONCILE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;
/** An attempt younger than this is not reconciled yet: the server may still be on it. */
export const RECONCILE_GRACE_MS = 2 * 60 * 1000;

export type SendErrorOutcome = 'failed' | 'uncertain' | 'auth';

/**
 * What a `sendEmail` error proves.
 * - `failed`: the server answered and refused before creating a submission
 *   (method error or SetError: `SendRefusedError`), refused every recipient
 *   (`RecipientsRejectedError`, the copy is removed and nothing left), or
 *   refused the hold (`ScheduleTooLateError`).
 * - `auth`: `AuthenticationError` (the entry is released back to `queued`). sendEmail can only raise it from its one
 *   send request (a 401, or a token refresh before or after a 401), i.e.
 *   before the server ran any method; the clean-ups after the response
 *   swallow their errors.
 * - `uncertain`: everything else - NetworkError, a TypeError from fetch,
 *   RequestTimeoutError, SendUnconfirmedError, RateLimitError, an HTTP error
 *   or unparsable reply, and any error class not listed here.
 */
export function classifySendError(err: unknown): SendErrorOutcome {
  if (err instanceof SendRefusedError || err instanceof RecipientsRejectedError || err instanceof ScheduleTooLateError) {
    return 'failed';
  }
  if (err instanceof AuthenticationError) return 'auth';
  return 'uncertain';
}

function errorText(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return typeof err === 'string' && err ? err : 'Unknown error';
}

/** Online, connected, and the client serves the app account `appId`, which is active. */
function canReplay(appId: string): boolean {
  return useNetworkStore.getState().online
    && jmapClient.isConnected
    && clientServesActiveAccount()
    && activeAppAccountId() === appId;
}

/** Whether the connected session can submit for this JMAP account. */
function servesJmapAccount(jmapAccountId: string): boolean {
  try {
    if (jmapClient.accountId === jmapAccountId) return true;
  } catch {
    return false;
  }
  try {
    return jmapClient.getSubmissionAccountIds().includes(jmapAccountId);
  } catch {
    return false;
  }
}

function liveEntry(appId: string, id: string): QueuedSend | undefined {
  return (useSendQueueStore.getState().entries[appId] ?? []).find((e) => e.id === id);
}

/** Seconds to hold a scheduled send; 0 for a past or absent `sendAt`, null when unreadable. */
function holdForSeconds(sendAt: string | undefined): number | null {
  if (!sendAt) return 0;
  const at = Date.parse(sendAt);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryAt = Infinity;

/** Flush again once a young uncertain attempt is old enough to reconcile. */
function scheduleRetry(delayMs: number): void {
  const at = Date.now() + Math.max(1000, delayMs);
  if (retryTimer && retryAt <= at) return;
  if (retryTimer) clearTimeout(retryTimer);
  retryAt = at;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryAt = Infinity;
    void flushSendQueue();
  }, at - Date.now());
  (retryTimer as { unref?: () => void }).unref?.();
}

/** Flag the original, trust the recipients, tell the user. Best effort; never changes the outcome. */
function postSendEffects(entry: QueuedSend, refused: RejectedRecipient[] | undefined): void {
  const ownerActive = canReplay(entry.appAccountId);
  try {
    const reply = entry.replyTo;
    if (reply?.emailIds?.length && ownerActive) {
      // The original may sit in another account (a shared folder) than the send.
      void patchKeywordsForEmails(reply.emailIds, { [reply.keyword]: true }, reply.jmapAccountId ?? entry.jmapAccountId)
        .catch((err) => console.warn('[send-queue] reply flag failed:', err));
    }
  } catch (err) {
    console.warn('[send-queue] reply flag failed:', err);
  }
  try {
    // People you reply to are people you trust; a forward is not a reply.
    if (entry.replyTo?.keyword === '$answered') {
      trustRecipients([...entry.outgoing.to, ...(entry.outgoing.cc ?? [])], refused, {
        syncToBook: ownerActive && trustedSendersBookSyncOn(),
      });
    }
  } catch (err) {
    console.warn('[send-queue] trusting recipients failed:', err);
  }
  try {
    const { t } = useLocaleStore.getState();
    const subject = entry.outgoing.subject || t('email_viewer.no_subject', '(No Subject)');
    toast.success(t('outbox.sent', 'Sent: {subject}', { subject }));
  } catch (err) {
    console.warn('[send-queue] sent toast failed:', err);
  }
}

type ReconcileResult = 'completed' | 'left';

/**
 * Settle an `uncertain` entry against the server. Never sends, never
 * requeues, never destroys: it completes the entry on positive proof of
 * submission and otherwise leaves it `uncertain`. Proof is a copy with the
 * entry's Message-ID that is not `$draft` (anywhere in the account), a
 * `$draft` copy filed in Sent, or a (not canceled) EmailSubmission of one of
 * the matching copies.
 */
async function reconcile(entry: QueuedSend): Promise<ReconcileResult> {
  const accountId = entry.jmapAccountId;
  const started = Date.parse(entry.attemptStartedAt ?? entry.createdAt);
  if (Number.isNaN(started)) return 'left';
  const age = Date.now() - started;
  if (age < RECONCILE_GRACE_MS) {
    scheduleRetry(RECONCILE_GRACE_MS - age);
    return 'left';
  }

  let submitted = false;
  try {
    const { sentId } = await resolveSendMailboxes(accountId);
    const { copies } = await findCopiesByMessageId(entry.messageId, {
      accountId,
      since: new Date(started - RECONCILE_LOOKBACK_MS).toISOString(),
    });
    const isDraft = (c: { keywords: Record<string, boolean> }) => c.keywords?.$draft === true;
    // Positive proof only; an incomplete lookup can still yield it.
    submitted = copies.some((c) => !isDraft(c) || (!!sentId && c.mailboxIds?.[sentId] === true));
    if (!submitted && copies.length) {
      const ids = new Set(copies.map((c) => c.id));
      const submissions = await findSubmissionsForEmails([...ids], accountId);
      submitted = submissions.some((s) => ids.has(s.emailId) && s.undoStatus !== 'canceled');
    }
  } catch (err) {
    console.warn('[send-queue] reconciliation inconclusive, left for the user:', err);
    return 'left';
  }
  if (!submitted) return 'left';

  try {
    await useSendQueueStore.getState().complete(entry.id);
  } catch (err) {
    console.warn('[send-queue] complete failed:', err);
    return 'left';
  }
  postSendEffects(entry, undefined);
  return 'completed';
}

/** Send one `queued` entry. Returns true when the flush must stop. */
async function sendOne(entry: QueuedSend): Promise<boolean> {
  const store = useSendQueueStore.getState();
  const holdFor = holdForSeconds(entry.sendAt);
  if (holdFor === null) {
    console.warn('[send-queue] unreadable sendAt, not sending', entry.id);
    return false;
  }
  let sentId: string | undefined;
  let draftsId: string | undefined;
  try {
    ({ sentId, draftsId } = await resolveSendMailboxes(entry.jmapAccountId));
  } catch (err) {
    console.warn('[send-queue] could not resolve Sent, stopping:', err);
    return true;
  }
  if (!sentId) return false;
  if (!canReplay(entry.appAccountId)) return true;

  try {
    await store.markSending(entry.id);
  } catch (err) {
    // Not persisted, or another caller won: this caller does not send it.
    console.warn('[send-queue] markSending refused, not sending:', err);
    return false;
  }
  // The account may have switched while `sending` was being persisted.
  if (!canReplay(entry.appAccountId) || !servesJmapAccount(entry.jmapAccountId)) {
    try {
      await store.releaseUnsent(entry.id);
    } catch (err) {
      // Stays `sending` (skipped); the next launch reconciles it.
      console.warn('[send-queue] could not release an unsent entry:', err);
    }
    return true;
  }

  let result: Awaited<ReturnType<typeof sendEmail>>;
  try {
    result = await sendEmail(entry.outgoing, entry.identityId, sentId, holdFor, {
      draftsMailboxId: draftsId,
      draftId: entry.draftId,
      accountId: entry.jmapAccountId,
    });
  } catch (err) {
    const outcome = classifySendError(err);
    const message = errorText(err);
    try {
      if (outcome === 'failed') await store.markFailed(entry.id, message);
      else if (outcome === 'auth') await store.releaseUnsent(entry.id);
      else await store.markUncertain(entry.id, message);
    } catch (writeErr) {
      // The entry stays `sending`; the next launch turns that into `uncertain`.
      console.warn('[send-queue] could not record the send outcome:', writeErr);
    }
    return outcome === 'auth';
  }

  if (result.filingWarning) console.warn('[send-queue] post-send filing warning:', result.filingWarning);
  try {
    await store.complete(entry.id);
  } catch (err) {
    // Left `sending` (skipped by later flushes); the next launch reconciles it.
    console.warn('[send-queue] could not complete a sent entry:', err);
  }
  postSendEffects(entry, result.rejectedRecipients);
  return false;
}

async function flushOnce(): Promise<'done' | 'stopped'> {
  if (!useNetworkStore.getState().online || !jmapClient.isConnected || !clientServesActiveAccount()) return 'done';
  const appId = activeAppAccountId();
  if (!appId) return 'done';

  const store = useSendQueueStore.getState();
  if (!store.hydrated[appId]) {
    try {
      await store.hydrateAccount(appId);
    } catch (err) {
      console.warn('[send-queue] hydrate failed:', err);
      return 'done';
    }
  }
  if (!canReplay(appId)) return 'done';

  // Each entry is visited once per pass, so one made uncertain in this pass is
  // not reconciled in it; a later pass waits out RECONCILE_GRACE_MS.
  const ordered = [...(useSendQueueStore.getState().entries[appId] ?? [])]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  for (const snapshot of ordered) {
    if (!canReplay(appId)) return 'stopped';
    const entry = liveEntry(appId, snapshot.id);
    if (!entry || entry.appAccountId !== appId || !servesJmapAccount(entry.jmapAccountId)) continue;

    if (entry.state === 'uncertain') {
      await reconcile(entry);
      continue;
    }
    // `failed` waits for the user; `sending` belongs to an attempt in progress.
    if (entry.state !== 'queued') continue;
    if (await sendOne(entry)) return 'stopped';
  }
  return 'done';
}

/** The flush preconditions for whatever account is active now. */
function flushPossible(): boolean {
  const appId = activeAppAccountId();
  return !!appId && canReplay(appId);
}

let running: Promise<void> | null = null;
let rerun = false;

/**
 * Replay the active account's send queue. One flush at a time: a call made
 * while one runs asks it for another pass and shares its promise. Never
 * rejects.
 */
export function flushSendQueue(): Promise<void> {
  if (running) {
    rerun = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        rerun = false;
        try {
          // A stopped pass still honours a rerun asked for meanwhile, as long
          // as a flush could run now; otherwise the next trigger runs it.
          if ((await flushOnce()) === 'stopped' && !(rerun && flushPossible())) break;
        } catch (err) {
          console.warn('[send-queue] flush failed:', err);
          break;
        }
      } while (rerun);
    } finally {
      rerun = false;
      running = null;
    }
  })();
  return running;
}

/**
 * True when `next` holds an entry id `prev` did not (an enqueue or a hydrate).
 * Used to flush right after an enqueue; state changes of known entries (a
 * requeue after an auth error, say) never count, so they cannot loop.
 */
export function hasNewEntry(
  next: Record<string, QueuedSend[]>,
  prev: Record<string, QueuedSend[]>,
): boolean {
  if (next === prev) return false;
  const known = new Set<string>();
  for (const list of Object.values(prev)) for (const e of list) known.add(e.id);
  return Object.values(next).some((list) => list.some((e) => !known.has(e.id)));
}
