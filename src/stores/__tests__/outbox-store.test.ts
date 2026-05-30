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

const setEmailKeywords = vi.fn(async (..._a: any[]) => undefined);
const setEmailMailboxes = vi.fn(async (..._a: any[]) => undefined);
const destroyEmails = vi.fn(async (..._a: any[]) => undefined);
vi.mock('../../api/email', () => ({
  setEmailKeywords: (...a: any[]) => setEmailKeywords(...a),
  setEmailMailboxes: (...a: any[]) => setEmailMailboxes(...a),
  destroyEmails: (...a: any[]) => destroyEmails(...a),
}));

import { useOutboxStore, applyOrQueue } from '../outbox-store';
import { useNetworkStore } from '../network-store';

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
  it('coalesces repeated keyword ops for the same email (last-write-wins)', () => {
    const store = useOutboxStore.getState();
    store.enqueue({ kind: 'keywords', emailId: 'e1', keywords: { $seen: true } });
    store.enqueue({ kind: 'keywords', emailId: 'e1', keywords: { $seen: true, $flagged: true } });

    const entries = useOutboxStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].op).toEqual({ kind: 'keywords', emailId: 'e1', keywords: { $seen: true, $flagged: true } });
  });

  it('keeps keyword and mailbox ops for the same email separate', () => {
    const store = useOutboxStore.getState();
    store.enqueue({ kind: 'keywords', emailId: 'e1', keywords: { $seen: true } });
    store.enqueue({ kind: 'mailboxes', emailId: 'e1', mailboxIds: { archive: true } });
    expect(useOutboxStore.getState().entries).toHaveLength(2);
  });

  it('destroy supersedes pending edits for that email', () => {
    const store = useOutboxStore.getState();
    store.enqueue({ kind: 'keywords', emailId: 'e1', keywords: { $seen: true } });
    store.enqueue({ kind: 'mailboxes', emailId: 'e1', mailboxIds: { archive: true } });
    store.enqueue({ kind: 'destroy', emailId: 'e1' });

    const entries = useOutboxStore.getState().entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].op.kind).toBe('destroy');
  });

  it('ignores further edits once a destroy is queued', () => {
    const store = useOutboxStore.getState();
    store.enqueue({ kind: 'destroy', emailId: 'e1' });
    store.enqueue({ kind: 'keywords', emailId: 'e1', keywords: { $seen: true } });
    expect(useOutboxStore.getState().entries).toHaveLength(1);
    expect(useOutboxStore.getState().entries[0].op.kind).toBe('destroy');
  });
});

describe('applyOrQueue', () => {
  it('runs immediately when online with an empty queue', async () => {
    const result = await applyOrQueue({ kind: 'keywords', emailId: 'e1', keywords: { $seen: true } });
    expect(result.queued).toBe(false);
    expect(setEmailKeywords).toHaveBeenCalledWith('e1', { $seen: true });
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
    const result = await applyOrQueue({ kind: 'keywords', emailId: 'e1', keywords: { $seen: true } });
    expect(result.queued).toBe(true);
    expect(setEmailKeywords).not.toHaveBeenCalled();
    expect(useOutboxStore.getState().entries).toHaveLength(1);
  });

  it('queues a later op for the same email to preserve order', async () => {
    useNetworkStore.setState({ online: false });
    await applyOrQueue({ kind: 'mailboxes', emailId: 'e1', mailboxIds: { a: true } });
    useNetworkStore.setState({ online: true });
    // Now online, but an op is already queued for e1 → must queue, not run.
    const result = await applyOrQueue({ kind: 'keywords', emailId: 'e1', keywords: { $seen: true } });
    expect(result.queued).toBe(true);
    expect(setEmailKeywords).not.toHaveBeenCalled();
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
    const result = await applyOrQueue({ kind: 'keywords', emailId: 'e1', keywords: { $seen: true } }, onlineRun);
    expect(result.queued).toBe(true);
    expect(useOutboxStore.getState().entries).toHaveLength(1);
  });
});

describe('flush', () => {
  it('replays queued ops in order and clears them', async () => {
    useNetworkStore.setState({ online: false });
    const store = useOutboxStore.getState();
    store.enqueue({ kind: 'keywords', emailId: 'e1', keywords: { $seen: true } });
    store.enqueue({ kind: 'mailboxes', emailId: 'e2', mailboxIds: { trash: true } });
    store.enqueue({ kind: 'destroy', emailId: 'e3' });

    useNetworkStore.setState({ online: true });
    await useOutboxStore.getState().flush();

    expect(setEmailKeywords).toHaveBeenCalledWith('e1', { $seen: true });
    expect(setEmailMailboxes).toHaveBeenCalledWith('e2', { trash: true });
    expect(destroyEmails).toHaveBeenCalledWith(['e3']);
    expect(useOutboxStore.getState().entries).toHaveLength(0);
  });

  it('does nothing while offline', async () => {
    useNetworkStore.setState({ online: false });
    useOutboxStore.getState().enqueue({ kind: 'keywords', emailId: 'e1', keywords: { $seen: true } });
    await useOutboxStore.getState().flush();
    expect(setEmailKeywords).not.toHaveBeenCalled();
    expect(useOutboxStore.getState().entries).toHaveLength(1);
  });

  it('stops and retains the op on a transient failure', async () => {
    useNetworkStore.setState({ online: false });
    useOutboxStore.getState().enqueue({ kind: 'keywords', emailId: 'e1', keywords: { $seen: true } });
    useNetworkStore.setState({ online: true });

    const err = new Error('Network request failed');
    err.name = 'NetworkError';
    setEmailKeywords.mockRejectedValueOnce(err);

    await useOutboxStore.getState().flush();
    expect(useOutboxStore.getState().entries).toHaveLength(1);
    expect(useOutboxStore.getState().entries[0].lastError).toContain('Network');
  });

  it('drops a poison op after repeated server rejections', async () => {
    useNetworkStore.setState({ online: false });
    useOutboxStore.getState().enqueue({ kind: 'keywords', emailId: 'e1', keywords: { $seen: true } });
    useNetworkStore.setState({ online: true });

    setEmailKeywords.mockRejectedValue(new Error('JMAP request failed: 400'));

    // MAX_ATTEMPTS is 5; flush bumps one attempt per run.
    for (let i = 0; i < 5; i++) await useOutboxStore.getState().flush();
    expect(useOutboxStore.getState().entries).toHaveLength(0);
  });
});
