// The offline send queue's state machine (parity 04/09/10 "offline send").
//
// The webmail has no offline outbox: an offline send says so and keeps the
// composer open (email-composer.tsx, `send_offline`). On a phone the natural
// behaviour is to queue the message and send it once the connection is back,
// so the app keeps queued messages next to its mutation outbox
// (stores/outbox-store.ts), persisted per account, and replays them from the
// same flush.
//
// The rule that keeps a message from going out twice: a send attempt is
// marked `maybeSent` before its request leaves, and only an answer that
// says how it ended clears the mark. A queued message still marked (the
// connection dropped mid-request, the app was killed, the server did not
// confirm) is looked up by its Message-ID before it is sent again: a copy
// that is no longer a draft means it went out.

import type { OutgoingEmail } from '../api/email';
import type { Identity } from '../api/types';

/** Everything needed to send the message later, without the composer. */
export interface QueuedSendPayload {
  /** The message as the composer built it; `messageId` is always set. */
  outgoing: OutgoingEmail;
  /** The composer's identity; the send target is worked out again at send time. */
  identity: Identity;
  /** The header From, which picks a group or shared account (#1090). */
  fromEmail: string;
  /** The login's own Sent and Drafts when queued, for when folders aren't loaded. */
  sentMailboxId: string;
  draftsMailboxId?: string;
  /** The autosaved draft version this message replaces, removed once it is sent. */
  draftId?: string;
  draftAccountId?: string;
  requestDsn?: boolean;
  requireTls?: boolean;
  /** An explicit "send later": the hold is worked out from it at send time. */
  scheduledAt?: string;
  /** The message replied to or forwarded, flagged once this one is sent. */
  original?: { emailId: string; accountId?: string; keyword: '$answered' | '$forwarded' };
}

export type QueuedSendStatus = 'queued' | 'sending' | 'failed';

export interface QueuedSend {
  id: string;
  createdAt: number;
  payload: QueuedSendPayload;
  status: QueuedSendStatus;
  /** Attempts that ended without the message going out for sure. */
  attempts: number;
  /**
   * A request may have reached the server without an answer saying how it
   * ended: look for the message before sending it again.
   */
  maybeSent: boolean;
  lastError?: string;
}

/** Give up (and let the user decide) after this many unconfirmed attempts. */
export const MAX_SEND_ATTEMPTS = 3;

export function newQueuedSend(id: string, payload: QueuedSendPayload, now: number, maybeSent: boolean): QueuedSend {
  return { id, createdAt: now, payload, status: 'queued', attempts: 0, maybeSent };
}

/**
 * How a send attempt failed, by error name so this stays free of the API
 * modules:
 * - `auth`: the credentials are gone; nothing reached the mail queue.
 * - `unconfirmed`: an answer that never came (deadline) or a send the
 *   server did not confirm; the message may be out.
 * - `offline`: the connection failed; the request may have got through.
 * - `refused`: the server answered and refused; nothing went out (the send
 *   removes the copy it made).
 */
export type SendFailureKind = 'auth' | 'unconfirmed' | 'offline' | 'refused';

export function classifySendFailure(err: unknown, isTransient: (err: unknown) => boolean): SendFailureKind {
  const name = err instanceof Error ? err.name : '';
  if (name === 'AuthenticationError' || name === 'TotpRequiredError') return 'auth';
  if (name === 'RequestTimeoutError' || name === 'SendUnconfirmedError') return 'unconfirmed';
  if (isTransient(err)) return 'offline';
  return 'refused';
}

/**
 * Whether the composer queues a send that failed this way instead of
 * reporting it: only when the connection failed. A deadline or an
 * unconfirmed send keeps its "check Sent first" warning (#702, #1019).
 */
export function shouldQueueFailedSend(kind: SendFailureKind): boolean {
  return kind === 'offline';
}

/** The attempt is about to leave: from here on it may reach the server. */
export function startAttempt(send: QueuedSend): QueuedSend {
  return { ...send, status: 'sending', maybeSent: true, lastError: undefined };
}

/** The state after an attempt failed this way. */
export function afterFailure(send: QueuedSend, kind: SendFailureKind, message: string): QueuedSend {
  switch (kind) {
    case 'auth':
      // Turned away at the door: nothing was taken. Wait for a sign-in.
      return { ...send, status: 'queued', maybeSent: false, lastError: message };
    case 'offline':
      // May have got through; the next attempt looks first. Not counted:
      // being offline is what the queue is for.
      return { ...send, status: 'queued', maybeSent: true, lastError: message };
    case 'unconfirmed': {
      const attempts = send.attempts + 1;
      return {
        ...send, status: attempts >= MAX_SEND_ATTEMPTS ? 'failed' : 'queued', maybeSent: true, attempts, lastError: message,
      };
    }
    case 'refused':
      return { ...send, status: 'failed', maybeSent: false, attempts: send.attempts + 1, lastError: message };
  }
}

/** A message found by its Message-ID. */
export interface FoundCopy {
  id: string;
  keywords?: Record<string, boolean>;
}

export type CopyVerdict =
  | { kind: 'sent'; copyId: string }
  | { kind: 'resend'; staleIds: string[] };

/**
 * What the copies with the message's Message-ID say. A send creates the
 * message as a draft and the submission's onSuccessUpdateEmail files it in
 * Sent without `$draft` in the same request, so a copy without `$draft` went
 * out (or is held for a scheduled time). Copies still marked `$draft` are
 * the autosaved draft (`draftId`, kept until the send succeeds) and copies
 * a refused submission left behind with its answer lost: those go before
 * the message is sent again.
 */
export function verdictFromCopies(copies: FoundCopy[], draftId?: string): CopyVerdict {
  const sentCopy = copies.find((c) => c.id !== draftId && !c.keywords?.$draft);
  if (sentCopy) return { kind: 'sent', copyId: sentCopy.id };
  return { kind: 'resend', staleIds: copies.filter((c) => c.id !== draftId).map((c) => c.id) };
}

/** Seconds to hold a scheduled send for, now; none once its time has passed. */
export function holdForScheduled(scheduledAt: string | undefined, now: number): number | undefined {
  if (!scheduledAt) return undefined;
  const at = Date.parse(scheduledAt);
  if (!Number.isFinite(at)) return undefined;
  const seconds = Math.ceil((at - now) / 1000);
  return seconds > 0 ? seconds : undefined;
}

/** Sends left in `sending` by an app that was killed go back to the queue, still marked. */
export function restoreAfterRestart(sends: QueuedSend[]): QueuedSend[] {
  return sends.map((s) => (s.status === 'sending' ? { ...s, status: 'queued', maybeSent: true } : s));
}

type Translate = (key: string, fallback?: string, params?: Record<string, string | number>) => string;

/** The status line under a message in the Outbox. */
export function queuedSendStatus(send: QueuedSend, online: boolean, t: Translate): string {
  if (send.status === 'sending') return t('outbox.status_sending', 'Sending…');
  if (send.status === 'failed') {
    return send.lastError
      ? t('outbox.status_failed_reason', 'Not sent: {reason}', { reason: send.lastError })
      : t('outbox.status_failed', 'Not sent');
  }
  return online
    ? t('outbox.status_retrying', 'Waiting to send')
    : t('outbox.status_offline', 'Waiting for a connection');
}

/**
 * The Outbox part of the offline banner: how many messages wait to go out
 * and how many could not be sent, or null without any.
 */
export function outboxHint(waiting: number, failed: number, t: Translate): string | null {
  const parts: string[] = [];
  if (waiting > 0) {
    parts.push(t('outbox.waiting', '{count, plural, one {# message} other {# messages}} in the Outbox', { count: waiting }));
  }
  if (failed > 0) {
    parts.push(t('outbox.failed_count', '{count, plural, one {# message} other {# messages}} not sent', { count: failed }));
  }
  return parts.length ? parts.join(' · ') : null;
}

/** Whether the user can take the message back: not while it is on its way. */
export function canCancel(send: QueuedSend): boolean {
  return send.status !== 'sending';
}
