import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';

vi.mock('../../api/jmap-client', () => {
  class AuthenticationError extends Error { constructor(m: string) { super(m); this.name = 'AuthenticationError'; } }
  class NetworkError extends Error { constructor(m: string) { super(m); this.name = 'NetworkError'; } }
  class RequestTimeoutError extends Error { constructor() { super('timed out'); this.name = 'RequestTimeoutError'; } }
  class RateLimitError extends Error { constructor() { super('rate limited'); this.name = 'RateLimitError'; } }
  return {
    AuthenticationError,
    NetworkError,
    RequestTimeoutError,
    RateLimitError,
    jmapClient: {
      isConnected: true,
      accountId: 'jA',
      connectedAccountId: 'jA',
      getSubmissionAccountIds: vi.fn(() => ['jA']),
      // The server has since dropped every extension: replay must not care.
      supportsSubmissionExtension: vi.fn(() => false),
      request: vi.fn(),
    },
  };
});
vi.mock('../../api/email', () => ({
  sendEmail: vi.fn(),
  patchKeywordsForEmails: vi.fn(async () => undefined),
  getEmailFlags: vi.fn(async () => ({ list: [], notFound: [] })),
  destroyEmails: vi.fn(async () => undefined),
}));
vi.mock('../../api/identity', () => ({ getIdentities: vi.fn(async () => []) }));
vi.mock('../../api/sent-lookup', () => ({
  findCopiesByMessageId: vi.fn(),
  findSubmissionsForEmails: vi.fn(async () => []),
  resolveSendMailboxes: vi.fn(async () => ({ sentId: 'm-sent', draftsId: 'm-drafts' })),
}));
vi.mock('../active-client-account', () => ({
  clientServesActiveAccount: vi.fn(() => true),
  activeAppAccountId: vi.fn(() => 'A'),
}));
vi.mock('../trust-recipients', () => ({ trustRecipients: vi.fn(), trustedSendersBookSyncOn: vi.fn(() => false) }));
vi.mock('../../stores/toast-store', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
}));

import { jmapClient, AuthenticationError, NetworkError, RequestTimeoutError, RateLimitError } from '../../api/jmap-client';
import { sendEmail, patchKeywordsForEmails, getEmailFlags, destroyEmails } from '../../api/email';
import { findCopiesByMessageId, findSubmissionsForEmails, resolveSendMailboxes } from '../../api/sent-lookup';
import { getIdentities } from '../../api/identity';
import {
  RecipientsRejectedError, ScheduleTooLateError, SendRefusedError, SendUnconfirmedError,
} from '../../api/jmap-result';
import { clientServesActiveAccount, activeAppAccountId } from '../active-client-account';
import { trustRecipients } from '../trust-recipients';
import { toast } from '../../stores/toast-store';
import { useNetworkStore } from '../../stores/network-store';
import { useSendQueueStore, type QueuedSend } from '../../stores/send-queue-store';
import {
  flushSendQueue, hasNewEntry, checkSentBeforeResend, ProofLookupError, ResendTooRecentError, RECONCILE_BACKOFF_MS,
} from '../send-queue-replay';

const mockSend = sendEmail as unknown as ReturnType<typeof vi.fn>;
const mockFlags = getEmailFlags as unknown as ReturnType<typeof vi.fn>;
const mockDestroy = destroyEmails as unknown as ReturnType<typeof vi.fn>;
const mockFind = findCopiesByMessageId as unknown as ReturnType<typeof vi.fn>;
const mockSubs = findSubmissionsForEmails as unknown as ReturnType<typeof vi.fn>;
const mockBoxes = resolveSendMailboxes as unknown as ReturnType<typeof vi.fn>;
const mockIdentities = getIdentities as unknown as ReturnType<typeof vi.fn>;
const mockActive = activeAppAccountId as unknown as ReturnType<typeof vi.fn>;
const mockServes = clientServesActiveAccount as unknown as ReturnType<typeof vi.fn>;
const client = jmapClient as unknown as {
  isConnected: boolean; accountId: string; connectedAccountId: string | null; getSubmissionAccountIds: ReturnType<typeof vi.fn>;
  supportsSubmissionExtension: ReturnType<typeof vi.fn>; request: ReturnType<typeof vi.fn>;
};

const HOUR_AGO = () => new Date(Date.now() - 60 * 60 * 1000).toISOString();
const OK = { scheduled: false, emailId: 'sent-1', emailSubmissionId: 'sub-1' };

// Each entry id carries its own Message-ID (q1 keeps mid-1): the store
// refuses a second entry with the same Message-ID in one account.
function entry(over: Partial<QueuedSend> = {}): QueuedSend {
  const id = over.id ?? 'q1';
  const mid = id === 'q1' ? 'mid-1@a.test' : `mid-${id}@a.test`;
  return {
    id: 'q1', appAccountId: 'A', jmapAccountId: 'jA', identityId: 'iA',
    outgoing: {
      from: [{ email: 'me@a.test' }], to: [{ email: 'you@x.test', name: 'You' }], cc: [{ email: 'cc@x.test' }],
      subject: 'Hello', textBody: 'hi', messageId: mid,
    },
    messageId: mid, createdAt: '2026-10-04T08:00:00.000Z', state: 'queued', ...over,
  };
}

/** Put a row on disk as a previous app run left it, then hydrate. */
async function seed(e: QueuedSend) {
  await AsyncStorage.setItem(`webmail:sendqueue:v1:${e.appAccountId}:${e.id}`, JSON.stringify(e));
}
const entries = (a = 'A') => useSendQueueStore.getState().entries[a] ?? [];
const stateOf = (id: string, a = 'A') => entries(a).find((e) => e.id === id)?.state;
const heldOf = (id: string, a = 'A') => entries(a).find((e) => e.id === id)?.heldReason;
/**
 * Make the mocked lookup return these copies, asking the caller's isProof
 * about them as the real paged lookup does.
 */
function findReturns({ copies, complete }: { copies: Array<Record<string, unknown>>; complete: boolean }) {
  mockFind.mockImplementation(async (_mid: string, opts: { isProof?: (c: unknown[]) => Promise<boolean> }) => {
    const proven = copies.length > 0 && !!opts.isProof && (await opts.isProof(copies));
    return { copies, complete: proven || complete, proven };
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  for (const a of ['A', 'B']) await useSendQueueStore.getState().clearAccount(a);
  await AsyncStorage.clear();
  useNetworkStore.setState({ online: true });
  client.isConnected = true;
  client.accountId = 'jA';
  client.connectedAccountId = 'jA';
  client.getSubmissionAccountIds.mockReturnValue(['jA']);
  mockIdentities.mockResolvedValue([]);
  mockActive.mockReturnValue('A');
  mockServes.mockReturnValue(true);
  mockBoxes.mockResolvedValue({ sentId: 'm-sent', draftsId: 'm-drafts' });
  mockSubs.mockResolvedValue([]);
  findReturns({ copies: [], complete: true });
  mockSend.mockResolvedValue(OK);
  mockFlags.mockResolvedValue({ list: [], notFound: [] });
  mockDestroy.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

const copy = (over: Record<string, unknown>) => ({
  id: 'c1', messageId: ['mid-1@a.test'], from: [{ email: 'Me@A.test' }], keywords: {}, mailboxIds: { 'm-sent': true }, ...over,
});
const draftInDrafts = () => copy({ id: 'd1', keywords: { $draft: true, $seen: true }, mailboxIds: { 'm-drafts': true } });

describe('flushSendQueue: reconciling an unknown outcome', () => {
  it('a send interrupted mid-request is reconciled, not resent', async () => {
    // The app was killed after markSending was persisted: `sending` on disk.
    const started = HOUR_AGO();
    await seed(entry({ state: 'sending', attemptStartedAt: started }));
    findReturns({ copies: [copy({ keywords: { $seen: true } })], complete: true });

    await flushSendQueue();

    expect(mockSend).not.toHaveBeenCalled();
    expect(entries()).toEqual([]);
    expect(await AsyncStorage.getItem('webmail:sendqueue:v1:A:q1')).toBeNull();
    const [mid, opts] = mockFind.mock.calls[0];
    expect(mid).toBe('mid-1@a.test');
    expect(opts.accountId).toBe('jA');
    expect(opts.since).toBe(new Date(Date.parse(started) - 7 * 24 * 3600 * 1000).toISOString());
    expect(typeof opts.isProof).toBe('function');
    expect(mockBoxes).toHaveBeenCalledWith('jA');
  });

  it('an entry found in Sent is completed without a second send', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO(), replyTo: { emailIds: ['orig-1'], keyword: '$answered' } }));
    findReturns({ copies: [copy({})], complete: true });

    await flushSendQueue();

    expect(mockSend).not.toHaveBeenCalled();
    expect(entries()).toEqual([]);
    // Post-send effects ran for the reconciled copy.
    expect(patchKeywordsForEmails).toHaveBeenCalledWith(['orig-1'], { $answered: true }, 'jA');
    expect(trustRecipients).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalled();
  });

  it('a copy of our own outside Sent (archived), without a submission, is not proof', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    findReturns({ copies: [copy({ mailboxIds: { 'm-archive': true } })], complete: true });
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(stateOf('q1')).toBe('uncertain');
  });

  it('an archived copy of our own with a submission from our identity is proof', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    findReturns({ copies: [copy({ mailboxIds: { 'm-archive': true } })], complete: true });
    mockSubs.mockResolvedValue([{ id: 's1', emailId: 'c1', identityId: 'iA', undoStatus: 'final' }]);
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(entries()).toEqual([]);
  });

  it('R15: an incoming copy in Inbox with the same Message-ID and another sender is not proof', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    findReturns({
      copies: [copy({ from: [{ email: 'attacker@evil.test' }], mailboxIds: { 'm-inbox': true } })],
      complete: true,
    });
    // Even a submission for it would not count: it is not our message.
    mockSubs.mockResolvedValue([{ id: 's1', emailId: 'c1', identityId: 'iA', undoStatus: 'final' }]);
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(stateOf('q1')).toBe('uncertain');
  });

  it('R15: the same Message-ID in Inbox from our address, not in Sent and without a submission, is not proof', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    findReturns({ copies: [copy({ mailboxIds: { 'm-inbox': true } })], complete: true });
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(stateOf('q1')).toBe('uncertain');
  });

  it('R15: a copy in Sent from another sender is not proof', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    findReturns({ copies: [copy({ from: [{ email: 'someone@else.test' }] })], complete: true });
    await flushSendQueue();
    expect(stateOf('q1')).toBe('uncertain');
  });

  it('R15: a copy in Sent with our from (any case) is proof', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    findReturns({ copies: [copy({ from: [{ email: 'ME@a.TEST' }] })], complete: true });
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(entries()).toEqual([]);
  });

  it('R15: a submission from a different identity is not proof', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    findReturns({ copies: [draftInDrafts()], complete: true });
    mockSubs.mockResolvedValue([{ id: 's1', emailId: 'd1', identityId: 'iOther', undoStatus: 'final' }]);
    await flushSendQueue();
    expect(stateOf('q1')).toBe('uncertain');
  });

  it('a $draft copy in Sent is proof: completed, no send', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    findReturns({ copies: [copy({ keywords: { $draft: true } })], complete: true });
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(entries()).toEqual([]);
  });

  describe('through the real paged lookup', () => {
    const page = (ids: string[], list: Array<Record<string, unknown>>) => ({
      methodResponses: [['Email/query', { ids }, 'q'], ['Email/get', { list }, 'g']],
    });
    const unrelated = (p: string) => {
      const ids = Array.from({ length: 200 }, (_, i) => `${p}-${i}`);
      return page(ids, ids.map((id) => ({ id, messageId: [`${id}@other.test`], keywords: {}, mailboxIds: { inbox: true } })));
    };
    const emailQueries = () => client.request.mock.calls.filter((c) => c[0][0][0] === 'Email/query');

    beforeEach(async () => {
      client.request.mockReset();
      const actual = await vi.importActual<typeof import('../../api/sent-lookup')>('../../api/sent-lookup');
      mockFind.mockImplementation(actual.findCopiesByMessageId);
    });

    it('proof found on page 3 completes the entry', async () => {
      await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
      const page3 = ['hit', ...Array.from({ length: 199 }, (_, i) => `p3-${i}`)];
      client.request
        .mockResolvedValueOnce(unrelated('p1'))
        .mockResolvedValueOnce(unrelated('p2'))
        .mockResolvedValueOnce(page(page3, [
          { id: 'hit', messageId: ['mid-1@a.test'], from: [{ email: 'me@a.test' }], keywords: { $seen: true }, mailboxIds: { 'm-sent': true } },
        ]))
        .mockResolvedValue(unrelated('more'));
      await flushSendQueue();
      expect(emailQueries()).toHaveLength(3);
      expect(mockSend).not.toHaveBeenCalled();
      expect(entries()).toEqual([]);
    });

    it('pages past an incoming echo with the same Message-ID to the real proof', async () => {
      await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
      client.request
        .mockResolvedValueOnce(page(['echo', ...Array.from({ length: 199 }, (_, i) => `p1-${i}`)], [
          { id: 'echo', messageId: ['mid-1@a.test'], from: [{ email: 'attacker@evil.test' }], keywords: {}, mailboxIds: { 'm-inbox': true } },
        ]))
        .mockResolvedValueOnce(page(['real'], [
          { id: 'real', messageId: ['mid-1@a.test'], from: [{ email: 'me@a.test' }], keywords: {}, mailboxIds: { 'm-sent': true } },
        ]));
      await flushSendQueue();
      expect(emailQueries()).toHaveLength(2);
      expect(mockSend).not.toHaveBeenCalled();
      expect(entries()).toEqual([]);
    });

    it('the cap is reached without a match: uncertain after exactly 10 queries', async () => {
      await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
      client.request.mockImplementation(async () => unrelated(`p${client.request.mock.calls.length}`));
      await flushSendQueue();
      expect(emailQueries()).toHaveLength(10);
      expect(mockSend).not.toHaveBeenCalled();
      expect(stateOf('q1')).toBe('uncertain');
    });
  });

  it('a $draft-only copy in Drafts stays uncertain: no destroy, no send', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    findReturns({ copies: [draftInDrafts()], complete: true });
    await flushSendQueue();
    expect(mockSubs).toHaveBeenCalledWith(['d1'], 'jA');
    expect(mockSend).not.toHaveBeenCalled();
    expect(stateOf('q1')).toBe('uncertain');
  });

  it('a $draft copy with a submission for it is proof: completed, no send', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    findReturns({ copies: [draftInDrafts()], complete: true });
    mockSubs.mockResolvedValue([{ id: 's1', emailId: 'd1', identityId: 'iA', undoStatus: 'final' }]);
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(entries()).toEqual([]);
  });

  it('a submission for an unrelated emailId is not proof', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    findReturns({ copies: [draftInDrafts()], complete: true });
    mockSubs.mockResolvedValue([{ id: 's9', emailId: 'someone-else', identityId: 'iA', undoStatus: 'final' }]);
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(stateOf('q1')).toBe('uncertain');
  });

  it('only a canceled submission is not proof', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    findReturns({ copies: [draftInDrafts()], complete: true });
    mockSubs.mockResolvedValue([{ id: 's1', emailId: 'd1', identityId: 'iA', undoStatus: 'canceled' }]);
    await flushSendQueue();
    expect(stateOf('q1')).toBe('uncertain');
  });

  it('stays uncertain when the submission lookup fails', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    findReturns({ copies: [draftInDrafts()], complete: true });
    mockSubs.mockRejectedValue(new Error('unknownMethod'));
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(stateOf('q1')).toBe('uncertain');
  });

  it('no copy found stays uncertain: no send', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(stateOf('q1')).toBe('uncertain');
  });

  it('the lookup fails: still uncertain, no send', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    mockFind.mockRejectedValue(new TypeError('Network request failed'));
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(stateOf('q1')).toBe('uncertain');
  });

  it('an incomplete lookup (cap reached) without proof stays uncertain', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    findReturns({ copies: [draftInDrafts()], complete: false });
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(stateOf('q1')).toBe('uncertain');
  });

  it('the Sent mailbox lookup fails: still uncertain, no send', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    mockBoxes.mockRejectedValue(new Error('offline'));
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(stateOf('q1')).toBe('uncertain');
  });

  it('without a Sent mailbox a copy alone is not proof, but its submission from our identity is', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    mockBoxes.mockResolvedValue({ draftsId: 'm-drafts' });
    findReturns({ copies: [copy({ mailboxIds: { other: true } })], complete: true });
    await flushSendQueue();
    expect(stateOf('q1')).toBe('uncertain');

    await useSendQueueStore.getState().clearAccount('A');
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    mockSubs.mockResolvedValue([{ id: 's1', emailId: 'c1', identityId: 'iA', undoStatus: 'final' }]);
    await flushSendQueue();
    expect(entries()).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('proof wins over a requeue made while the lookup was running: completed, never sent', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    mockFind.mockImplementation(async (_mid: string, opts: { isProof?: (c: unknown[]) => Promise<boolean> }) => {
      // The user taps "Send again" in the Outbox mid-lookup, and the
      // enqueue-style trigger asks for another pass.
      await useSendQueueStore.getState().requeue('q1');
      void flushSendQueue();
      const copies = [copy({})];
      return { copies, complete: true, proven: await opts.isProof!(copies) };
    });
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(entries()).toEqual([]);
  });

  it('an entry whose sender list is empty is never proven', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO(), outgoing: { ...entry().outgoing, from: [] } }));
    findReturns({ copies: [copy({})], complete: true });
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(stateOf('q1')).toBe('uncertain');
  });

  it('does not reconcile an attempt that started moments ago (the server may still be processing it)', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: new Date().toISOString() }));
    await flushSendQueue();
    expect(mockFind).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(stateOf('q1')).toBe('uncertain');
  });

  it('never reconciles an entry made uncertain during the same flush', async () => {
    await useSendQueueStore.getState().hydrateAccount('A');
    await useSendQueueStore.getState().enqueue(entry());
    // The clock moves past the grace period during the send, so only the
    // "uncertain when the flush began" rule keeps this pass from reconciling.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      mockSend.mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 60 * 60 * 1000);
        throw new RequestTimeoutError(30_000);
      });
      await flushSendQueue();
    } finally {
      vi.useRealTimers();
    }
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockFind).not.toHaveBeenCalled();
    expect(stateOf('q1')).toBe('uncertain');
  });

  it('leaves a failed entry alone', async () => {
    await seed(entry({ state: 'failed', lastError: 'x' }));
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockFind).not.toHaveBeenCalled();
    expect(stateOf('q1')).toBe('failed');
  });
});

describe('reconcile backoff', () => {
  it('rescans an uncertain entry at most every 15 minutes', async () => {
    expect(RECONCILE_BACKOFF_MS).toBe(15 * 60 * 1000);
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await flushSendQueue();
      expect(mockFind).toHaveBeenCalledTimes(1);
      await flushSendQueue();
      expect(mockFind).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 14 * 60 * 1000);
      await flushSendQueue();
      expect(mockFind).toHaveBeenCalledTimes(1);
      vi.setSystemTime(Date.now() + 2 * 60 * 1000);
      await flushSendQueue();
      expect(mockFind).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
    expect(stateOf('q1')).toBe('uncertain');
  });

  it('a failed lookup writes no stamp: the next flush looks again', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    mockFind.mockRejectedValueOnce(new Error('net'));
    await flushSendQueue();
    expect(entries()[0].lastReconcileAt).toBeUndefined();
    expect(JSON.parse((await AsyncStorage.getItem('webmail:sendqueue:v1:A:q1'))!).lastReconcileAt).toBeUndefined();
    await flushSendQueue();
    expect(mockFind).toHaveBeenCalledTimes(2);
    expect(typeof entries()[0].lastReconcileAt).toBe('string');
  });

  it('a failed lookup leaves the previous stamp as it was', async () => {
    const old = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO(), lastReconcileAt: old }));
    mockBoxes.mockRejectedValueOnce(new Error('net'));
    await flushSendQueue();
    expect(mockBoxes).toHaveBeenCalledTimes(1);
    expect(entries()[0].lastReconcileAt).toBe(old);
    expect(JSON.parse((await AsyncStorage.getItem('webmail:sendqueue:v1:A:q1'))!).lastReconcileAt).toBe(old);
    expect(stateOf('q1')).toBe('uncertain');
  });

  it('a lookup that went through, capped or not, is stamped', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    findReturns({ copies: [], complete: false });
    await flushSendQueue();
    expect(typeof entries()[0].lastReconcileAt).toBe('string');
    await flushSendQueue();
    expect(mockFind).toHaveBeenCalledTimes(1);
  });

  it('the user\'s Send again bypasses it', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    await flushSendQueue();
    expect(mockFind).toHaveBeenCalledTimes(1);
    await checkSentBeforeResend(entries()[0]);
    expect(mockFind).toHaveBeenCalledTimes(2);
  });
});

describe('the draft after a reconciled send', () => {
  it('destroys the entry draft in its own account when it still carries $draft', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO(), draftId: 'dr-1' }));
    findReturns({ copies: [copy({})], complete: true });
    mockFlags.mockResolvedValue({ list: [{ id: 'dr-1', keywords: { $draft: true }, mailboxIds: { 'm-drafts': true } }], notFound: [] });
    await flushSendQueue();
    expect(entries()).toEqual([]);
    expect(mockFlags).toHaveBeenCalledWith(['dr-1'], 'jA');
    expect(mockDestroy).toHaveBeenCalledWith(['dr-1'], 'jA');
  });

  it('leaves a draft that no longer carries $draft, or is gone', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO(), draftId: 'dr-1' }));
    findReturns({ copies: [copy({})], complete: true });
    mockFlags.mockResolvedValue({ list: [{ id: 'dr-1', keywords: { $seen: true }, mailboxIds: { 'm-drafts': true } }], notFound: [] });
    await flushSendQueue();
    expect(entries()).toEqual([]);
    expect(mockDestroy).not.toHaveBeenCalled();

    await seed(entry({ id: 'q2', state: 'uncertain', attemptStartedAt: HOUR_AGO(), draftId: 'dr-2' }));
    await useSendQueueStore.getState().hydrateAccount('A');
    findReturns({ copies: [copy({ messageId: ['mid-q2@a.test'] })], complete: true });
    mockFlags.mockResolvedValue({ list: [], notFound: ['dr-2'] });
    await flushSendQueue();
    expect(entries()).toEqual([]);
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it('never destroys the draft when it is itself the proof', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO(), draftId: 'd1' }));
    findReturns({ copies: [draftInDrafts()], complete: true });
    mockSubs.mockResolvedValue([{ id: 's1', emailId: 'd1', identityId: 'iA', undoStatus: 'final' }]);
    mockFlags.mockResolvedValue({ list: [{ id: 'd1', keywords: { $draft: true }, mailboxIds: { 'm-drafts': true } }], notFound: [] });
    await flushSendQueue();
    expect(entries()).toEqual([]);
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it('a failed clean-up does not change the outcome', async () => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO(), draftId: 'dr-1' }));
    findReturns({ copies: [copy({})], complete: true });
    mockFlags.mockRejectedValue(new Error('net'));
    await flushSendQueue();
    expect(entries()).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
  });
});

describe('checkSentBeforeResend (the user\'s Send again)', () => {
  const uncertain = async (over: Partial<QueuedSend> = {}) => {
    await seed(entry({ state: 'uncertain', attemptStartedAt: HOUR_AGO(), ...over }));
    await useSendQueueStore.getState().hydrateAccount('A');
    return entries()[0];
  };

  it('with proof: completes the entry and reports already sent, never sends', async () => {
    const e = await uncertain({ draftId: 'dr-1' });
    findReturns({ copies: [copy({})], complete: true });
    mockFlags.mockResolvedValue({ list: [{ id: 'dr-1', keywords: { $draft: true }, mailboxIds: {} }], notFound: [] });
    expect(await checkSentBeforeResend(e)).toBe('already_sent');
    expect(entries()).toEqual([]);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockDestroy).toHaveBeenCalledWith(['dr-1'], 'jA');
    // The caller tells the user; no "Sent:" toast on top of it.
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('a complete lookup without proof: not found, the entry untouched', async () => {
    const e = await uncertain();
    expect(await checkSentBeforeResend(e)).toBe('not_found');
    expect(stateOf('q1')).toBe('uncertain');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('a failed lookup rejects with ProofLookupError and changes nothing', async () => {
    const e = await uncertain();
    mockFind.mockRejectedValue(new Error('net'));
    await expect(checkSentBeforeResend(e)).rejects.toBeInstanceOf(ProofLookupError);
    mockFind.mockReset();
    mockBoxes.mockRejectedValue(new Error('net'));
    await expect(checkSentBeforeResend(e)).rejects.toBeInstanceOf(ProofLookupError);
    expect(stateOf('q1')).toBe('uncertain');
  });

  it('an incomplete lookup (cap reached) is not "not found"', async () => {
    const e = await uncertain();
    findReturns({ copies: [], complete: false });
    await expect(checkSentBeforeResend(e)).rejects.toBeInstanceOf(ProofLookupError);
    expect(stateOf('q1')).toBe('uncertain');
  });

  it('an attempt that started moments ago is not checked yet: rejects as too recent, without a lookup', async () => {
    const e = await uncertain({ attemptStartedAt: new Date().toISOString() });
    const err = await checkSentBeforeResend(e).catch((x) => x);
    expect(err).toBeInstanceOf(ResendTooRecentError);
    // Still a refusal that changed nothing, for any caller that only knows ProofLookupError.
    expect(err).toBeInstanceOf(ProofLookupError);
    expect(mockFind).not.toHaveBeenCalled();
    expect(stateOf('q1')).toBe('uncertain');
  });

  it('a failed lookup is not reported as too recent', async () => {
    const e = await uncertain();
    mockFind.mockRejectedValue(new Error('net'));
    const err = await checkSentBeforeResend(e).catch((x) => x);
    expect(err).toBeInstanceOf(ProofLookupError);
    expect(err).not.toBeInstanceOf(ResendTooRecentError);
  });
});

describe('flushSendQueue: sending queued entries', () => {
  it('never replays without a Drafts mailbox: no send, the entry is held as no_drafts', async () => {
    await seed(entry());
    mockBoxes.mockResolvedValue({ sentId: 'm-sent' });
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(stateOf('q1')).toBe('queued');
    expect(heldOf('q1')).toBe('no_drafts');
    expect(JSON.parse((await AsyncStorage.getItem('webmail:sendqueue:v1:A:q1'))!).heldReason).toBe('no_drafts');
  });

  it('holds an entry when the account has no Sent mailbox: no_sent', async () => {
    await seed(entry());
    mockBoxes.mockResolvedValue({ draftsId: 'm-drafts' });
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(stateOf('q1')).toBe('queued');
    expect(heldOf('q1')).toBe('no_sent');
  });

  it('holds an entry whose sendAt cannot be read: bad_schedule, no Sent lookup', async () => {
    await seed(entry({ sendAt: 'not a date' }));
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockBoxes).not.toHaveBeenCalled();
    expect(heldOf('q1')).toBe('bad_schedule');
  });

  it('skips a held entry on later flushes, and sends it after the user retries', async () => {
    await seed(entry({ heldReason: 'no_drafts' }));
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockBoxes).not.toHaveBeenCalled();
    expect(heldOf('q1')).toBe('no_drafts');

    await useSendQueueStore.getState().requeue('q1');
    await flushSendQueue();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(entries()).toEqual([]);
  });

  it('a Sent lookup that fails is transient: no hold, the flush stops', async () => {
    await seed(entry());
    mockBoxes.mockRejectedValue(new Error('net'));
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(heldOf('q1')).toBeUndefined();
  });

  it('sends with the entry account, identity and mailboxes resolved for that account', async () => {
    await seed(entry({ draftId: 'dr-1' }));
    await flushSendQueue();
    expect(mockSend).toHaveBeenCalledTimes(1);
    const [outgoing, identityId, sentId, holdFor, opts] = mockSend.mock.calls[0];
    expect(outgoing.messageId).toBe('mid-1@a.test');
    expect(identityId).toBe('iA');
    expect(sentId).toBe('m-sent');
    expect(holdFor).toBe(0);
    expect(opts).toEqual({ draftsMailboxId: 'm-drafts', draftId: 'dr-1', accountId: 'jA' });
    expect(mockBoxes).toHaveBeenCalledWith('jA');
    expect(entries()).toEqual([]);
  });

  describe('delivery notifications and REQUIRETLS ride on the row', () => {
    const envelopeOf = async (call: unknown[]) => {
      const { buildSubmissionEnvelope } = await vi.importActual<typeof import('../../api/email')>('../../api/email');
      return buildSubmissionEnvelope(call[0] as QueuedSend['outgoing'], call[3] as number);
    };

    it('a row with requireTls and requestDsn replays with the same envelope, even with the capability gone', async () => {
      const e = entry();
      await seed({ ...e, outgoing: { ...e.outgoing, requireTls: true, requestDsn: true } });
      await flushSendQueue();
      expect(mockSend).toHaveBeenCalledTimes(1);
      const [outgoing] = mockSend.mock.calls[0];
      expect(outgoing).toMatchObject({ requireTls: true, requestDsn: true });
      expect(await envelopeOf(mockSend.mock.calls[0])).toEqual({
        mailFrom: { email: 'me@a.test', parameters: { REQUIRETLS: null, RET: 'HDRS' } },
        rcptTo: ['you@x.test', 'cc@x.test'].map((email) => ({ email, parameters: { NOTIFY: 'SUCCESS,FAILURE,DELAY' } })),
      });
      expect(client.supportsSubmissionExtension).not.toHaveBeenCalled();
      expect(entries()).toEqual([]);
    });

    it('a server refusing REQUIRETLS fails the entry: never resent without it', async () => {
      const e = entry();
      await seed({ ...e, outgoing: { ...e.outgoing, requireTls: true } });
      mockSend.mockRejectedValueOnce(new SendRefusedError('forbiddenMailFrom', 'REQUIRETLS not supported'));
      await flushSendQueue();
      await flushSendQueue();
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(stateOf('q1')).toBe('failed');
      expect(entries()[0].outgoing.requireTls).toBe(true);
    });

    it('a From override row replays with its MAIL FROM, its fallback and its own identity (#1009)', async () => {
      const e = entry({ identityId: 'iInfo' });
      await seed({
        ...e,
        outgoing: {
          ...e.outgoing, from: [{ email: 'alias@a.test' }],
          envelopeMailFrom: 'alias@a.test', envelopeFallbackMailFrom: 'me@a.test', requireTls: true,
        },
      });
      await flushSendQueue();
      expect(mockSend).toHaveBeenCalledTimes(1);
      const [outgoing, identityId] = mockSend.mock.calls[0];
      expect(identityId).toBe('iInfo');
      expect(outgoing).toMatchObject({ envelopeMailFrom: 'alias@a.test', envelopeFallbackMailFrom: 'me@a.test', requireTls: true });
      expect(await envelopeOf(mockSend.mock.calls[0])).toEqual({
        mailFrom: { email: 'alias@a.test', parameters: { REQUIRETLS: null } },
        rcptTo: [{ email: 'you@x.test' }, { email: 'cc@x.test' }],
      });
      expect(entries()).toEqual([]);
    });

    it('an uncertain From override row is proven by a submission from its identity', async () => {
      const e = entry({ identityId: 'iInfo', state: 'sending', attemptStartedAt: HOUR_AGO() });
      await seed({
        ...e,
        outgoing: { ...e.outgoing, from: [{ email: 'alias@a.test' }], envelopeMailFrom: 'alias@a.test', envelopeFallbackMailFrom: 'me@a.test' },
      });
      findReturns({ copies: [copy({ from: [{ email: 'alias@a.test' }], mailboxIds: { 'm-drafts': true } })], complete: true });
      mockSubs.mockResolvedValue([{ id: 's1', emailId: 'c1', identityId: 'iInfo', undoStatus: 'final' }]);
      await flushSendQueue();
      expect(mockSend).not.toHaveBeenCalled();
      expect(entries()).toEqual([]);
    });

    it('an old row without the fields replays without them', async () => {
      await seed(entry());
      await flushSendQueue();
      const [outgoing] = mockSend.mock.calls[0];
      expect(outgoing).not.toHaveProperty('requireTls');
      expect(outgoing).not.toHaveProperty('requestDsn');
      expect(await envelopeOf(mockSend.mock.calls[0])).toBeUndefined();
    });
  });

  it('persists sending before the request is made', async () => {
    await seed(entry());
    let onDisk: string | undefined;
    mockSend.mockImplementation(async () => {
      onDisk = JSON.parse((await AsyncStorage.getItem('webmail:sendqueue:v1:A:q1'))!).state;
      return OK;
    });
    await flushSendQueue();
    expect(onDisk).toBe('sending');
  });

  it('does not send when markSending rejects', async () => {
    await seed(entry());
    await useSendQueueStore.getState().hydrateAccount('A');
    const original = useSendQueueStore.getState().markSending;
    useSendQueueStore.setState({ markSending: vi.fn(async () => { throw new Error('disk full'); }) });
    try {
      await flushSendQueue();
    } finally {
      useSendQueueStore.setState({ markSending: original });
    }
    expect(mockSend).not.toHaveBeenCalled();
    expect(stateOf('q1')).toBe('queued');
  });

  it('a past sendAt gives holdFor 0', async () => {
    await seed(entry({ sendAt: new Date(Date.now() - 60_000).toISOString() }));
    await flushSendQueue();
    expect(mockSend.mock.calls[0][3]).toBe(0);
  });

  it('a future sendAt is held for the remaining seconds', async () => {
    await seed(entry({ sendAt: new Date(Date.now() + 3600_000).toISOString() }));
    await flushSendQueue();
    const hold = mockSend.mock.calls[0][3] as number;
    expect(hold).toBeGreaterThan(3590);
    expect(hold).toBeLessThanOrEqual(3600);
  });

  it('sends oldest first', async () => {
    await seed(entry({ id: 'late', createdAt: '2026-10-04T09:00:00.000Z' }));
    await seed(entry({ id: 'early', createdAt: '2026-10-04T07:00:00.000Z', outgoing: { ...entry().outgoing, subject: 'early' } }));
    await flushSendQueue();
    expect(mockSend.mock.calls.map((c) => c[0].subject)).toEqual(['early', 'Hello']);
  });

  it('two concurrent flushSendQueue calls send once', async () => {
    await seed(entry());
    let release!: () => void;
    mockSend.mockImplementation(() => new Promise((r) => { release = () => r(OK); }));
    const a = flushSendQueue();
    const b = flushSendQueue();
    await vi.waitFor(() => expect(mockSend).toHaveBeenCalled());
    release();
    await Promise.all([a, b]);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(entries()).toEqual([]);
  });

  it('a flush requested while one runs picks up an entry enqueued meanwhile', async () => {
    await seed(entry());
    let release!: () => void;
    mockSend.mockImplementationOnce(() => new Promise((r) => { release = () => r(OK); }));
    const a = flushSendQueue();
    await vi.waitFor(() => expect(mockSend).toHaveBeenCalledTimes(1));
    await useSendQueueStore.getState().enqueue(entry({ id: 'q2', createdAt: '2026-10-04T09:00:00.000Z' }));
    const b = flushSendQueue();
    release();
    await Promise.all([a, b]);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(entries()).toEqual([]);
  });

  it('runs post-send effects best effort without changing the outcome', async () => {
    await seed(entry({ replyTo: { emailIds: ['orig-1'], keyword: '$answered' } }));
    mockSend.mockResolvedValue({ ...OK, rejectedRecipients: [{ email: 'cc@x.test', smtpReply: '550' }] });
    (patchKeywordsForEmails as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    (trustRecipients as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => { throw new Error('boom'); });
    await flushSendQueue();
    expect(entries()).toEqual([]);
    expect(patchKeywordsForEmails).toHaveBeenCalledWith(['orig-1'], { $answered: true }, 'jA');
    const [recipients, refused] = (trustRecipients as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(recipients.map((r: { email: string }) => r.email)).toEqual(['you@x.test', 'cc@x.test']);
    expect(refused).toEqual([{ email: 'cc@x.test', smtpReply: '550' }]);
  });

  it('a replayed reply trusts every accepted recipient except the flagged sender', async () => {
    await seed(entry({
      outgoing: { ...entry().outgoing, to: [{ email: 'ceo@bank.example' }, { email: 'ann@ok.example' }], cc: [] },
      replyTo: { emailIds: ['orig-1'], keyword: '$answered', untrusted: ['ceo@bank.example'] },
    }));
    await flushSendQueue();
    const [, , opts] = (trustRecipients as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.exclude).toEqual(['ceo@bank.example']);
  });

  it('flags the original in its own account when replyTo carries one', async () => {
    await seed(entry({ replyTo: { emailIds: ['orig-1'], keyword: '$answered', jmapAccountId: 'jShared' } }));
    await flushSendQueue();
    expect(patchKeywordsForEmails).toHaveBeenCalledWith(['orig-1'], { $answered: true }, 'jShared');
  });

  it('does not trust recipients of a forward', async () => {
    await seed(entry({ replyTo: { emailIds: ['orig-1'], keyword: '$forwarded' } }));
    await flushSendQueue();
    expect(patchKeywordsForEmails).toHaveBeenCalledWith(['orig-1'], { $forwarded: true }, 'jA');
    expect(trustRecipients).not.toHaveBeenCalled();
  });

  describe('maps each send error to its state', () => {
    const cases: Array<[string, () => unknown, 'failed' | 'uncertain']> = [
      ['RecipientsRejectedError', () => new RecipientsRejectedError([{ email: 'x@y', smtpReply: '550' }]), 'failed'],
      ['ScheduleTooLateError', () => new ScheduleTooLateError(100), 'failed'],
      ['SendRefusedError (notCreated / method error)', () => new SendRefusedError('blobNotFound', 'blobNotFound'), 'failed'],
      ['NetworkError', () => new NetworkError('offline'), 'uncertain'],
      ['TypeError from fetch', () => new TypeError('Network request failed'), 'uncertain'],
      ['RequestTimeoutError', () => new RequestTimeoutError(30_000), 'uncertain'],
      ['SendUnconfirmedError', () => new SendUnconfirmedError(), 'uncertain'],
      ['RateLimitError', () => new RateLimitError(1000), 'uncertain'],
      ['a plain Error (HTTP 500, invalid JSON, unknown)', () => new Error('JMAP request failed: 500'), 'uncertain'],
      ['a non-Error throw', () => 'weird', 'uncertain'],
    ];
    for (const [name, make, expected] of cases) {
      it(`${name} -> ${expected}`, async () => {
        await seed(entry());
        mockSend.mockRejectedValueOnce(make());
        await flushSendQueue();
        expect(mockSend).toHaveBeenCalledTimes(1);
        expect(stateOf('q1')).toBe(expected);
        expect(entries()[0].lastError).toBeTruthy();
      });
    }
  });

  it('an auth error releases the entry back to queued and stops the flush', async () => {
    await seed(entry({ id: 'q1', createdAt: '2026-10-04T07:00:00.000Z' }));
    await seed(entry({ id: 'q2', createdAt: '2026-10-04T08:00:00.000Z' }));
    mockSend.mockRejectedValueOnce(new AuthenticationError('Session expired'));
    await flushSendQueue();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(stateOf('q1')).toBe('queued');
    expect(stateOf('q2')).toBe('queued');
  });

  it('a stale-connection error (nothing sent) releases the entry back to queued with no prompt and stops', async () => {
    await seed(entry({ id: 'q1', createdAt: '2026-10-04T07:00:00.000Z' }));
    await seed(entry({ id: 'q2', createdAt: '2026-10-04T08:00:00.000Z' }));
    const stale = new Error('Superseded by a newer account load');
    stale.name = 'StaleLoadError';
    mockSend.mockRejectedValueOnce(stale);
    await flushSendQueue();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(stateOf('q1')).toBe('queued');
    expect(stateOf('q2')).toBe('queued');
    expect(toast.warning).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('P1: an account switch while markSending persists gives no send, and the entry is queued again', async () => {
    await seed(entry());
    vi.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(async (k: string, v: string) => {
      if (v.includes('"state":"sending"')) {
        // B becomes active while the sending row is being written.
        mockActive.mockReturnValue('B');
        client.accountId = 'jB';
        client.getSubmissionAccountIds.mockReturnValue(['jB']);
      }
      await AsyncStorage.multiSet([[k, v]]);
    });
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(stateOf('q1')).toBe('queued');
    expect(JSON.parse((await AsyncStorage.getItem('webmail:sendqueue:v1:A:q1'))!).state).toBe('queued');
  });

  it('releases the entry when the client stops serving its JMAP account during markSending', async () => {
    await seed(entry());
    vi.spyOn(AsyncStorage, 'setItem').mockImplementationOnce(async (k: string, v: string) => {
      if (v.includes('"state":"sending"')) {
        client.getSubmissionAccountIds.mockReturnValue([]);
        client.accountId = 'jOther';
      }
      await AsyncStorage.multiSet([[k, v]]);
    });
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(stateOf('q1')).toBe('queued');
  });

  it('a rerun requested during a pass that stopped still runs while the conditions allow', async () => {
    await seed(entry());
    mockBoxes.mockImplementationOnce(async () => {
      void flushSendQueue(); // e.g. an enqueue or online trigger during the pass
      throw new Error('blip');
    });
    await flushSendQueue();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(entries()).toEqual([]);
  });
});

describe('flushSendQueue: preconditions and accounts', () => {
  it('waits for its own account', async () => {
    await seed(entry({ appAccountId: 'A', jmapAccountId: 'jA', identityId: 'iA' }));
    // B is active: the client serves B.
    mockActive.mockReturnValue('B');
    client.accountId = 'jB';
    client.getSubmissionAccountIds.mockReturnValue(['jB']);
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();

    // Back on A.
    mockActive.mockReturnValue('A');
    client.accountId = 'jA';
    client.getSubmissionAccountIds.mockReturnValue(['jA']);
    await flushSendQueue();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][1]).toBe('iA');
    expect(mockSend.mock.calls[0][4].accountId).toBe('jA');
    expect(mockBoxes).toHaveBeenCalledWith('jA');
    expect(entries('A')).toEqual([]);
  });

  it('does nothing while the client does not serve the active account', async () => {
    await seed(entry());
    mockServes.mockReturnValue(false);
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('holds a queued entry whose JMAP account the client does not serve: account_unavailable', async () => {
    await seed(entry({ jmapAccountId: 'jOther' }));
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(stateOf('q1')).toBe('queued');
    expect(heldOf('q1')).toBe('account_unavailable');
  });

  it('an account_unavailable entry is released and sent once when its account is served again', async () => {
    await seed(entry({ jmapAccountId: 'jOther' }));
    await flushSendQueue();
    expect(heldOf('q1')).toBe('account_unavailable');
    // Still not served: it stays held.
    await flushSendQueue();
    expect(heldOf('q1')).toBe('account_unavailable');
    expect(mockSend).not.toHaveBeenCalled();

    client.getSubmissionAccountIds.mockReturnValue(['jA', 'jOther']);
    await flushSendQueue();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][4]).toMatchObject({ accountId: 'jOther' });
    expect(entries()).toEqual([]);
    await flushSendQueue();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('never releases an account_unavailable hold while the client does not serve the active account', async () => {
    await seed(entry({ heldReason: 'account_unavailable' }));
    await useSendQueueStore.getState().hydrateAccount('A');
    mockServes.mockReturnValue(false);
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(heldOf('q1')).toBe('account_unavailable');
  });

  it('never releases the other hold reasons, even with every account served', async () => {
    const reasons = ['bad_schedule', 'no_sent', 'no_drafts'] as const;
    for (const [i, reason] of reasons.entries()) await seed(entry({ id: `h${i}`, heldReason: reason }));
    await flushSendQueue();
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(reasons.map((_, i) => heldOf(`h${i}`))).toEqual([...reasons]);
  });

  it('never releases an account_unavailable entry that was ever attempted', async () => {
    await seed(entry({ heldReason: 'account_unavailable', attemptStartedAt: HOUR_AGO() }));
    await flushSendQueue();
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(stateOf('q1')).toBe('queued');
    expect(heldOf('q1')).toBe('account_unavailable');
    expect(JSON.parse((await AsyncStorage.getItem('webmail:sendqueue:v1:A:q1'))!).heldReason).toBe('account_unavailable');
  });

  it('leaves an uncertain entry of an unserved JMAP account alone (no hold, no lookup)', async () => {
    await seed(entry({ jmapAccountId: 'jOther', state: 'uncertain', attemptStartedAt: HOUR_AGO() }));
    await flushSendQueue();
    expect(mockFind).not.toHaveBeenCalled();
    expect(stateOf('q1')).toBe('uncertain');
    expect(heldOf('q1')).toBeUndefined();
  });

  it('does nothing offline or disconnected', async () => {
    await seed(entry());
    useNetworkStore.setState({ online: false });
    await flushSendQueue();
    useNetworkStore.setState({ online: true });
    client.isConnected = false;
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('stops before the next entry when the account switches mid-flush', async () => {
    await seed(entry({ id: 'q1', createdAt: '2026-10-04T07:00:00.000Z' }));
    await seed(entry({ id: 'q2', createdAt: '2026-10-04T08:00:00.000Z' }));
    mockSend.mockImplementationOnce(async () => {
      mockActive.mockReturnValue('B');
      return OK;
    });
    await flushSendQueue();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(stateOf('q2')).toBe('queued');
  });

  it('hydrates the active account before flushing', async () => {
    await seed(entry());
    expect(useSendQueueStore.getState().hydrated.A).toBeFalsy();
    await flushSendQueue();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});

describe('flushSendQueue: a held send whose account id went stale', () => {
  // The server renumbered the account (a migration, a restore): the entry's
  // JMAP id is gone and the session's primary is the same mailbox now.
  const identity = (id: string, email: string) => ({ id, name: '', email, mayDelete: true });
  const stale = (over: Partial<QueuedSend> = {}) => entry({
    jmapAccountId: 'jOld', heldReason: 'account_unavailable', identityId: 'iA', draftId: 'd-old',
    replyTo: { emailIds: ['e-old'], keyword: '$answered', jmapAccountId: 'jOld', untrusted: ['x@evil.test'] },
    ...over,
  });

  it('sends a stale held entry once, on the live primary, after re-stamping it', async () => {
    await seed(stale());
    mockIdentities.mockResolvedValue([identity('iA', 'ME@a.test')]);
    await flushSendQueue();
    expect(mockIdentities).toHaveBeenCalledWith('jA');
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][1]).toBe('iA');
    expect(mockSend.mock.calls[0][4]).toMatchObject({ accountId: 'jA', draftId: undefined });
    expect(entries()).toEqual([]);
    // No JMAP id of the old account is used on the new one.
    expect(patchKeywordsForEmails).not.toHaveBeenCalled();
    expect(trustRecipients).toHaveBeenCalledWith(expect.anything(), undefined, expect.objectContaining({ exclude: ['x@evil.test'] }));
    await flushSendQueue();
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('re-stamps nothing when a switch lands while the identities load', async () => {
    await seed(stale());
    mockIdentities.mockImplementation(async () => {
      mockActive.mockReturnValue('B');
      return [identity('iA', 'me@a.test')];
    });
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(entries()[0]).toMatchObject({ jmapAccountId: 'jOld', heldReason: 'account_unavailable', draftId: 'd-old' });
  });

  it('re-stamps nothing when the primary changes while the identities load', async () => {
    await seed(stale());
    mockIdentities.mockImplementation(async () => {
      client.connectedAccountId = 'jOther';
      return [identity('iA', 'me@a.test')];
    });
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(entries()[0]).toMatchObject({ jmapAccountId: 'jOld', heldReason: 'account_unavailable' });
  });

  it('re-stamps nothing while the client does not serve the active account', async () => {
    await seed(stale());
    await useSendQueueStore.getState().hydrateAccount('A');
    mockServes.mockReturnValue(false);
    mockIdentities.mockResolvedValue([identity('iA', 'me@a.test')]);
    await flushSendQueue();
    expect(mockIdentities).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('keeps holding when the primary\'s identity has another address, or the entry\'s identity is missing', async () => {
    await seed(stale());
    mockIdentities.mockResolvedValue([identity('iA', 'someone-else@a.test'), identity('iB', 'me@a.test')]);
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(entries()[0]).toMatchObject({ jmapAccountId: 'jOld', heldReason: 'account_unavailable' });
  });

  it('keeps holding when the identities cannot be read', async () => {
    await seed(stale());
    mockIdentities.mockRejectedValue(new Error('network'));
    await flushSendQueue();
    expect(mockSend).not.toHaveBeenCalled();
    expect(entries()[0]).toMatchObject({ jmapAccountId: 'jOld', heldReason: 'account_unavailable' });
  });

  it('never re-stamps an entry that was ever attempted or carries attachments, and asks for no identities for them', async () => {
    await seed(stale({ id: 'q1', attemptStartedAt: HOUR_AGO() }));
    await seed(stale({ id: 'q2', outgoing: { ...entry({ id: 'q2' }).outgoing, attachments: [{ blobId: 'b1', type: 'text/plain', name: 'a.txt' }] } }));
    mockIdentities.mockResolvedValue([identity('iA', 'me@a.test')]);
    await flushSendQueue();
    await flushSendQueue();
    expect(mockIdentities).not.toHaveBeenCalled();
    expect(mockSend).not.toHaveBeenCalled();
    expect(entries().map((e) => [e.jmapAccountId, e.heldReason])).toEqual([['jOld', 'account_unavailable'], ['jOld', 'account_unavailable']]);
  });

  it('reads the primary\'s identities once per flush', async () => {
    await seed(stale({ id: 'q1' }));
    await seed(stale({ id: 'q2', createdAt: '2026-10-04T09:00:00.000Z' }));
    mockIdentities.mockResolvedValue([identity('iA', 'me@a.test')]);
    await flushSendQueue();
    expect(mockIdentities).toHaveBeenCalledTimes(1);
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockSend.mock.calls.map((c) => c[4].accountId)).toEqual(['jA', 'jA']);
  });

  it('releases rather than re-stamps once the session serves the old account again', async () => {
    await seed(stale());
    client.getSubmissionAccountIds.mockReturnValue(['jA', 'jOld']);
    mockIdentities.mockResolvedValue([identity('iA', 'me@a.test')]);
    await flushSendQueue();
    expect(mockIdentities).not.toHaveBeenCalled();
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockSend.mock.calls[0][4]).toMatchObject({ accountId: 'jOld', draftId: 'd-old' });
  });
});

describe('hasNewEntry', () => {
  it('is true only when an entry id appears', () => {
    const a = entry();
    expect(hasNewEntry({ A: [a] }, {})).toBe(true);
    expect(hasNewEntry({ A: [a, entry({ id: 'q2' })] }, { A: [a] })).toBe(true);
    expect(hasNewEntry({ A: [{ ...a, state: 'queued' }] }, { A: [{ ...a, state: 'uncertain' }] })).toBe(false);
    expect(hasNewEntry({ A: [] }, { A: [a] })).toBe(false);
  });
});
