import { describe, it, expect, vi, beforeEach } from 'vitest';

// The offline send queue in the outbox store: messages wait while offline,
// survive a restart, go out once, and an attempt that may have got through
// is sent again only through runQueuedSend's lookup (maybeSent).

const client = vi.hoisted(() => ({ served: 'user1@mail.example.org' as string | null }));
vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    get isConnected() { return client.served !== null; },
    get username() { return client.served ? client.served.split('@')[0] : null; },
    get serverUrl() { return client.served ? `https://${client.served.split('@')[1]}` : null; },
  },
}));

const patchKeywordsForEmails = vi.fn(async (..._a: any[]) => undefined);
const saveDraftVersion = vi.fn(async (..._a: any[]) => ({ id: 'draft-2', attachments: [] }));
vi.mock('../../api/email', () => ({
  patchKeywordsForEmails: (...a: any[]) => patchKeywordsForEmails(...a),
  setEmailMailboxes: vi.fn(),
  destroyEmails: vi.fn(),
  archiveEmails: vi.fn(),
  unprefixMailboxId: (id: string) => id,
  saveDraftVersion: (...a: any[]) => saveDraftVersion(...a),
}));

const runQueuedSend = vi.fn(async (..._a: any[]): Promise<any> => ({ kind: 'sent', result: { scheduled: false } }));
const wasQueuedSendSent = vi.fn(async (..._a: any[]) => false);
vi.mock('../../api/queued-send', () => ({
  runQueuedSend: (...a: any[]) => runQueuedSend(...a),
  wasQueuedSendSent: (...a: any[]) => wasQueuedSendSent(...a),
}));
vi.mock('../email-store', () => ({
  useEmailStore: { getState: () => ({ mailboxes: [{ id: 'sent', role: 'sent' }] }) },
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() }));
vi.mock('../toast-store', () => ({ toast }));
vi.mock('../locale-store', () => ({
  useLocaleStore: { getState: () => ({ t: (_k: string, fallback?: string) => fallback ?? _k }) },
}));

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useOutboxStore } from '../outbox-store';
import { useNetworkStore } from '../network-store';
import type { QueuedSendPayload } from '../../lib/send-queue';

const ACCOUNT = 'user1@mail.example.org';
const SENDS_KEY = `webmail:outbox:v1:${ACCOUNT}:sends`;

const payload = (subject = 'Hello'): QueuedSendPayload => ({
  outgoing: { from: [{ email: 'me@x.de' }], to: [{ email: 'you@x.de' }], subject, textBody: 'Hi', messageId: `${subject}@x.de` },
  identity: { id: 'id-1', email: 'me@x.de', name: 'Me' } as QueuedSendPayload['identity'],
  fromEmail: 'me@x.de',
  sentMailboxId: 'sent',
  draftsMailboxId: 'drafts',
  draftId: 'draft-1',
  original: { emailId: 'orig-1', keyword: '$answered' },
});

const named = (name: string, message = name) => Object.assign(new Error(message), { name });
const flushed = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  vi.clearAllMocks();
  client.served = ACCOUNT;
  useNetworkStore.setState({ online: false, connected: false });
  await useOutboxStore.getState().setAccount(null);
  await useOutboxStore.getState().setAccount(ACCOUNT);
  await useOutboxStore.getState().clear();
  await useOutboxStore.getState().resume(ACCOUNT);
});

describe('offline send queue', () => {
  it('keeps a message while offline and sends it once when the connection is back', async () => {
    useOutboxStore.getState().enqueueSend(payload());
    await useOutboxStore.getState().flush();
    expect(runQueuedSend).not.toHaveBeenCalled();
    expect(useOutboxStore.getState().sends).toHaveLength(1);

    useNetworkStore.setState({ online: true, connected: true });
    await useOutboxStore.getState().flush();
    expect(runQueuedSend).toHaveBeenCalledTimes(1);
    // Marked before the request left.
    expect(runQueuedSend.mock.calls[0][0]).toMatchObject({ status: 'sending', maybeSent: true });
    expect(useOutboxStore.getState().sends).toEqual([]);
    expect(JSON.parse((await AsyncStorage.getItem(SENDS_KEY))!)).toEqual([]);

    await useOutboxStore.getState().flush();
    expect(runQueuedSend).toHaveBeenCalledTimes(1);
    await flushed();
    // The original gets its reply arrow.
    expect(patchKeywordsForEmails).toHaveBeenCalledWith(['orig-1'], { $answered: true }, undefined);
  });

  it('survives a restart of the app', async () => {
    useOutboxStore.getState().enqueueSend(payload('kept'));
    await flushed();
    await useOutboxStore.getState().setAccount(null);
    expect(useOutboxStore.getState().sends).toEqual([]);
    await useOutboxStore.getState().setAccount(ACCOUNT);
    expect(useOutboxStore.getState().sends.map((s) => s.payload.outgoing.subject)).toEqual(['kept']);
  });

  it('marks a message whose attempt the app was killed in, so the next attempt looks for it first', async () => {
    const id = useOutboxStore.getState().enqueueSend(payload())!;
    await flushed();
    // What the store persisted right before the request left.
    const stored = JSON.parse((await AsyncStorage.getItem(SENDS_KEY))!);
    stored[0] = { ...stored[0], status: 'sending', maybeSent: true };
    await AsyncStorage.setItem(SENDS_KEY, JSON.stringify(stored));
    await useOutboxStore.getState().setAccount(null);
    await useOutboxStore.getState().setAccount(ACCOUNT);
    expect(useOutboxStore.getState().sends[0]).toMatchObject({ id, status: 'queued', maybeSent: true });
  });

  it('keeps a message queued and marked when the connection breaks mid-send', async () => {
    useNetworkStore.setState({ online: true, connected: true });
    runQueuedSend.mockRejectedValueOnce(named('NetworkError', 'Network request failed'));
    useOutboxStore.getState().enqueueSend(payload());
    await flushed();
    await flushed();
    expect(useOutboxStore.getState().sends[0]).toMatchObject({ status: 'queued', maybeSent: true, attempts: 0 });

    // The retry hands the mark on: runQueuedSend looks for the message first.
    useOutboxStore.setState({ flushing: false });
    await useOutboxStore.getState().flush();
    expect(runQueuedSend).toHaveBeenCalledTimes(2);
    expect(useOutboxStore.getState().sends).toEqual([]);
  });

  it('never sends one message twice from overlapping flushes', async () => {
    useOutboxStore.getState().enqueueSend(payload());
    let release!: () => void;
    runQueuedSend.mockImplementationOnce(() => new Promise((r) => { release = () => r({ kind: 'sent', result: {} }); }));
    useNetworkStore.setState({ online: true, connected: true });
    const first = useOutboxStore.getState().flush();
    await flushed();
    const second = useOutboxStore.getState().flush();
    release();
    await Promise.all([first, second]);
    expect(runQueuedSend).toHaveBeenCalledTimes(1);
  });

  it('sends a message queued while another one is on its way', async () => {
    let release!: () => void;
    runQueuedSend.mockImplementationOnce(() => new Promise((r) => { release = () => r({ kind: 'sent', result: {} }); }));
    useNetworkStore.setState({ online: true, connected: true });
    useOutboxStore.getState().enqueueSend(payload('first'));
    await flushed();
    expect(runQueuedSend).toHaveBeenCalledTimes(1);
    useOutboxStore.getState().enqueueSend(payload('second'));
    release();
    await vi.waitFor(() => expect(useOutboxStore.getState().sends).toEqual([]));
    expect(runQueuedSend.mock.calls.map(([s]) => s.payload.outgoing.subject)).toEqual(['first', 'second']);
  });

  it('sends a message retried while another one is on its way', async () => {
    useNetworkStore.setState({ online: true, connected: true });
    runQueuedSend.mockRejectedValueOnce(new Error('Invalid envelope'));
    const failed = useOutboxStore.getState().enqueueSend(payload('failed'))!;
    await vi.waitFor(() => expect(useOutboxStore.getState().sends[0]?.status).toBe('failed'));

    let release!: () => void;
    runQueuedSend.mockImplementationOnce(() => new Promise((r) => { release = () => r({ kind: 'sent', result: {} }); }));
    useOutboxStore.getState().enqueueSend(payload('other'));
    await flushed();
    expect(runQueuedSend).toHaveBeenCalledTimes(2);
    const retried = useOutboxStore.getState().retrySend(failed);
    release();
    await retried;
    await vi.waitFor(() => expect(useOutboxStore.getState().sends).toEqual([]));
    expect(runQueuedSend.mock.calls.map(([s]) => s.payload.outgoing.subject)).toEqual(['failed', 'other', 'failed']);
  });

  it('parks a refused message with its reason and leaves it until the user tries again', async () => {
    useNetworkStore.setState({ online: true, connected: true });
    runQueuedSend.mockRejectedValueOnce(new Error('Invalid envelope'));
    const id = useOutboxStore.getState().enqueueSend(payload())!;
    await flushed();
    await flushed();
    expect(useOutboxStore.getState().sends[0]).toMatchObject({ status: 'failed', lastError: 'Invalid envelope', maybeSent: false });
    await useOutboxStore.getState().flush();
    expect(runQueuedSend).toHaveBeenCalledTimes(1);

    await useOutboxStore.getState().retrySend(id);
    expect(runQueuedSend).toHaveBeenCalledTimes(2);
    expect(useOutboxStore.getState().sends).toEqual([]);
  });

  it('says so when a message fails after too many unconfirmed attempts, as for a refused one', async () => {
    useNetworkStore.setState({ online: true, connected: true });
    runQueuedSend.mockRejectedValueOnce(new Error('Invalid envelope'));
    useOutboxStore.getState().enqueueSend(payload('refused'));
    await flushed();
    await flushed();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error.mock.calls[0][1]).toEqual({ message: 'refused: Invalid envelope' });

    toast.error.mockClear();
    const id = useOutboxStore.getState().enqueueSend(payload('unconfirmed'))!;
    useOutboxStore.setState({ sends: useOutboxStore.getState().sends.map((s) => (s.id === id ? { ...s, attempts: 2 } : s)) });
    runQueuedSend.mockRejectedValueOnce(named('SendUnconfirmedError', 'Send confirmation was not received'));
    useOutboxStore.setState({ flushing: false });
    await useOutboxStore.getState().flush();
    await flushed();
    expect(useOutboxStore.getState().sends.find((s) => s.id === id)).toMatchObject({ status: 'failed', attempts: 3 });
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(toast.error.mock.calls[0]).toEqual([
      'A message in the Outbox could not be sent', { message: 'unconfirmed: Send confirmation was not received' },
    ]);
  });

  it('does not report an unconfirmed attempt that will be tried again', async () => {
    useNetworkStore.setState({ online: true, connected: true });
    runQueuedSend.mockRejectedValueOnce(named('SendUnconfirmedError', 'Send confirmation was not received'));
    useOutboxStore.getState().enqueueSend(payload());
    await flushed();
    await flushed();
    expect(useOutboxStore.getState().sends[0]).toMatchObject({ status: 'queued', attempts: 1 });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('stops after an expired session without failing the message', async () => {
    useNetworkStore.setState({ online: true, connected: true });
    runQueuedSend.mockRejectedValueOnce(named('AuthenticationError', 'Session expired'));
    useOutboxStore.getState().enqueueSend(payload());
    await flushed();
    await flushed();
    expect(useOutboxStore.getState().sends[0]).toMatchObject({ status: 'queued', maybeSent: false });
    expect(useOutboxStore.getState().paused).toBe(true);
  });

  it('lets the user discard a waiting message, but not one on its way', async () => {
    const id = useOutboxStore.getState().enqueueSend(payload())!;
    const sending = { ...useOutboxStore.getState().sends[0], status: 'sending' as const };
    useOutboxStore.setState({ sends: [sending] });
    expect(await useOutboxStore.getState().cancelSend(id)).toBe(false);
    useOutboxStore.setState({ sends: [{ ...sending, status: 'queued' }] });
    expect(await useOutboxStore.getState().cancelSend(id)).toBe(true);
    expect(useOutboxStore.getState().sends).toEqual([]);
  });

  it('moves a message to Drafts in place of its autosaved version, and keeps it when that fails', async () => {
    const id = useOutboxStore.getState().enqueueSend(payload('to-drafts'))!;
    expect(await useOutboxStore.getState().cancelSend(id, { keepAsDraft: true })).toBe(true);
    expect(saveDraftVersion).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'to-drafts' }), 'drafts', 'draft-1', undefined, undefined,
    );
    expect(useOutboxStore.getState().sends).toEqual([]);

    saveDraftVersion.mockRejectedValueOnce(named('NetworkError', 'Network request failed'));
    const again = useOutboxStore.getState().enqueueSend(payload('stays'))!;
    expect(await useOutboxStore.getState().cancelSend(again, { keepAsDraft: true })).toBe(false);
    expect(useOutboxStore.getState().sends[0]).toMatchObject({ id: again, status: 'failed' });
  });

  it('does not turn a message an earlier attempt sent into a draft, and says it was sent', async () => {
    const id = useOutboxStore.getState().enqueueSend(payload('went-out'), { maybeSent: true })!;
    wasQueuedSendSent.mockResolvedValueOnce(true);
    expect(await useOutboxStore.getState().cancelSend(id, { keepAsDraft: true })).toBe(true);
    expect(wasQueuedSendSent).toHaveBeenCalledWith(expect.objectContaining({ id, maybeSent: true }), [{ id: 'sent', role: 'sent' }]);
    expect(saveDraftVersion).not.toHaveBeenCalled();
    expect(useOutboxStore.getState().sends).toEqual([]);
    await flushed();
    expect(toast.info).toHaveBeenCalledWith('This message was already sent', { message: 'went-out' });
    expect(patchKeywordsForEmails).toHaveBeenCalledWith(['orig-1'], { $answered: true }, undefined);
  });

  it('moves a marked message to Drafts when no earlier attempt sent it, and looks only for marked ones', async () => {
    const marked = useOutboxStore.getState().enqueueSend(payload('marked'), { maybeSent: true })!;
    expect(await useOutboxStore.getState().cancelSend(marked, { keepAsDraft: true })).toBe(true);
    expect(wasQueuedSendSent).toHaveBeenCalledTimes(1);
    expect(saveDraftVersion).toHaveBeenCalledTimes(1);

    const plain = useOutboxStore.getState().enqueueSend(payload('plain'))!;
    expect(await useOutboxStore.getState().cancelSend(plain, { keepAsDraft: true })).toBe(true);
    expect(wasQueuedSendSent).toHaveBeenCalledTimes(1);
    expect(saveDraftVersion).toHaveBeenCalledTimes(2);
  });

  it('keeps a marked message in the Outbox when the lookup fails', async () => {
    const id = useOutboxStore.getState().enqueueSend(payload('unknown'), { maybeSent: true })!;
    wasQueuedSendSent.mockRejectedValueOnce(named('NetworkError', 'Network request failed'));
    expect(await useOutboxStore.getState().cancelSend(id, { keepAsDraft: true })).toBe(false);
    expect(saveDraftVersion).not.toHaveBeenCalled();
    expect(useOutboxStore.getState().sends[0]).toMatchObject({ id, status: 'failed' });
  });

  it('drops the queued messages with the rest when the server behind the account changed', async () => {
    useOutboxStore.getState().enqueueSend(payload());
    expect(await useOutboxStore.getState().clearAccount(ACCOUNT)).toBe(1);
    expect(await AsyncStorage.getItem(SENDS_KEY)).toBeNull();
  });
});
