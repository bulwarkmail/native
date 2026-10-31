import { describe, it, expect, vi, beforeEach } from 'vitest';

// NetInfo is a native module; stub it so network-store loads under node. The
// store defaults to online, which we flip per-test via setState.
vi.mock('@react-native-community/netinfo', () => ({
  default: {
    addEventListener: () => () => undefined,
    fetch: async () => ({ isConnected: true, isInternetReachable: true }),
  },
}));

// The account (username@host) the JMAP client serves; null while it serves
// none, as while it loads another one.
const client = vi.hoisted(() => ({ served: null as string | null }));
vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    get isConnected() { return client.served !== null; },
    get username() { return client.served ? client.served.split('@')[0] : null; },
    get serverUrl() { return client.served ? `https://${client.served.split('@')[1]}` : null; },
  },
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

const ACCOUNT = 'user1@mail.example.org';

beforeEach(async () => {
  vi.clearAllMocks();
  client.served = ACCOUNT;
  useNetworkStore.setState({ online: true, connected: true });
  // Detach then attach a clean bucket (AsyncStorage is the in-memory mock).
  await useOutboxStore.getState().setAccount(null);
  await useOutboxStore.getState().clear();
  await useOutboxStore.getState().setAccount(ACCOUNT);
  await useOutboxStore.getState().clear();
  // The account's session is up and its server was checked (auth-store).
  await useOutboxStore.getState().resume(ACCOUNT);
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

  it('sends an edit merged into an entry while that entry was being sent', async () => {
    useNetworkStore.setState({ online: false });
    useOutboxStore.getState().enqueue({ kind: 'keywords', emailId: 'e1', patch: { $flagged: true } });
    useNetworkStore.setState({ online: true });

    // The star is out when the Undo comes in and coalesces into its entry.
    let release!: () => void;
    patchKeywordsForEmails.mockImplementationOnce(() => new Promise<undefined>((r) => { release = () => r(undefined); }));
    const flushing = useOutboxStore.getState().flush();
    await vi.waitFor(() => expect(patchKeywordsForEmails).toHaveBeenCalledTimes(1));
    useOutboxStore.getState().enqueue({ kind: 'keywords', emailId: 'e1', patch: { $flagged: null } });
    release();
    await flushing;

    await vi.waitFor(() => expect(patchKeywordsForEmails).toHaveBeenCalledTimes(2));
    expect(patchKeywordsForEmails).toHaveBeenLastCalledWith(['e1'], { $flagged: null }, undefined);
    await vi.waitFor(() => expect(useOutboxStore.getState().entries).toHaveLength(0));
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
  const LEGACY = 'legacy@mail.example.org';

  beforeEach(async () => {
    patchKeywordsForEmails.mockResolvedValue(undefined);
    await AsyncStorage.removeItem(`webmail:outbox:v1:${LEGACY}`);
    await AsyncStorage.removeItem(`webmail:outbox:v1:${LEGACY}:failed`);
    client.served = LEGACY;
  });

  it('replays a whole keyword map as a patch that sets its keywords and clears nothing else', async () => {
    // Earlier builds queued the message's full keyword map, which replaced
    // the server's: replaying it as-is would erase a star or tag set since.
    const legacy = [
      { id: 'a', createdAt: 1, attempts: 0, op: { kind: 'keywords', emailId: 'e1', keywords: { $seen: true, '$label:work': true, $answered: false } } },
      { id: 'b', createdAt: 2, attempts: 0, op: { kind: 'keywords', emailId: 'e2', accountId: 'grp-1', keywords: { $junk: true } } },
      { id: 'c', createdAt: 3, attempts: 0, op: { kind: 'mailboxes', emailId: 'e3', mailboxIds: { trash: true } } },
    ];
    await AsyncStorage.setItem(`webmail:outbox:v1:${LEGACY}`, JSON.stringify(legacy));
    await useOutboxStore.getState().setAccount(LEGACY);

    expect(useOutboxStore.getState().entries[0].op).toEqual({
      kind: 'keywords', emailId: 'e1', accountId: undefined, patch: { $seen: true, '$label:work': true },
    });
    await useOutboxStore.getState().resume(LEGACY);

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
    await AsyncStorage.setItem(`webmail:outbox:v1:${LEGACY}:failed`, JSON.stringify(legacy));
    await useOutboxStore.getState().setAccount(LEGACY);
    await useOutboxStore.getState().resume(LEGACY);

    await useOutboxStore.getState().retryFailed();

    expect(patchKeywordsForEmails).toHaveBeenCalledWith(['e1'], { $notjunk: true, $flagged: true, $junk: null }, undefined);
    expect(useOutboxStore.getState().failed).toHaveLength(0);
  });
});

describe('waiting for the account session (resume)', () => {
  const OTHER = 'user2@mail.example.org';
  const stored = (emailId: string) => ({
    id: `q-${emailId}`, createdAt: 1, attempts: 0, op: { kind: 'keywords', emailId, patch: { $seen: true } },
  });

  beforeEach(async () => {
    await AsyncStorage.removeItem(`webmail:outbox:v1:${OTHER}`);
    await AsyncStorage.removeItem(`webmail:outbox:v1:${OTHER}:failed`);
  });

  it('queues and holds the ops of a newly attached account until it is resumed', async () => {
    // Attached on an account switch: the client may still serve the account
    // being left, although it reports itself connected.
    await useOutboxStore.getState().setAccount(OTHER);
    const result = await applyOrQueue({ kind: 'keywords', emailId: 'e1', patch: { $seen: true } });
    expect(result.queued).toBe(true);
    await useOutboxStore.getState().flush();
    expect(patchKeywordsForEmails).not.toHaveBeenCalled();

    client.served = OTHER;
    await useOutboxStore.getState().resume(OTHER);

    expect(patchKeywordsForEmails).toHaveBeenCalledWith(['e1'], { $seen: true }, undefined);
    expect(useOutboxStore.getState().entries).toHaveLength(0);
  });

  it('replays nothing when another account was attached while the queue loaded', async () => {
    await AsyncStorage.setItem(`webmail:outbox:v1:${OTHER}`, JSON.stringify([stored('e1')]));
    client.served = OTHER;

    // The mail list shows OTHER, then ACCOUNT before OTHER's queue was read.
    void useOutboxStore.getState().setAccount(OTHER);
    const resuming = useOutboxStore.getState().resume(OTHER);
    void useOutboxStore.getState().setAccount(ACCOUNT);
    await resuming;

    expect(patchKeywordsForEmails).not.toHaveBeenCalled();
    expect(useOutboxStore.getState().activeAccountId).toBe(ACCOUNT);
    expect(useOutboxStore.getState().resumed).toBe(false);
  });

  it('does not take the queue over for an account the mail list does not show', async () => {
    // A switch or sign-in that ends after the user moved on to another account.
    await AsyncStorage.setItem(`webmail:outbox:v1:${OTHER}`, JSON.stringify([stored('e1')]));
    client.served = OTHER;

    await useOutboxStore.getState().resume(OTHER);

    expect(patchKeywordsForEmails).not.toHaveBeenCalled();
    expect(useOutboxStore.getState().activeAccountId).toBe(ACCOUNT);
  });

  it('keeps a queue cleared while it was still loading cleared', async () => {
    // The server check drops the queue of a replaced server while the cold
    // start is still reading it.
    await AsyncStorage.setItem(`webmail:outbox:v1:${OTHER}`, JSON.stringify([stored('e1')]));

    const attaching = useOutboxStore.getState().setAccount(OTHER);
    await useOutboxStore.getState().clearAccount(OTHER);
    await attaching;

    expect(useOutboxStore.getState().entries).toEqual([]);
    expect(await AsyncStorage.getItem(`webmail:outbox:v1:${OTHER}`)).toBeNull();
    client.served = OTHER;
    await useOutboxStore.getState().resume(OTHER);
    expect(patchKeywordsForEmails).not.toHaveBeenCalled();
  });

  it('keeps ops made while the queue was loading, after the stored ones', async () => {
    await AsyncStorage.setItem(`webmail:outbox:v1:${OTHER}`, JSON.stringify([stored('e1')]));

    const attaching = useOutboxStore.getState().setAccount(OTHER);
    useOutboxStore.getState().enqueue({ kind: 'mailboxes', emailId: 'e2', mailboxIds: { trash: true } });
    await attaching;

    expect(useOutboxStore.getState().entries.map((e) => e.op.emailId)).toEqual(['e1', 'e2']);
    const persisted = JSON.parse((await AsyncStorage.getItem(`webmail:outbox:v1:${OTHER}`))!) as Array<{ op: { emailId: string } }>;
    expect(persisted.map((e) => e.op.emailId)).toEqual(['e1', 'e2']);
  });
});

describe('while the JMAP client serves another account', () => {
  // Signing in to an account being added moves the client first; the queue
  // follows once the new account is set up.
  const ADDED = 'user3@mail.example.org';

  beforeEach(() => {
    patchKeywordsForEmails.mockResolvedValue(undefined);
    useNetworkStore.setState({ online: false });
  });

  it('neither replays the queue nor runs an edit through it', async () => {
    useOutboxStore.getState().enqueue({ kind: 'keywords', emailId: 'e1', patch: { $seen: true } });
    useNetworkStore.setState({ online: true });
    client.served = ADDED;

    await useOutboxStore.getState().flush();
    const result = await applyOrQueue({ kind: 'keywords', emailId: 'e2', patch: { $seen: true } });

    expect(result.queued).toBe(true);
    expect(patchKeywordsForEmails).not.toHaveBeenCalled();
    client.served = ACCOUNT;
    await useOutboxStore.getState().flush();
    expect(patchKeywordsForEmails.mock.calls.map(([ids]) => ids)).toEqual([['e1'], ['e2']]);
  });

  it('stops a replay under way once the client moved on', async () => {
    useOutboxStore.getState().enqueue({ kind: 'keywords', emailId: 'e1', patch: { $seen: true } });
    useOutboxStore.getState().enqueue({ kind: 'mailboxes', emailId: 'e2', mailboxIds: { trash: true } });
    useNetworkStore.setState({ online: true });
    // The sign-in's session comes up while e1 is on its way.
    patchKeywordsForEmails.mockImplementationOnce(async () => { client.served = ADDED; });

    await useOutboxStore.getState().flush();

    expect(patchKeywordsForEmails).toHaveBeenCalledTimes(1);
    expect(setEmailMailboxes).not.toHaveBeenCalled();
    expect(useOutboxStore.getState().entries.map((e) => e.op.emailId)).toEqual(['e2']);
  });

  it('holds the queue on suspend and names the account to resume', async () => {
    useOutboxStore.getState().enqueue({ kind: 'keywords', emailId: 'e1', patch: { $seen: true } });
    useNetworkStore.setState({ online: true });

    expect(useOutboxStore.getState().suspend()).toBe(ACCOUNT);
    await useOutboxStore.getState().flush();
    expect(patchKeywordsForEmails).not.toHaveBeenCalled();
    // Held already: nothing to resume.
    expect(useOutboxStore.getState().suspend()).toBeNull();

    await useOutboxStore.getState().resume(ACCOUNT);
    expect(patchKeywordsForEmails).toHaveBeenCalledWith(['e1'], { $seen: true }, undefined);
  });
});
