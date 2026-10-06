import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// NetInfo is a native module; stub it so network-store loads under node. The
// store defaults to online, which we flip per-test via setState.
vi.mock('@react-native-community/netinfo', () => ({
  default: {
    addEventListener: () => () => undefined,
    fetch: async () => ({ isConnected: true, isInternetReachable: true }),
  },
}));

// `accountId`: the client's primary JMAP account (own mail is stamped with it).
// `connectionGen`: the connection every request of an op is bound to.
const { client } = vi.hoisted(() => ({
  client: { isConnected: true, accountId: 'jmap-own' as string | undefined, connectionGen: 1 },
}));
vi.mock('../../api/jmap-client', () => ({
  jmapClient: client,
}));

// Which app account is active, and whether the client serves it. By default
// the client serves the outbox's account (see beforeEach).
const { serving } = vi.hoisted(() => ({ serving: { app: 'acc-1' as string | null, client: true } }));
vi.mock('../../lib/active-client-account', () => ({
  activeAppAccountId: () => serving.app,
  clientServesActiveAccount: () => serving.client,
}));

const patchKeywordsForEmails = vi.fn(async (..._a: any[]) => undefined);
const setEmailMailboxes = vi.fn(async (..._a: any[]) => undefined);
const destroyEmails = vi.fn(async (..._a: any[]) => undefined);
const archiveEmails = vi.fn(async (..._a: any[]) => undefined);
vi.mock('../../api/email', () => ({
  patchKeywordsForEmails: (...a: any[]) => patchKeywordsForEmails(...a),
  setEmailMailboxes: (...a: any[]) => setEmailMailboxes(...a),
  destroyEmails: (...a: any[]) => destroyEmails(...a),
  archiveEmails: (...a: any[]) => archiveEmails(...a),
  unprefixMailboxId: (id: string) => id,
}));

// The folder list an archive replay reads (own and one shared account's).
const { mailboxes } = vi.hoisted(() => ({
  mailboxes: [
    { id: 'own-arch', name: 'Archive', isShared: false },
    { id: 'grp-1:arch', originalId: 'arch', name: 'Archive', isShared: true, accountId: 'grp-1' },
  ] as Array<Record<string, unknown>>,
}));
vi.mock('../email-store', () => ({
  useEmailStore: {
    getState: () => ({ mailboxes, fetchMailboxes: async () => undefined, refreshEmails: async () => undefined }),
  },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useOutboxStore, applyOrQueue } from '../outbox-store';
import { useNetworkStore } from '../network-store';
import { useToastStore } from '../toast-store';

const ACCOUNT = 'acc-1';

/** The scope an op runs with: JMAP account `accountId` on the live connection. */
const onAccount = (accountId: string) => expect.objectContaining({ accountId, gen: client.connectionGen });

beforeEach(async () => {
  vi.clearAllMocks();
  Object.assign(serving, { app: 'acc-1', client: true });
  client.accountId = 'jmap-own';
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
    expect(entries[0].op).toEqual({ kind: 'keywords', emailId: 'e1', accountId: 'jmap-own', patch: { $seen: null, $flagged: true } });
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
    expect(patchKeywordsForEmails).toHaveBeenCalledWith(['e1'], { $seen: true }, onAccount('jmap-own'));
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

    expect(patchKeywordsForEmails).toHaveBeenCalledWith(['e1'], { $seen: true }, onAccount('jmap-own'));
    expect(setEmailMailboxes).toHaveBeenCalledWith('e2', { trash: true }, onAccount('jmap-own'));
    expect(destroyEmails).toHaveBeenCalledWith(['e3'], onAccount('jmap-own'));
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
    // Lost serving mid-request (a switch): a stop like any stale one.
    patchKeywordsForEmails.mockImplementationOnce(async () => {
      serving.client = false;
      throw notInSession;
    });
    await useOutboxStore.getState().flush();
    expect(useOutboxStore.getState().entries[0].attempts ?? 0).toBe(0);
    // The client serves this account: the shared account is gone.
    serving.client = true;
    patchKeywordsForEmails.mockRejectedValueOnce(notInSession);
    await useOutboxStore.getState().flush();
    expect(useOutboxStore.getState().entries[0].attempts).toBe(1);
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
    expect(patchKeywordsForEmails).toHaveBeenLastCalledWith(['e1'], { $seen: true }, onAccount('jmap-own'));
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
    serving.app = 'acc-legacy';
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

    // No account id (older builds): the served connection's primary account.
    expect(patchKeywordsForEmails).toHaveBeenNthCalledWith(1, ['e1'], { $seen: true, '$label:work': true }, onAccount('jmap-own'));
    // `$junk` and `$notjunk` exclude each other, so setting one clears the other.
    expect(patchKeywordsForEmails).toHaveBeenNthCalledWith(2, ['e2'], { $junk: true, $notjunk: null }, onAccount('grp-1'));
    expect(setEmailMailboxes).toHaveBeenCalledWith('e3', { trash: true }, onAccount('jmap-own'));
    expect(useOutboxStore.getState().entries).toHaveLength(0);
  });

  it('upgrades parked failed ops too, so a retry sends a patch', async () => {
    const legacy = [
      { id: 'a', createdAt: 1, attempts: 5, op: { kind: 'keywords', emailId: 'e1', keywords: { $notjunk: true, $flagged: true } } },
    ];
    await AsyncStorage.setItem('webmail:outbox:v1:acc-legacy:failed', JSON.stringify(legacy));
    await useOutboxStore.getState().setAccount('acc-legacy');

    await useOutboxStore.getState().retryFailed();

    expect(patchKeywordsForEmails).toHaveBeenCalledWith(['e1'], { $notjunk: true, $flagged: true, $junk: null }, onAccount('jmap-own'));
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
    // Back on the account, which the client serves: the op is kept, and the
    // flush after it is added replays it (once) rather than leaving it to
    // wait for the next trigger (M1).
    await vi.waitFor(() => expect(setEmailMailboxes).toHaveBeenCalledTimes(1));
    expect(setEmailMailboxes).toHaveBeenCalledWith('e7', { archive: true }, onAccount('jmap-own'));
    await vi.waitFor(() => expect(useOutboxStore.getState().entries).toEqual([]));
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

// R13: a queued change replays only on the connection that serves its account.
describe('replay only on the connection serving the account', () => {
  const queueOffline = (op: Parameters<ReturnType<typeof useOutboxStore.getState>['enqueue']>[0]) => {
    useNetworkStore.setState({ online: false });
    useOutboxStore.getState().enqueue(op);
    useNetworkStore.setState({ online: true });
  };

  it('sends nothing in the switch window and runs the op once the account is served again', async () => {
    queueOffline({ kind: 'keywords', emailId: 'e1', patch: { $seen: true } });
    // B is committed on the client; the outbox is still on A.
    serving.client = false;
    await useOutboxStore.getState().flush();
    expect(patchKeywordsForEmails).not.toHaveBeenCalled();
    const [entry] = useOutboxStore.getState().entries;
    expect(entry.attempts ?? 0).toBe(0);
    expect(entry.lastError).toBeUndefined();
    // A is served again.
    serving.client = true;
    await useOutboxStore.getState().flush();
    expect(patchKeywordsForEmails).toHaveBeenCalledTimes(1);
    expect(patchKeywordsForEmails).toHaveBeenCalledWith(['e1'], { $seen: true }, onAccount('jmap-own'));
    expect(useOutboxStore.getState().entries).toHaveLength(0);
  });

  it('checks again before every op: a switch mid-flush stops the rest', async () => {
    queueOffline({ kind: 'keywords', emailId: 'e1', patch: { $seen: true } });
    queueOffline({ kind: 'destroy', emailId: 'e2' });
    patchKeywordsForEmails.mockImplementationOnce(async () => { serving.client = false; });
    await useOutboxStore.getState().flush();
    expect(destroyEmails).not.toHaveBeenCalled();
    const entries = useOutboxStore.getState().entries;
    expect(entries.map((e) => e.op.emailId)).toEqual(['e2']);
    expect(entries[0].attempts ?? 0).toBe(0);
    expect(entries[0].lastError).toBeUndefined();
  });

  it('does not flush while the app shows another account than the outbox', async () => {
    queueOffline({ kind: 'destroy', emailId: 'e2' });
    serving.app = 'acc-2';
    await useOutboxStore.getState().flush();
    expect(destroyEmails).not.toHaveBeenCalled();
  });

  it('every newly queued op carries an explicit account id', async () => {
    const store = useOutboxStore.getState();
    store.enqueue({ kind: 'mailboxes', emailId: 'e1', mailboxIds: { trash: true } });
    store.enqueue({ kind: 'keywords', emailId: 'e2', accountId: 'grp-1', patch: { $seen: true } });
    useNetworkStore.setState({ online: false });
    await applyOrQueue({ kind: 'destroy', emailId: 'e3' });
    const { applyOrQueueBatch } = await import('../outbox-store');
    await applyOrQueueBatch([{ kind: 'archive', emailId: 'e4', archiveMailboxId: 'own-arch', mode: 'single', receivedAt: '2026-01-01T00:00:00Z' }]);
    expect(useOutboxStore.getState().entries.map((e) => [e.op.emailId, e.op.accountId])).toEqual([
      ['e1', 'jmap-own'], ['e2', 'grp-1'], ['e3', 'jmap-own'], ['e4', 'jmap-own'],
    ]);
    expect(JSON.parse((await AsyncStorage.getItem(`webmail:outbox:v1:${ACCOUNT}`))!)
      .every((e: { op: { accountId?: string } }) => typeof e.op.accountId === 'string')).toBe(true);
  });

  it('the online path passes the stamped account id too', async () => {
    await applyOrQueue({ kind: 'destroy', emailId: 'e1' });
    expect(destroyEmails).toHaveBeenCalledWith(['e1'], onAccount('jmap-own'));
  });

  it('replay passes the op\'s own account id, not the primary at run time', async () => {
    queueOffline({ kind: 'mailboxes', emailId: 'e1', mailboxIds: { trash: true } });
    queueOffline({ kind: 'destroy', emailId: 'e2', accountId: 'grp-1' });
    client.accountId = 'jmap-later';
    await useOutboxStore.getState().flush();
    expect(setEmailMailboxes).toHaveBeenCalledWith('e1', { trash: true }, onAccount('jmap-own'));
    expect(destroyEmails).toHaveBeenCalledWith(['e2'], onAccount('grp-1'));

    client.accountId = 'jmap-own';
    queueOffline({ kind: 'archive', emailId: 'e3', archiveMailboxId: 'own-arch', mode: 'year', receivedAt: '2026-01-01T00:00:00Z' });
    queueOffline({ kind: 'archive', emailId: 'e4', accountId: 'grp-1', archiveMailboxId: 'arch', mode: 'year', receivedAt: '2026-01-01T00:00:00Z' });
    await useOutboxStore.getState().flush();
    // Own archive: own folders; shared: that account's folders, unprefixed.
    expect(archiveEmails.mock.calls[0][3].map((m: { id: string }) => m.id)).toEqual(['own-arch']);
    expect(archiveEmails.mock.calls[0][4]).toEqual(onAccount('jmap-own'));
    expect(archiveEmails.mock.calls[1][3].map((m: { id: string }) => m.id)).toEqual(['arch']);
    expect(archiveEmails.mock.calls[1][4]).toEqual(onAccount('grp-1'));
  });

  it('an op queued while the client did not serve the account is left for replay to resolve', () => {
    serving.client = false;
    useOutboxStore.getState().enqueue({ kind: 'destroy', emailId: 'e1' });
    expect(useOutboxStore.getState().entries[0].op.accountId).toBeUndefined();
  });

  it('a legacy op without an account id runs only while served, on the primary at run time', async () => {
    await AsyncStorage.setItem(`webmail:outbox:v1:acc-old`, JSON.stringify([
      { id: 'x', createdAt: 1, attempts: 0, op: { kind: 'destroy', emailId: 'e1' } },
    ]));
    await useOutboxStore.getState().setAccount('acc-old');
    serving.app = 'acc-old';
    serving.client = false;
    await useOutboxStore.getState().flush();
    expect(destroyEmails).not.toHaveBeenCalled();
    serving.client = true;
    await useOutboxStore.getState().flush();
    expect(destroyEmails).toHaveBeenCalledWith(['e1'], onAccount('jmap-own'));
    // Not migrated on disk beforehand: the stored entry was removed by the run, never rewritten with an id.
    expect(JSON.parse((await AsyncStorage.getItem(`webmail:outbox:v1:acc-old`))!)).toEqual([]);
    await AsyncStorage.removeItem(`webmail:outbox:v1:acc-old`);
  });
});

// C1 (R15): during a switch the app already shows B (the outbox is on B) while
// the client still serves A. An action on one of B's rows must not run on A,
// where the same id (Stalwart numbers them per account) is another message.
describe('the online path runs only on the connection serving the account (C1)', () => {
  const B = 'acc-2';
  const showBWhileServingA = async () => {
    await useOutboxStore.getState().setAccount(B);
    await useOutboxStore.getState().clear();
    // The account store (and the client) are still on A.
    serving.app = ACCOUNT;
    serving.client = true;
  };
  afterEach(async () => {
    await useOutboxStore.getState().setAccount(B);
    await useOutboxStore.getState().clear();
  });

  it("a destroy of B's row in the switch window runs nothing on A and is queued for B", async () => {
    await showBWhileServingA();
    const result = await applyOrQueue({ kind: 'destroy', emailId: 'b-msg-7' });
    expect(result.queued).toBe(true);
    expect(destroyEmails).not.toHaveBeenCalled();
    // Queued for B, its account left for replay on B's connection to fill in.
    expect(useOutboxStore.getState().entries.map((e) => e.op)).toEqual([{ kind: 'destroy', emailId: 'b-msg-7' }]);
    expect(JSON.parse((await AsyncStorage.getItem(`webmail:outbox:v1:${B}`))!)
      .map((e: { op: unknown }) => e.op)).toEqual([{ kind: 'destroy', emailId: 'b-msg-7' }]);

    // B is served: the op replays there, once.
    serving.app = B;
    client.accountId = 'jmap-b';
    await useOutboxStore.getState().flush();
    expect(destroyEmails).toHaveBeenCalledTimes(1);
    expect(destroyEmails).toHaveBeenCalledWith(['b-msg-7'], onAccount('jmap-b'));
  });

  it('an online runner is not called in the switch window', async () => {
    await showBWhileServingA();
    const run = vi.fn(async () => undefined);
    const { applyOrQueueBatch } = await import('../outbox-store');
    const result = await applyOrQueueBatch([
      { kind: 'mailboxes', emailId: 'b-msg-1', mailboxIds: { trash: true } },
      { kind: 'keywords', emailId: 'b-msg-1', patch: { $seen: true } },
    ], run);
    expect(result.queued).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(setEmailMailboxes).not.toHaveBeenCalled();
    expect(patchKeywordsForEmails).not.toHaveBeenCalled();
    expect(useOutboxStore.getState().entries).toHaveLength(2);
  });

  it('nothing runs while the client serves no account the app knows', async () => {
    serving.client = false;
    const result = await applyOrQueue({ kind: 'destroy', emailId: 'e1' }, async () => {
      throw new Error('must not run');
    });
    expect(result.queued).toBe(true);
    expect(destroyEmails).not.toHaveBeenCalled();
  });

  it('the online runner gets the connection the action started on', async () => {
    const run = vi.fn(async (_at: unknown) => undefined);
    await applyOrQueue({ kind: 'destroy', emailId: 'e1' }, run);
    expect(run).toHaveBeenCalledWith(onAccount('jmap-own'));
  });
});

// M3: an action stopped by a switch whose account's stored queue can't be read
// is not dropped without a word.
describe('a change that cannot be stored for the account left (M3)', () => {
  it('tells the user it could not be saved', async () => {
    useToastStore.setState({ toasts: [] });
    await AsyncStorage.setItem(`webmail:outbox:v1:${ACCOUNT}`, '{not json');
    const run = vi.fn(async () => {
      await useOutboxStore.getState().setAccount('acc-2');
      throw Object.assign(new Error('Superseded by a newer account load'), { name: 'StaleLoadError' });
    });
    await expect(applyOrQueue({ kind: 'destroy', emailId: 'e1' }, run)).rejects.toMatchObject({ name: 'StaleLoadError' });
    expect(useToastStore.getState().toasts.map((t) => t.message ?? t.title))
      .toContain('This change could not be saved');
    // The unreadable queue is left as it was, never overwritten.
    expect(await AsyncStorage.getItem(`webmail:outbox:v1:${ACCOUNT}`)).toBe('{not json');
    await AsyncStorage.removeItem(`webmail:outbox:v1:${ACCOUNT}`);
    await useOutboxStore.getState().setAccount('acc-2');
    await useOutboxStore.getState().clear();
  });
});
