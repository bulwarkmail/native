import { describe, it, expect, beforeEach, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSendQueueStore, SendTooLargeToQueueError, type QueuedSend } from '../send-queue-store';

const key = (a: string) => `webmail:sendqueue:v1:${a}`;

function entry(over: Partial<QueuedSend> = {}): QueuedSend {
  return {
    id: 'q1', appAccountId: 'a1', jmapAccountId: 'j1', identityId: 'i1',
    outgoing: { from: [{ email: 'a@x.test' }], to: [{ email: 'b@x.test' }], subject: 's', textBody: 'hi', messageId: 'mid-1@x.test' },
    messageId: 'mid-1@x.test', createdAt: '2026-10-04T00:00:00Z', state: 'queued', ...over,
  };
}
const stored = async (a: string) => JSON.parse((await AsyncStorage.getItem(key(a))) ?? 'null');

beforeEach(async () => {
  await AsyncStorage.clear();
  useSendQueueStore.setState({ entries: {} });
});

describe('send-queue-store', () => {
  it('persists sending before markSending resolves', async () => {
    const s = useSendQueueStore.getState();
    await s.enqueue(entry());
    await s.markSending('q1');
    const disk = await stored('a1');
    expect(disk[0].state).toBe('sending');
    expect(disk[0].attemptStartedAt).toBeTruthy();
  });

  it('turns a hydrated sending entry into uncertain, and persists the repair', async () => {
    await AsyncStorage.setItem(key('a1'), JSON.stringify([entry({ state: 'sending' })]));
    await useSendQueueStore.getState().hydrateAccount('a1');
    expect(useSendQueueStore.getState().entries.a1[0].state).toBe('uncertain');
    expect((await stored('a1'))[0].state).toBe('uncertain');
  });

  it('keeps accounts apart', async () => {
    const s = useSendQueueStore.getState();
    await s.enqueue(entry());
    await s.enqueue(entry({ id: 'q2', appAccountId: 'a2' }));
    expect((await stored('a1')).map((e: QueuedSend) => e.id)).toEqual(['q1']);
    expect((await stored('a2')).map((e: QueuedSend) => e.id)).toEqual(['q2']);
    await s.clearAccount('a1');
    expect(await stored('a1')).toBeNull();
    expect(await stored('a2')).toHaveLength(1);
  });

  it('refuses an entry over 1 MB', async () => {
    const big = entry({ outgoing: { ...entry().outgoing, textBody: 'x'.repeat(1024 * 1024 + 1) } });
    await expect(useSendQueueStore.getState().enqueue(big)).rejects.toBeInstanceOf(SendTooLargeToQueueError);
    expect(await stored('a1')).toBeNull();
  });

  it('refuses an entry with no Message-ID', async () => {
    const e = entry();
    delete e.outgoing.messageId;
    await expect(useSendQueueStore.getState().enqueue(e)).rejects.toThrow(/Message-ID/);
    await expect(useSendQueueStore.getState().enqueue(entry({ messageId: '' }))).rejects.toThrow(/Message-ID/);
  });

  it('discard removes only that entry', async () => {
    const s = useSendQueueStore.getState();
    await s.enqueue(entry());
    await s.enqueue(entry({ id: 'q2' }));
    await s.discard('q1');
    expect((await stored('a1')).map((e: QueuedSend) => e.id)).toEqual(['q2']);
  });

  it('does not lose writes when methods are called back to back', async () => {
    const s = useSendQueueStore.getState();
    await Promise.all([s.enqueue(entry()), s.enqueue(entry({ id: 'q2' })), s.enqueue(entry({ id: 'q3' }))]);
    await Promise.all([s.markSending('q1'), s.markFailed('q2', 'boom'), s.complete('q3')]);
    const disk = await stored('a1');
    expect(disk.map((e: QueuedSend) => [e.id, e.state])).toEqual([['q1', 'sending'], ['q2', 'failed']]);
    await s.markUncertain('q1', 'net');
    await s.requeue('q1');
    expect((await stored('a1'))[0]).toMatchObject({ state: 'queued' });
  });

  it('never touches webmail:outbox:v1:* keys', async () => {
    const spies = [
      vi.spyOn(AsyncStorage, 'setItem'), vi.spyOn(AsyncStorage, 'getItem'),
      vi.spyOn(AsyncStorage, 'removeItem'), vi.spyOn(AsyncStorage, 'multiRemove'),
    ];
    await AsyncStorage.setItem('webmail:outbox:v1:a1', '[1]');
    spies[0].mockClear();
    const s = useSendQueueStore.getState();
    await s.hydrateAccount('a1');
    await s.enqueue(entry());
    await s.markSending('q1');
    await s.discard('q1');
    await s.clearAccount('a1');
    const touched = spies.flatMap((sp) => sp.mock.calls.map((c) => JSON.stringify(c[0])));
    expect(touched.some((k) => k.includes('webmail:outbox:'))).toBe(false);
    expect(await AsyncStorage.getItem('webmail:outbox:v1:a1')).toBe('[1]');
    spies.forEach((sp) => sp.mockRestore());
  });
});
