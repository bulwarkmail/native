import { describe, it, expect, vi, beforeEach } from 'vitest';

// NetInfo is a native module; stub it so network-store loads under node. The
// store defaults to online, which we flip per-test via setState.
vi.mock('@react-native-community/netinfo', () => ({
  default: {
    addEventListener: () => () => undefined,
    fetch: async () => ({ isConnected: true, isInternetReachable: true }),
  },
}));

vi.mock('../../api/jmap-client', () => ({
  jmapClient: { isConnected: true },
}));

const { serving } = vi.hoisted(() => ({ serving: { app: null as string | null, client: false } }));
vi.mock('../../lib/active-client-account', () => ({
  activeAppAccountId: () => serving.app,
  clientServesActiveAccount: () => serving.client,
}));

const patchKeywordsForEmails = vi.fn(async (..._a: any[]) => undefined);
const setEmailMailboxes = vi.fn(async (..._a: any[]) => undefined);
const destroyEmails = vi.fn(async (..._a: any[]) => undefined);
vi.mock('../../api/email', () => ({
  patchKeywordsForEmails: (...a: any[]) => patchKeywordsForEmails(...a),
  setEmailMailboxes: (...a: any[]) => setEmailMailboxes(...a),
  destroyEmails: (...a: any[]) => destroyEmails(...a),
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useOutboxStore, applyOrQueue } from '../outbox-store';
import { useNetworkStore } from '../network-store';
import { useToastStore } from '../toast-store';

const ACCOUNT = 'acc-1';

beforeEach(async () => {
  vi.clearAllMocks();
  useNetworkStore.setState({ online: true, connected: true });
  // Detach then attach a clean bucket (AsyncStorage is the in-memory mock).
  await useOutboxStore.getState().setAccount(null);
  await useOutboxStore.getState().clear();
  await useOutboxStore.getState().setAccount(ACCOUNT);
  await useOutboxStore.getState().clear();
});

describe('outbox enqueue + coalescing', () => {
  it('merges repeated keyword patches for the same email (last write wins per keyword)', () => {
    const store = useOutboxStore.getState();
    store.enqueue({ kind: 'keywords', emailId: 'e1', patch: { $seen: true } });
    store.enqueue({ kind: 'keywords', emailId: 'e1', patch: { $flagged: true } });
    store.enqueue({ kind: 'keywords', emailId: 'e1', patch: { $seen: null } });

    const entries = useOutboxStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].op).toEqual({ kind: 'keywords', emailId: 'e1', patch: { $seen: null, $flagged: true } });
  });

  it('keeps keyword and mailbox ops for the same email separate', () => {
    const store = useOutboxStore.getState();
    store.enqueue({ kind: 'keywords', emailId: 'e1', patch: { $seen: true } });
    store.enqueue({ kind: 'mailboxes', emailId: 'e1', mailboxIds: { archive: true } });
    expect(useOutboxStore.getState().entries).toHaveLength(2);
  });

  it('destroy supersedes pending edits for that email', () => {
    const store = useOutboxStore.getState();
    store.enqueue({ kind: 'keywords', emailId: 'e1', patch: { $seen: true } });
    store.enqueue({ kind: 'mailboxes', emailId: 'e1', mailboxIds: { archive: true } });
    store.enqueue({ kind: 'destroy', emailId: 'e1' });

    const entries = useOutboxStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].op.kind).toBe('destroy');
  });

  it('ignores further edits once a destroy is queued', () => {
    const store = useOutboxStore.getState();
    store.enqueue({ kind: 'destroy', emailId: 'e1' });
    store.enqueue({ kind: 'keywords', emailId: 'e1', patch: { $seen: true } });
    expect(useOutboxStore.getState().entries).toHaveLength(1);
    expect(useOutboxStore.getState().entries[0].op.kind).toBe('destroy');
  });
});

describe('applyOrQueue', () => {
  it('runs immediately when online with an empty queue', async () => {
    const result = await applyOrQueue({ kind: 'keywords', emailId: 'e1', patch: { $seen: true } });
    expect(result.queued).toBe(false);
    expect(patchKeywordsForEmails).toHaveBeenCalledWith(['e1'], { $seen: true }, undefined);
    expect(useOutboxStore.getState().entries).toHaveLength(0);
  });

  it('prefers the supplied online runner over the primitive', async () => {
    const onlineRun = vi.fn(async () => undefined);
    await applyOrQueue({ kind: 'mailboxes', emailId: 'e1', mailboxIds: { archive: true } }, onlineRun);
    expect(onlineRun).toHaveBeenCalledOnce();
    expect(setEmailMailboxes).not.toHaveBeenCalled();
  });

  it('queues instead of running when offline', async () => {
    useNetworkStore.setState({ online: false });
    const result = await applyOrQueue({ kind: 'keywords', emailId: 'e1', patch: { $seen: true } });
    expect(result.queued).toBe(true);
    expect(patchKeywordsForEmails).not.toHaveBeenCalled();
    expect(useOutboxStore.getState().entries).toHaveLength(1);
  });

  it('queues a later op for the same email to preserve order', async () => {
    useNetworkStore.setState({ online: false });
    await applyOrQueue({ kind: 'mailboxes', emailId: 'e1', mailboxIds: { a: true } });
    useNetworkStore.setState({ online: true });
    // Now online, but an op is already queued for e1 → must queue, not run.
    const result = await applyOrQueue({ kind: 'keywords', emailId: 'e1', patch: { $seen: true } });
    expect(result.queued).toBe(true);
    expect(patchKeywordsForEmails).not.toHaveBeenCalled();
  });

  it('surfaces a non-transient (server) error to the caller', async () => {
    const onlineRun = vi.fn(async () => { throw new Error('JMAP request failed: 403'); });
    await expect(
      applyOrQueue({ kind: 'mailboxes', emailId: 'e1', mailboxIds: { a: true } }, onlineRun),
    ).rejects.toThrow('403');
    expect(useOutboxStore.getState().entries).toHaveLength(0);
  });

  it('queues when the online attempt fails with a connectivity error', async () => {
    const err = new Error('Network request failed');
    err.name = 'NetworkError';
    const onlineRun = vi.fn(async () => { throw err; });
    const result = await applyOrQueue({ kind: 'keywords', emailId: 'e1', patch: { $seen: true } }, onlineRun);
    expect(result.queued).toBe(true);
    expect(useOutboxStore.getState().entries).toHaveLength(1);
  });
});

describe('flush', () => {
  it('replays queued ops in order and clears them', async () => {
    useNetworkStore.setState({ online: false });
    const store = useOutboxStore.getState();
    store.enqueue({ kind: 'keywords', emailId: 'e1', patch: { $seen: true } });
    store.enqueue({ kind: 'mailboxes', emailId: 'e2', mailboxIds: { trash: true } });
    store.enqueue({ kind: 'destroy', emailId: 'e3' });

    useNetworkStore.setState({ online: true });
    await useOutboxStore.getState().flush();

    expect(patchKeywordsForEmails).toHaveBeenCalledWith(['e1'], { $seen: true }, undefined);
    expect(setEmailMailboxes).toHaveBeenCalledWith('e2', { trash: true }, undefined);
    expect(destroyEmails).toHaveBeenCalledWith(['e3'], undefined);
    expect(useOutboxStore.getState().entries).toHaveLength(0);
  });

  it('does nothing while offline', async () => {
    useNetworkStore.setState({ online: false });
    useOutboxStore.getState().enqueue({ kind: 'keywords', emailId: 'e1', patch: { $seen: true } });
    await useOutboxStore.getState().flush();
    expect(patchKeywordsForEmails).not.toHaveBeenCalled();
    expect(useOutboxStore.getState().entries).toHaveLength(1);
  });

  it('stops and retains the op on a transient failure', async () => {
    useNetworkStore.setState({ online: false });
    useOutboxStore.getState().enqueue({ kind: 'keywords', emailId: 'e1', patch: { $seen: true } });
    useNetworkStore.setState({ online: true });

    const err = new Error('Network request failed');
    err.name = 'NetworkError';
    patchKeywordsForEmails.mockRejectedValueOnce(err);

    await useOutboxStore.getState().flush();
    expect(useOutboxStore.getState().entries).toHaveLength(1);
    expect(useOutboxStore.getState().entries[0].lastError).toContain('Network');
  });

  it('stops on a stale-connection error without recording an error or counting an attempt', async () => {
    useNetworkStore.setState({ online: false });
    useOutboxStore.getState().enqueue({ kind: 'keywords', emailId: 'e1', patch: { $seen: true } });
    useOutboxStore.getState().enqueue({ kind: 'keywords', emailId: 'e2', patch: { $seen: true } });
    useNetworkStore.setState({ online: true });
    const stale = new Error('Superseded by a newer account load');
    stale.name = 'StaleLoadError';
    patchKeywordsForEmails.mockRejectedValueOnce(stale);
    vi.useFakeTimers();
    try {
      await useOutboxStore.getState().flush();
      expect(patchKeywordsForEmails).toHaveBeenCalledTimes(1);
      const entries = useOutboxStore.getState().entries;
      expect(entries).toHaveLength(2);
      expect(entries[0].lastError).toBeUndefined();
      expect(entries[0].attempts ?? 0).toBe(0);
      expect(useOutboxStore.getState().paused).toBe(false);
      // No retry scheduled: nothing runs on its own afterwards.
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(patchKeywordsForEmails).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('counts an op naming a JMAP account the serving session lost as a rejection', async () => {
    useNetworkStore.setState({ online: false });
    useOutboxStore.getState().enqueue({ kind: 'keywords', emailId: 'e1', accountId: 'gone', patch: { $seen: true } });
    useNetworkStore.setState({ online: true });
    const notInSession = Object.assign(new Error('Superseded by a newer account load'), {
      name: 'StaleLoadError', reason: 'account-not-in-session',
    });
    // While the client is still switching, it is a stop like any stale one.
    patchKeywordsForEmails.mockRejectedValueOnce(notInSession);
    await useOutboxStore.getState().flush();
    expect(useOutboxStore.getState().entries[0].attempts ?? 0).toBe(0);
    // The client serves this account: the shared account is gone.
    Object.assign(serving, { app: ACCOUNT, client: true });
    try {
      patchKeywordsForEmails.mockRejectedValueOnce(notInSession);
      await useOutboxStore.getState().flush();
      expect(useOutboxStore.getState().entries[0].attempts).toBe(1);
    } finally {
      Object.assign(serving, { app: null, client: false });
    }
  });

  it('drops a poison op after repeated server rejections', async () => {
    useNetworkStore.setState({ online: false });
    useOutboxStore.getState().enqueue({ kind: 'keywords', emailId: 'e1', patch: { $seen: true } });
    useNetworkStore.setState({ online: true });

    patchKeywordsForEmails.mockRejectedValue(new Error('JMAP request failed: 400'));

    // MAX_ATTEMPTS is 5; flush bumps one attempt per run.
    for (let i = 0; i < 5; i++) await useOutboxStore.getState().flush();
    expect(useOutboxStore.getState().entries).toHaveLength(0);
  });
});

describe('failed ops and archive replay', () => {
  it('parks a poison op in `failed` instead of dropping it, and retryFailed re-queues it', async () => {
    useNetworkStore.setState({ online: false });
    useOutboxStore.getState().enqueue({ kind: 'keywords', emailId: 'e1', patch: { $seen: true } });
    useNetworkStore.setState({ online: true });

    patchKeywordsForEmails.mockRejectedValue(new Error('JMAP request failed: 400'));
    for (let i = 0; i < 5; i++) await useOutboxStore.getState().flush();
    expect(useOutboxStore.getState().entries).toHaveLength(0);
    expect(useOutboxStore.getState().failed).toHaveLength(1);
    expect(useOutboxStore.getState().failed[0].lastError).toContain('400');

    patchKeywordsForEmails.mockResolvedValue(undefined);
    await useOutboxStore.getState().retryFailed();
    expect(useOutboxStore.getState().failed).toHaveLength(0);
    expect(useOutboxStore.getState().entries).toHaveLength(0);
    expect(patchKeywordsForEmails).toHaveBeenLastCalledWith(['e1'], { $seen: true }, undefined);
  });

  it('discardFailed forgets parked ops', async () => {
    useNetworkStore.setState({ online: false });
    useOutboxStore.getState().enqueue({ kind: 'keywords', emailId: 'e1', patch: { $seen: true } });
    useNetworkStore.setState({ online: true });
    patchKeywordsForEmails.mockRejectedValue(new Error('JMAP request failed: 400'));
    for (let i = 0; i < 5; i++) await useOutboxStore.getState().flush();
    expect(useOutboxStore.getState().failed).toHaveLength(1);
    useOutboxStore.getState().discardFailed();
    expect(useOutboxStore.getState().failed).toHaveLength(0);
  });

  it('pauses the queue on an authentication failure without counting an attempt', async () => {
    useNetworkStore.setState({ online: false });
    useOutboxStore.getState().enqueue({ kind: 'keywords', emailId: 'e1', patch: { $seen: true } });
    useNetworkStore.setState({ online: true });
    const err = new Error('Session expired');
    err.name = 'AuthenticationError';
    patchKeywordsForEmails.mockRejectedValueOnce(err);

    await useOutboxStore.getState().flush();
    expect(useOutboxStore.getState().paused).toBe(true);
    expect(useOutboxStore.getState().entries).toHaveLength(1);
    expect(useOutboxStore.getState().entries[0].attempts).toBe(0);

    // A second flush is a no-op while paused; re-attaching the account lifts it.
    patchKeywordsForEmails.mockClear();
    await useOutboxStore.getState().flush();
    expect(patchKeywordsForEmails).not.toHaveBeenCalled();
    await useOutboxStore.getState().setAccount(ACCOUNT);
    expect(useOutboxStore.getState().paused).toBe(false);
  });

  it('an archive op coalesces with a pending move of the same message', () => {
    useNetworkStore.setState({ online: false });
    const store = useOutboxStore.getState();
    store.enqueue({ kind: 'mailboxes', emailId: 'e1', mailboxIds: { trash: true } });
    store.enqueue({ kind: 'archive', emailId: 'e1', archiveMailboxId: 'arch', mode: 'year', receivedAt: '2026-01-01T00:00:00Z' });
    const entries = useOutboxStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].op.kind).toBe('archive');
  });
});

describe('keyword ops queued by earlier builds', () => {
  beforeEach(async () => {
    patchKeywordsForEmails.mockResolvedValue(undefined);
    await AsyncStorage.removeItem('webmail:outbox:v1:acc-legacy');
    await AsyncStorage.removeItem('webmail:outbox:v1:acc-legacy:failed');
  });

  it('replays a whole keyword map as a patch that sets its keywords and clears nothing else', async () => {
    // Earlier builds queued the message's full keyword map, which replaced
    // the server's: replaying it as-is would erase a star or tag set since.
    const legacy = [
      { id: 'a', createdAt: 1, attempts: 0, op: { kind: 'keywords', emailId: 'e1', keywords: { $seen: true, '$label:work': true, $answered: false } } },
      { id: 'b', createdAt: 2, attempts: 0, op: { kind: 'keywords', emailId: 'e2', accountId: 'grp-1', keywords: { $junk: true } } },
      { id: 'c', createdAt: 3, attempts: 0, op: { kind: 'mailboxes', emailId: 'e3', mailboxIds: { trash: true } } },
    ];
    await AsyncStorage.setItem('webmail:outbox:v1:acc-legacy', JSON.stringify(legacy));
    await useOutboxStore.getState().setAccount('acc-legacy');

    expect(useOutboxStore.getState().entries[0].op).toEqual({
      kind: 'keywords', emailId: 'e1', accountId: undefined, patch: { $seen: true, '$label:work': true },
    });
    await useOutboxStore.getState().flush();

    expect(patchKeywordsForEmails).toHaveBeenNthCalledWith(1, ['e1'], { $seen: true, '$label:work': true }, undefined);
    // `$junk` and `$notjunk` exclude each other, so setting one clears the other.
    expect(patchKeywordsForEmails).toHaveBeenNthCalledWith(2, ['e2'], { $junk: true, $notjunk: null }, 'grp-1');
    expect(setEmailMailboxes).toHaveBeenCalledWith('e3', { trash: true }, undefined);
    expect(useOutboxStore.getState().entries).toHaveLength(0);
  });

  it('upgrades parked failed ops too, so a retry sends a patch', async () => {
    const legacy = [
      { id: 'a', createdAt: 1, attempts: 5, op: { kind: 'keywords', emailId: 'e1', keywords: { $notjunk: true, $flagged: true } } },
    ];
    await AsyncStorage.setItem('webmail:outbox:v1:acc-legacy:failed', JSON.stringify(legacy));
    await useOutboxStore.getState().setAccount('acc-legacy');

    await useOutboxStore.getState().retryFailed();

    expect(patchKeywordsForEmails).toHaveBeenCalledWith(['e1'], { $notjunk: true, $flagged: true, $junk: null }, undefined);
    expect(useOutboxStore.getState().failed).toHaveLength(0);
  });
});

// (c): an online action that runs into an account switch is not dropped. It
// goes to the queue of the account it was made on, which replays it once
// that account is active again.
describe('an online action interrupted by an account switch', () => {
  const OTHER = 'acc-2';
  const staleError = () => Object.assign(new Error('Superseded by a newer account load'), { name: 'StaleLoadError' });
  const stored = async (id: string) => JSON.parse((await AsyncStorage.getItem(`webmail:outbox:v1:${id}`)) ?? 'null');
  /** An online run during which the user switches to OTHER, then the request stops. */
  const switchThenStale = () => vi.fn(async () => {
    await useOutboxStore.getState().setAccount(OTHER);
    throw staleError();
  });

  beforeEach(async () => {
    useToastStore.setState({ toasts: [] });
    await AsyncStorage.multiRemove([`webmail:outbox:v1:${OTHER}`, `webmail:outbox:v1:${OTHER}:failed`]);
  });

  it('lands in the original account\'s stored queue, not the active bucket', async () => {
    const run = switchThenStale();
    await expect(applyOrQueue({ kind: 'keywords', emailId: 'e1', accountId: 'jmap-a', patch: { $seen: true } }, run))
      .rejects.toMatchObject({ name: 'StaleLoadError' });
    const a = await stored(ACCOUNT);
    expect(a).toHaveLength(1);
    expect(a[0].op).toEqual({ kind: 'keywords', emailId: 'e1', accountId: 'jmap-a', patch: { $seen: true } });
    // The account switched to is untouched, in memory and in storage.
    expect(useOutboxStore.getState().activeAccountId).toBe(OTHER);
    expect(useOutboxStore.getState().entries).toEqual([]);
    expect(await AsyncStorage.getItem(`webmail:outbox:v1:${OTHER}`)).toBeNull();
    expect(useToastStore.getState().toasts.map((t) => t.title))
      .toEqual(['This change will finish when you switch back to that account']);
  });

  it('keeps the original account\'s queued and parked entries and coalesces with them', async () => {
    const { applyOrQueueBatch } = await import('../outbox-store');
    useNetworkStore.setState({ online: false });
    useOutboxStore.getState().enqueue({ kind: 'mailboxes', emailId: 'e2', mailboxIds: { trash: true } });
    useOutboxStore.getState().enqueue({ kind: 'destroy', emailId: 'e3' });
    await AsyncStorage.setItem(`webmail:outbox:v1:${ACCOUNT}:failed`, JSON.stringify([{ id: 'f1', op: { kind: 'destroy', emailId: 'x' }, createdAt: 1, attempts: 5 }]));
    useNetworkStore.setState({ online: true });

    // While e1/e4 run online, later actions on them are queued, then the user switches.
    const run = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      useOutboxStore.getState().enqueue({ kind: 'keywords', emailId: 'e1', patch: { $flagged: true, $seen: false } });
      useOutboxStore.getState().enqueue({ kind: 'destroy', emailId: 'e4' });
      await useOutboxStore.getState().setAccount(OTHER);
      throw staleError();
    });
    await expect(applyOrQueueBatch([
      { kind: 'keywords', emailId: 'e1', patch: { $seen: true } },
      { kind: 'keywords', emailId: 'e4', patch: { $seen: true } },
    ], run)).rejects.toMatchObject({ name: 'StaleLoadError' });
    // A second interrupted action on another message is added after them.
    await useOutboxStore.getState().setAccount(ACCOUNT);
    await expect(applyOrQueueBatch([{ kind: 'mailboxes', emailId: 'e5', mailboxIds: { archive: true } }], switchThenStale()))
      .rejects.toMatchObject({ name: 'StaleLoadError' });

    const a: Array<{ op: { emailId: string; kind: string; patch?: Record<string, unknown> } }> = await stored(ACCOUNT);
    expect(a.map((e) => [e.op.emailId, e.op.kind])).toEqual([
      ['e2', 'mailboxes'], ['e3', 'destroy'], ['e1', 'keywords'], ['e4', 'destroy'], ['e5', 'mailboxes'],
    ]);
    // Keyword patches merge, the later action winning (the one queued while the
    // interrupted action ran is the later one); a queued destroy wins.
    expect(a[2].op.patch).toEqual({ $flagged: true, $seen: false });
    // Parked ops are never touched, nor is the account switched to.
    expect(JSON.parse((await AsyncStorage.getItem(`webmail:outbox:v1:${ACCOUNT}:failed`))!)).toHaveLength(1);
    expect(await AsyncStorage.getItem(`webmail:outbox:v1:${OTHER}`)).toBeNull();

    // Back on the original account, the queue holds them for replay.
    await useOutboxStore.getState().setAccount(ACCOUNT);
    expect(useOutboxStore.getState().entries.map((e) => e.op.emailId)).toEqual(['e2', 'e3', 'e1', 'e4', 'e5']);
  });

  it('is not lost when the user switches back while it is being stored', async () => {
    const run = switchThenStale();
    const getItem = vi.mocked(AsyncStorage.getItem);
    const original = getItem.getMockImplementation()!;
    let back: Promise<void> | null = null;
    getItem.mockImplementation(async (k: string) => {
      // The write reads the original account's queue: switch back right then.
      if (k === `webmail:outbox:v1:${ACCOUNT}` && !back) back = useOutboxStore.getState().setAccount(ACCOUNT);
      return original(k);
    });
    try {
      await expect(applyOrQueue({ kind: 'mailboxes', emailId: 'e7', mailboxIds: { archive: true } }, run))
        .rejects.toMatchObject({ name: 'StaleLoadError' });
      expect(back).not.toBeNull();
      await back;
    } finally {
      getItem.mockImplementation(original);
    }
    expect(useOutboxStore.getState().entries.map((e) => e.op.emailId)).toEqual(['e7']);
    expect((await stored(ACCOUNT)).map((e: { op: { emailId: string } }) => e.op.emailId)).toEqual(['e7']);
  });

  it('is not lost when it is queued while the queue is still loading', async () => {
    const run = vi.fn(async () => {
      await useOutboxStore.getState().setAccount(OTHER);
      // Straight back, before the stop is handled; offline so nothing replays.
      void useOutboxStore.getState().setAccount(ACCOUNT);
      useNetworkStore.setState({ online: false });
      throw staleError();
    });
    await AsyncStorage.setItem(`webmail:outbox:v1:${ACCOUNT}`, JSON.stringify([
      { id: 'q1', op: { kind: 'destroy', emailId: 'e1' }, createdAt: 1, attempts: 0 },
    ]));
    const result = await applyOrQueue({ kind: 'mailboxes', emailId: 'e7', mailboxIds: { archive: true } }, run);
    expect(result.queued).toBe(true);
    await vi.waitFor(() => expect(useOutboxStore.getState().hydrated).toBe(true));
    expect(useOutboxStore.getState().entries.map((e) => e.op.emailId)).toEqual(['e1', 'e7']);
    await vi.waitFor(async () => expect((await stored(ACCOUNT)).map((e: { op: { emailId: string } }) => e.op.emailId)).toEqual(['e1', 'e7']));
  });

  it('a connectivity failure after a switch also goes to the original account', async () => {
    const run = vi.fn(async () => {
      await useOutboxStore.getState().setAccount(OTHER);
      throw Object.assign(new Error('Network request failed'), { name: 'NetworkError' });
    });
    await expect(applyOrQueue({ kind: 'destroy', emailId: 'e9' }, run)).rejects.toMatchObject({ name: 'NetworkError' });
    expect((await stored(ACCOUNT)).map((e: { op: { emailId: string } }) => e.op.emailId)).toEqual(['e9']);
    expect(useOutboxStore.getState().entries).toEqual([]);
  });

  it('without a switch, a stale stop queues the op on the same account', async () => {
    const run = vi.fn(async () => { throw staleError(); });
    const result = await applyOrQueue({ kind: 'keywords', emailId: 'e1', patch: { $seen: true } }, run);
    expect(result.queued).toBe(true);
    expect(useOutboxStore.getState().entries).toHaveLength(1);
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
