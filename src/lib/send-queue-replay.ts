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
//   positive proof that it was submitted (then completed, and its own draft
//   removed); anything else - no copy, draft-only copies, an incomplete or
//   failed lookup - leaves it `uncertain` for the user to decide in the
//   Outbox, and it is looked at again at most every RECONCILE_BACKOFF_MS;
// - the user's "Send again" looks for proof first (checkSentBeforeResend) and
//   requeues only after a lookup that went through without finding any;
// - an entry whose attempt started less than RECONCILE_GRACE_MS ago is not
//   reconciled yet: the server may still be processing that request;
// - a queued entry that cannot be sent (unreadable schedule, no Sent or no
//   Drafts folder, a JMAP account the session does not serve) is held with a
//   reason the Outbox shows, and skipped until the user's Retry clears it.
// A queue replays only through its own account: entries of another app
// account wait until it is active again (no detached clients).

import { AuthenticationError, jmapClient } from '../api/jmap-client';
import { destroyEmails, getEmailFlags, patchKeywordsForEmails, sendEmail } from '../api/email';
import { RecipientsRejectedError, ScheduleTooLateError, SendRefusedError, type RejectedRecipient } from '../api/jmap-result';
import {
  findCopiesByMessageId,
  findSubmissionsForEmails,
  resolveSendMailboxes,
  type EmailCopy,
} from '../api/sent-lookup';
import { useNetworkStore } from '../stores/network-store';
import { useSendQueueStore, type HeldReason, type QueuedSend } from '../stores/send-queue-store';
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
function postSendEffects(
  entry: QueuedSend,
  refused: RejectedRecipient[] | undefined,
  opts: { toast?: boolean } = {},
): void {
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
  if (opts.toast === false) return;
  try {
    const { t } = useLocaleStore.getState();
    const subject = entry.outgoing.subject || t('email_viewer.no_subject', '(No Subject)');
    toast.success(t('outbox.sent', 'Sent: {subject}', { subject }));
  } catch (err) {
    console.warn('[send-queue] sent toast failed:', err);
  }
}

/** Rescan an `uncertain` entry at most this often; the user's Send again does not wait. */
export const RECONCILE_BACKOFF_MS = 15 * 60 * 1000;

/** The proof lookup could not settle it: it failed, ran out, or the attempt is too young. */
export class ProofLookupError extends Error {
  constructor(message = 'Could not check whether this message was already sent') {
    super(message);
    this.name = 'ProofLookupError';
  }
}

/**
 * What the server says about an `uncertain` entry.
 * - `proven`: our copy is filed in Sent, or a live submission by the entry's
 *   identity holds it; `proofIds` are those emails.
 * - `none`: the lookup went through the whole window without proof.
 * - `incomplete`: it gave up at its cap, or the entry names no sender.
 * Throws when a request fails.
 */
type SendProof = { status: 'proven'; proofIds: string[] } | { status: 'none' } | { status: 'incomplete' };

/**
 * Proof is a copy with the entry's Message-ID whose From includes the
 * entry's sender, and that is either filed in Sent (with or without `$draft`)
 * or the email of a (not canceled) EmailSubmission by the entry's identity. A
 * copy anywhere else is not proof on its own.
 */
async function lookupSendProof(entry: QueuedSend, started: number): Promise<SendProof> {
  const accountId = entry.jmapAccountId;
  // Only the user's own message counts: a copy that merely carries the same
  // Message-ID (an incoming reply quoting it, a reflection, a forgery, a
  // Sieve filing) must never mark a send done that did not happen.
  const ownAddresses = new Set(
    entry.outgoing.from.map((a) => a.email?.trim().toLowerCase()).filter((e): e is string => !!e),
  );
  if (ownAddresses.size === 0) return { status: 'incomplete' };
  const fromUs = (c: EmailCopy) =>
    c.from.some((a) => typeof a?.email === 'string' && ownAddresses.has(a.email.trim().toLowerCase()));

  const { sentId } = await resolveSendMailboxes(accountId);
  const proofIds: string[] = [];
  // Checked page by page, so the lookup goes on past a match that is not proof.
  const isProof = async (matches: EmailCopy[]): Promise<boolean> => {
    const own = matches.filter(fromUs);
    if (own.length === 0) return false;
    if (sentId) {
      const filed = own.filter((c) => c.mailboxIds?.[sentId] === true).map((c) => c.id);
      if (filed.length) {
        proofIds.push(...filed);
        return true;
      }
    }
    const ids = new Set(own.map((c) => c.id));
    const submissions = await findSubmissionsForEmails([...ids], accountId);
    const submitted = submissions
      .filter((s) => ids.has(s.emailId) && s.identityId === entry.identityId && s.undoStatus !== 'canceled')
      .map((s) => s.emailId);
    proofIds.push(...submitted);
    return submitted.length > 0;
  };
  const { proven, complete } = await findCopiesByMessageId(entry.messageId, {
    accountId,
    since: new Date(started - RECONCILE_LOOKBACK_MS).toISOString(),
    isProof,
  });
  if (proven) return { status: 'proven', proofIds };
  return complete ? { status: 'none' } : { status: 'incomplete' };
}

/**
 * Remove the entry's own server draft after its send was proven, as sendEmail
 * does after a send: in the entry's account, only while that account is
 * active, only when that email still carries `$draft`, and never when it is
 * itself the proof. Best effort.
 */
async function removeSentDraft(entry: QueuedSend, proofIds: readonly string[]): Promise<void> {
  const draftId = entry.draftId;
  if (!draftId || proofIds.includes(draftId) || !canReplay(entry.appAccountId)) return;
  try {
    const { list } = await getEmailFlags([draftId], entry.jmapAccountId);
    const draft = list.find((e) => e.id === draftId);
    if (draft?.keywords?.$draft !== true) return;
    // The read was a round trip: the account may have switched since.
    if (!canReplay(entry.appAccountId)) return;
    await destroyEmails([draftId], entry.jmapAccountId);
  } catch (err) {
    console.warn('[send-queue] could not remove the draft of a sent message:', err);
  }
}

/**
 * Complete an entry the server proved was sent. The store allows complete
 * from `queued` too: a "Send again" the user made while a lookup ran must
 * lose to the proof, or the next pass would send the message a second time.
 * Rejects when the entry changed meanwhile (SendQueueStateError).
 */
async function completeOnProof(entry: QueuedSend, proofIds: readonly string[], announce: boolean): Promise<void> {
  await useSendQueueStore.getState().complete(entry.id);
  postSendEffects(entry, undefined, { toast: announce });
  await removeSentDraft(entry, proofIds);
}

type ReconcileResult = 'completed' | 'left';

/** The attempt's start, or null when it cannot be read. */
function attemptStart(entry: QueuedSend): number | null {
  const started = Date.parse(entry.attemptStartedAt ?? entry.createdAt);
  return Number.isNaN(started) ? null : started;
}

/**
 * Settle an `uncertain` entry against the server. Never sends, never
 * requeues: it completes the entry on positive proof of submission (see
 * lookupSendProof) and otherwise leaves it `uncertain`. A lookup runs at most
 * every RECONCILE_BACKOFF_MS per entry.
 */
async function reconcile(entry: QueuedSend): Promise<ReconcileResult> {
  const started = attemptStart(entry);
  if (started === null) return 'left';
  const age = Date.now() - started;
  if (age < RECONCILE_GRACE_MS) {
    scheduleRetry(RECONCILE_GRACE_MS - age);
    return 'left';
  }
  const last = entry.lastReconcileAt ? Date.parse(entry.lastReconcileAt) : NaN;
  if (!Number.isNaN(last) && Date.now() - last < RECONCILE_BACKOFF_MS) return 'left';
  try {
    await useSendQueueStore.getState().noteReconcile(entry.id);
  } catch (err) {
    // Changed meanwhile (completed, requeued, discarded): not this pass's to settle.
    console.warn('[send-queue] could not note the reconcile; skipped:', err);
    return 'left';
  }

  let proof: SendProof;
  try {
    proof = await lookupSendProof(entry, started);
  } catch (err) {
    console.warn('[send-queue] reconciliation inconclusive, left for the user:', err);
    return 'left';
  }
  if (proof.status !== 'proven') return 'left';
  try {
    await completeOnProof(entry, proof.proofIds, true);
  } catch (err) {
    console.warn('[send-queue] complete failed:', err);
    return 'left';
  }
  return 'completed';
}

/**
 * The user's "Send again" on an `uncertain` entry: look for proof first,
 * whatever the backoff. With proof the entry is completed (its draft
 * removed) and this resolves `already_sent`; the caller tells the user. After
 * a lookup that went through the whole window without proof it resolves
 * `not_found` and changes nothing: the caller may requeue. Anything else -
 * a failed or capped lookup, an attempt too young to judge - rejects with
 * ProofLookupError and changes nothing. A complete that the entry no longer
 * allows rejects with SendQueueStateError.
 */
export async function checkSentBeforeResend(entry: QueuedSend): Promise<'already_sent' | 'not_found'> {
  const started = attemptStart(entry);
  if (started === null || Date.now() - started < RECONCILE_GRACE_MS) throw new ProofLookupError();
  let proof: SendProof;
  try {
    proof = await lookupSendProof(entry, started);
  } catch (err) {
    console.warn('[send-queue] proof lookup failed before a resend:', err);
    throw new ProofLookupError();
  }
  if (proof.status === 'incomplete') throw new ProofLookupError();
  if (proof.status === 'none') return 'not_found';
  await completeOnProof(entry, proof.proofIds, false);
  return 'already_sent';
}

/**
 * Mark a queued entry replay cannot send, so the Outbox says why instead of
 * "Waiting for connection". Best effort: a refusal (the entry changed) is fine.
 */
async function holdEntry(entry: QueuedSend, reason: HeldReason): Promise<void> {
  try {
    await useSendQueueStore.getState().hold(entry.id, reason);
  } catch (err) {
    console.warn('[send-queue] could not hold an entry:', err);
  }
}

/** Send one `queued` entry. Returns true when the flush must stop. */
async function sendOne(entry: QueuedSend): Promise<boolean> {
  const store = useSendQueueStore.getState();
  const holdFor = holdForSeconds(entry.sendAt);
  if (holdFor === null) {
    console.warn('[send-queue] unreadable sendAt, not sending', entry.id);
    await holdEntry(entry, 'bad_schedule');
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
  if (!sentId) {
    await holdEntry(entry, 'no_sent');
    return false;
  }
  // Without Drafts, sendEmail would file the copy straight into Sent in the
  // same request as the submission; if the submission were refused and the
  // reply lost, that unsent copy would later read as proof. Never replay so.
  if (!draftsId) {
    console.warn('[send-queue] this account has no Drafts folder; not replaying', entry.id);
    await holdEntry(entry, 'no_drafts');
    return false;
  }
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
    if (!entry || entry.appAccountId !== appId) continue;
    // Held entries wait for the user's Retry.
    if (entry.state === 'queued' && entry.heldReason) continue;
    if (!servesJmapAccount(entry.jmapAccountId)) {
      if (entry.state === 'queued') await holdEntry(entry, 'account_unavailable');
      continue;
    }

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
