import { describe, expect, it } from 'vitest';
import {
  afterFailure, canCancel, classifySendFailure, holdForScheduled, MAX_SEND_ATTEMPTS, newQueuedSend, outboxHint,
  queuedSendStatus, restoreAfterRestart, shouldQueueFailedSend, startAttempt, verdictFromCopies,
  type QueuedSendPayload,
} from '../send-queue';

// The offline send queue's state machine and its rule against sending a
// message twice (parity 04/09/10 "offline send").

const PAYLOAD = {
  outgoing: { from: [{ email: 'me@x.de' }], to: [{ email: 'you@x.de' }], subject: 'Hi', textBody: 'x', messageId: 'm1@x.de' },
  identity: { id: 'id-1', email: 'me@x.de', name: 'Me' },
  fromEmail: 'me@x.de',
  sentMailboxId: 'sent',
} as unknown as QueuedSendPayload;

const named = (name: string) => Object.assign(new Error(name), { name });
const transient = (err: unknown) => err instanceof Error && err.name === 'NetworkError';

describe('classifySendFailure', () => {
  it('tells the four outcomes apart', () => {
    expect(classifySendFailure(named('AuthenticationError'), transient)).toBe('auth');
    expect(classifySendFailure(named('RequestTimeoutError'), transient)).toBe('unconfirmed');
    expect(classifySendFailure(named('SendUnconfirmedError'), transient)).toBe('unconfirmed');
    expect(classifySendFailure(named('NetworkError'), transient)).toBe('offline');
    expect(classifySendFailure(new Error('Invalid envelope'), transient)).toBe('refused');
  });

  it('queues only a send whose connection failed; a deadline keeps its "check Sent" warning', () => {
    expect(shouldQueueFailedSend('offline')).toBe(true);
    expect(shouldQueueFailedSend('unconfirmed')).toBe(false);
    expect(shouldQueueFailedSend('refused')).toBe(false);
  });
});

describe('queued send transitions', () => {
  const fresh = newQueuedSend('q1', PAYLOAD, 1000, false);

  it('marks an attempt as possibly sent before its request leaves', () => {
    expect(startAttempt(fresh)).toMatchObject({ status: 'sending', maybeSent: true });
  });

  it('keeps an offline failure queued and marked, without counting it', () => {
    const next = afterFailure(startAttempt(fresh), 'offline', 'Network request failed');
    expect(next).toMatchObject({ status: 'queued', maybeSent: true, attempts: 0 });
  });

  it('clears the mark when the server turned the request away', () => {
    expect(afterFailure(startAttempt(fresh), 'auth', 'Session expired')).toMatchObject({ status: 'queued', maybeSent: false });
  });

  it('fails a refused send at once, with the reason; nothing went out', () => {
    expect(afterFailure(startAttempt(fresh), 'refused', 'Invalid envelope'))
      .toMatchObject({ status: 'failed', maybeSent: false, attempts: 1, lastError: 'Invalid envelope' });
  });

  it('gives up after repeated unconfirmed attempts, still marked', () => {
    let send = fresh;
    for (let i = 0; i < MAX_SEND_ATTEMPTS - 1; i++) {
      send = afterFailure(startAttempt(send), 'unconfirmed', 'no answer');
      expect(send.status).toBe('queued');
    }
    send = afterFailure(startAttempt(send), 'unconfirmed', 'no answer');
    expect(send).toMatchObject({ status: 'failed', maybeSent: true, attempts: MAX_SEND_ATTEMPTS });
  });

  it('puts a send the app was killed in back into the queue, marked', () => {
    const [restored, other] = restoreAfterRestart([startAttempt(fresh), { ...fresh, id: 'q2' }]);
    expect(restored).toMatchObject({ status: 'queued', maybeSent: true });
    expect(other).toMatchObject({ status: 'queued', maybeSent: false });
  });

  it('cannot be cancelled while it is on its way', () => {
    expect(canCancel(startAttempt(fresh))).toBe(false);
    expect(canCancel(fresh)).toBe(true);
    expect(canCancel(afterFailure(fresh, 'refused', 'x'))).toBe(true);
  });
});

describe('verdictFromCopies', () => {
  it('counts a copy without $draft as sent', () => {
    expect(verdictFromCopies([{ id: 'd1', keywords: { $draft: true } }, { id: 's1', keywords: { $seen: true } }], 'd1'))
      .toEqual({ kind: 'sent', copyId: 's1' });
  });

  it('sends again when only the autosaved draft is there', () => {
    expect(verdictFromCopies([{ id: 'd1', keywords: { $draft: true } }], 'd1')).toEqual({ kind: 'resend', staleIds: [] });
  });

  it('removes copies a refused attempt left in Drafts, but never the autosaved draft', () => {
    expect(verdictFromCopies([{ id: 'd1', keywords: { $draft: true } }, { id: 'x1', keywords: { $draft: true } }], 'd1'))
      .toEqual({ kind: 'resend', staleIds: ['x1'] });
  });

  it('sends when nothing is found', () => {
    expect(verdictFromCopies([], undefined)).toEqual({ kind: 'resend', staleIds: [] });
  });
});

describe('holdForScheduled', () => {
  it('holds a scheduled send for the time left, and sends at once once it has passed', () => {
    expect(holdForScheduled('2026-10-31T12:00:30Z', Date.parse('2026-10-31T12:00:00Z'))).toBe(30);
    expect(holdForScheduled('2026-10-31T11:00:00Z', Date.parse('2026-10-31T12:00:00Z'))).toBeUndefined();
    expect(holdForScheduled(undefined, 0)).toBeUndefined();
  });
});

describe('Outbox texts', () => {
  const t = (_key: string, fallback?: string, params?: Record<string, string | number>) =>
    (fallback ?? '').replace(/\{count, plural, one \{# (\w+)\} other \{# (\w+)\}\}/, (_m, one, other) =>
      `${params?.count} ${params?.count === 1 ? one : other}`).replace(/\{(\w+)\}/g, (_m, k) => String(params?.[k] ?? ''));

  it('counts waiting and failed messages', () => {
    expect(outboxHint(2, 0, t)).toBe('2 messages in the Outbox');
    expect(outboxHint(1, 1, t)).toBe('1 message in the Outbox · 1 message not sent');
    expect(outboxHint(0, 0, t)).toBeNull();
  });

  it('says why a message did not go out', () => {
    const failed = afterFailure(newQueuedSend('q', PAYLOAD, 0, false), 'refused', 'Invalid envelope');
    expect(queuedSendStatus(failed, true, t)).toBe('Not sent: Invalid envelope');
    expect(queuedSendStatus(newQueuedSend('q', PAYLOAD, 0, false), false, t)).toBe('Waiting for a connection');
  });
});
