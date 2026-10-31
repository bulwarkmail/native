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
vi.mock('../../api/queued-send', () => ({
  runQueuedSend: (...a: any[]) => runQueuedSend(...a),
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

  it('drops the queued messages with the rest when the server behind the account changed', async () => {
    useOutboxStore.getState().enqueueSend(payload());
    expect(await useOutboxStore.getState().clearAccount(ACCOUNT)).toBe(1);
    expect(await AsyncStorage.getItem(SENDS_KEY)).toBeNull();
  });
});
