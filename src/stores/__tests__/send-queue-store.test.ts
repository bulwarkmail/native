import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useSendQueueStore, SendTooLargeToQueueError, SendQueueStateError, type QueuedSend } from '../send-queue-store';

const row = (a: string, id: string) => `webmail:sendqueue:v1:${a}:${id}`;

function entry(over: Partial<QueuedSend> = {}): QueuedSend {
  return {
    id: 'q1', appAccountId: 'a1', jmapAccountId: 'j1', identityId: 'i1',
    outgoing: { from: [{ email: 'a@x.test' }], to: [{ email: 'b@x.test' }], subject: 's', textBody: 'hi', messageId: 'mid-1@x.test' },
    messageId: 'mid-1@x.test', createdAt: '2026-10-04T00:00:00Z', state: 'queued', ...over,
  };
}
const stored = async (a: string, id: string) => {
  const raw = await AsyncStorage.getItem(row(a, id));
  return raw === null ? null : JSON.parse(raw);
};
const mem = (a: string) => useSendQueueStore.getState().entries[a] ?? [];

beforeEach(async () => {
  for (const a of ['a1', 'a2']) await useSendQueueStore.getState().clearAccount(a);
  await AsyncStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

describe('send-queue-store', () => {
  it('does not resolve markSending until the row write completes', async () => {
    const s = useSendQueueStore.getState();
    await s.hydrateAccount('a1');
    await s.enqueue(entry());
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.spyOn(AsyncStorage, 'setItem').mockImplementation(async (k: string, v: string) => {
      await gate;
      await AsyncStorage.multiSet([[k, v]]);
    });
    let resolved = false;
    const p = s.markSending('q1').then(() => { resolved = true; });
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);
    expect((await stored('a1', 'q1')).state).toBe('queued');
    expect(mem('a1')[0].state).toBe('queued');
    release();
    await p;
    expect(resolved).toBe(true);
    expect((await stored('a1', 'q1')).state).toBe('sending');
    expect(mem('a1')[0].state).toBe('sending');
  });

  it('rejects and leaves memory unchanged when the write fails', async () => {
    const s = useSendQueueStore.getState();
    await s.hydrateAccount('a1');
    await s.enqueue(entry());
    vi.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'));
    await expect(s.markSending('q1')).rejects.toThrow('disk full');
    expect(mem('a1')[0].state).toBe('queued');
    await s.markSending('q1'); // chain still works
    expect(mem('a1')[0].state).toBe('sending');
  });

  it('a rejected enqueue is not kept in memory or persisted later', async () => {
    const s = useSendQueueStore.getState();
    vi.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'));
    await expect(s.enqueue(entry())).rejects.toThrow('disk full');
    expect(mem('a1')).toEqual([]);
    await s.enqueue(entry({ id: 'q2' }));
    expect(await stored('a1', 'q1')).toBeNull();
  });

  it('R1: hydrate racing markSending leaves sending on disk and in memory', async () => {
    const s = useSendQueueStore.getState();
    await s.enqueue(entry());
    await Promise.all([s.hydrateAccount('a1'), s.markSending('q1')]);
    expect(mem('a1')).toHaveLength(1);
    expect(mem('a1')[0].state).toBe('sending');
    expect((await stored('a1', 'q1')).state).toBe('sending');
    await s.markFailed('q1', 'x');
    expect((await stored('a1', 'q1')).state).toBe('failed');
  });

  it('R2: enqueue on an unloaded account keeps the stored uncertain entry', async () => {
    await AsyncStorage.setItem(row('a1', 'old'), JSON.stringify(entry({ id: 'old', state: 'uncertain' })));
    const s = useSendQueueStore.getState();
    await s.enqueue(entry({ id: 'new' }));
    expect((await stored('a1', 'old')).state).toBe('uncertain');
    await s.hydrateAccount('a1');
    expect(mem('a1').map((e) => e.id).sort()).toEqual(['new', 'old']);
  });

  it('turns a hydrated sending row into uncertain and writes it back', async () => {
    await AsyncStorage.setItem(row('a1', 'q1'), JSON.stringify(entry({ state: 'sending' })));
    await useSendQueueStore.getState().hydrateAccount('a1');
    expect(mem('a1')[0].state).toBe('uncertain');
    expect((await stored('a1', 'q1')).state).toBe('uncertain');
  });

  it('hydrate merges: memory wins and is never downgraded', async () => {
    const s = useSendQueueStore.getState();
    await s.hydrateAccount('a1');
    await s.enqueue(entry());
    await s.markSending('q1');
    await AsyncStorage.setItem(row('a1', 'q1'), JSON.stringify(entry({ state: 'queued' })));
    await s.hydrateAccount('a1');
    expect(mem('a1')).toHaveLength(1);
    expect(mem('a1')[0].state).toBe('sending');
  });

  it('skips a corrupt row, leaves it on disk, and loads the valid rows', async () => {
    await AsyncStorage.setItem(row('a1', 'bad'), '{not json');
    await AsyncStorage.setItem(row('a1', 'bad2'), JSON.stringify({ id: 'bad2', state: 'nope' }));
    await AsyncStorage.setItem(row('a1', 'q1'), JSON.stringify(entry()));
    await useSendQueueStore.getState().hydrateAccount('a1');
    expect(mem('a1').map((e) => e.id)).toEqual(['q1']);
    expect(await AsyncStorage.getItem(row('a1', 'bad'))).toBe('{not json');
    expect(await AsyncStorage.getItem(row('a1', 'bad2'))).not.toBeNull();
    await useSendQueueStore.getState().markSending('q1');
    expect(await AsyncStorage.getItem(row('a1', 'bad'))).toBe('{not json');
  });

  it('keeps accounts apart and clearAccount removes only its rows', async () => {
    const s = useSendQueueStore.getState();
    await s.enqueue(entry());
    await s.enqueue(entry({ id: 'q2', appAccountId: 'a2' }));
    await AsyncStorage.setItem('webmail:outbox:v1:a1', '[1]');
    await s.clearAccount('a1');
    expect(await stored('a1', 'q1')).toBeNull();
    expect(await stored('a2', 'q2')).not.toBeNull();
    expect(await AsyncStorage.getItem('webmail:outbox:v1:a1')).toBe('[1]');
    expect(mem('a1')).toEqual([]);
  });

  it('refuses a duplicate id', async () => {
    const s = useSendQueueStore.getState();
    await s.enqueue(entry());
    await expect(s.enqueue(entry())).rejects.toThrow(/already exists/);
    expect(mem('a1')).toHaveLength(1);
    // also a duplicate of a row that is on disk but not loaded
    await AsyncStorage.setItem(row('a2', 'z'), JSON.stringify(entry({ id: 'z', appAccountId: 'a2' })));
    await expect(s.enqueue(entry({ id: 'z', appAccountId: 'a2' }))).rejects.toThrow(/already exists/);
  });

  it('derives messageId from outgoing.messageId, brackets stripped', async () => {
    const s = useSendQueueStore.getState();
    await s.enqueue(entry({ messageId: 'forged@x', outgoing: { ...entry().outgoing, messageId: '<real@x.test>' } }));
    expect(mem('a1')[0].messageId).toBe('real@x.test');
    expect((await stored('a1', 'q1')).messageId).toBe('real@x.test');
  });

  it('refuses an entry with no outgoing Message-ID', async () => {
    const e = entry();
    delete e.outgoing.messageId;
    await expect(useSendQueueStore.getState().enqueue(e)).rejects.toThrow(/Message-ID/);
    expect(mem('a1')).toEqual([]);
  });

  it('applies the 1 MB cap in UTF-8 bytes', async () => {
    const s = useSendQueueStore.getState();
    // 400k chars of 3-byte text = 1.2 MB of bytes but only 400k characters
    const big = entry({ outgoing: { ...entry().outgoing, textBody: '€'.repeat(400_000) } });
    await expect(s.enqueue(big)).rejects.toBeInstanceOf(SendTooLargeToQueueError);
    expect(await stored('a1', 'q1')).toBeNull();
    await s.enqueue(entry({ outgoing: { ...entry().outgoing, textBody: 'x'.repeat(900_000) } }));
    expect(mem('a1')).toHaveLength(1);
  });

  it('discard removes only that entry', async () => {
    const s = useSendQueueStore.getState();
    await s.hydrateAccount('a1');
    await s.enqueue(entry());
    await s.enqueue(entry({ id: 'q2' }));
    await s.discard('q1');
    expect(await stored('a1', 'q1')).toBeNull();
    expect(await stored('a1', 'q2')).not.toBeNull();
    expect(mem('a1').map((e) => e.id)).toEqual(['q2']);
  });

  it('does not lose writes when methods are called back to back', async () => {
    const s = useSendQueueStore.getState();
    await s.hydrateAccount('a1');
    await Promise.all([s.enqueue(entry()), s.enqueue(entry({ id: 'q2' })), s.enqueue(entry({ id: 'q3' }))]);
    await Promise.all([s.markSending('q1'), s.markSending('q2'), s.markSending('q3')]);
    await Promise.all([s.markFailed('q2', 'boom'), s.complete('q3')]);
    expect((await stored('a1', 'q1')).state).toBe('sending');
    expect((await stored('a1', 'q2')).state).toBe('failed');
    expect(await stored('a1', 'q3')).toBeNull();
    await s.markUncertain('q1', 'net');
    await s.requeue('q1');
    expect((await stored('a1', 'q1')).state).toBe('queued');
  });

  it('never touches webmail:outbox:v1:* keys', async () => {
    await AsyncStorage.setItem('webmail:outbox:v1:a1', '[1]');
    const spies = (['setItem', 'getItem', 'removeItem', 'multiRemove', 'multiGet'] as const)
      .map((m) => vi.spyOn(AsyncStorage, m));
    spies.forEach((sp) => sp.mockClear());
    const s = useSendQueueStore.getState();
    await s.hydrateAccount('a1');
    await s.enqueue(entry());
    await s.markSending('q1');
    await s.releaseUnsent('q1');
    await s.discard('q1');
    await s.clearAccount('a1');
    const touched = spies.flatMap((sp) => sp.mock.calls.map((c) => JSON.stringify(c[0])));
    expect(touched.length).toBeGreaterThan(0);
    expect(touched.some((k) => k.includes('webmail:outbox:'))).toBe(false);
    expect(await AsyncStorage.getItem('webmail:outbox:v1:a1')).toBe('[1]');
  });

  describe('state machine', () => {
    const setup = async () => {
      const s = useSendQueueStore.getState();
      await s.hydrateAccount('a1');
      await s.enqueue(entry());
      return s;
    };

    it('rejects markSending for an unknown or disk-only id', async () => {
      const s = useSendQueueStore.getState();
      await s.hydrateAccount('a1');
      await AsyncStorage.setItem(row('a1', 'disk'), JSON.stringify(entry({ id: 'disk' })));
      await expect(s.markSending('disk')).rejects.toBeInstanceOf(SendQueueStateError);
      await expect(s.markSending('nope')).rejects.toBeInstanceOf(SendQueueStateError);
      expect((await stored('a1', 'disk')).state).toBe('queued');
    });

    it('rejects every mutator before the account is hydrated', async () => {
      const s = useSendQueueStore.getState();
      await s.enqueue(entry());
      await expect(s.markSending('q1')).rejects.toBeInstanceOf(SendQueueStateError);
      await expect(s.discard('q1')).rejects.toBeInstanceOf(SendQueueStateError);
      expect((await stored('a1', 'q1')).state).toBe('queued');
    });

    it('lets only one of two concurrent markSending calls succeed', async () => {
      const s = await setup();
      const results = await Promise.allSettled([s.markSending('q1'), s.markSending('q1')]);
      expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
      expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason)
        .toBeInstanceOf(SendQueueStateError);
      expect((await stored('a1', 'q1')).state).toBe('sending');
    });

    it('rejects markSending after complete and after discard', async () => {
      const s = await setup();
      await s.markSending('q1');
      await s.complete('q1');
      await expect(s.markSending('q1')).rejects.toBeInstanceOf(SendQueueStateError);
      await s.enqueue(entry({ id: 'q2' }));
      await s.discard('q2');
      await expect(s.markSending('q2')).rejects.toBeInstanceOf(SendQueueStateError);
      await expect(s.discard('q2')).rejects.toBeInstanceOf(SendQueueStateError);
    });

    it('rejects each disallowed transition and allows the legal ones', async () => {
      const s = await setup();
      const bad = (p: Promise<void>) => expect(p).rejects.toBeInstanceOf(SendQueueStateError);
      // queued
      await bad(s.complete('q1')); await bad(s.markUncertain('q1', 'e')); await bad(s.markFailed('q1', 'e'));
      await bad(s.requeue('q1')); await bad(s.releaseUnsent('q1'));
      await s.markSending('q1');
      await bad(s.markSending('q1'));
      // sending: only replay itself may hand it back, and nobody may discard it
      await bad(s.requeue('q1')); await bad(s.discard('q1'));
      await s.releaseUnsent('q1'); // sending -> queued (nothing was sent)
      await s.markSending('q1');
      await s.markUncertain('q1', 'net');
      await bad(s.markSending('q1')); await bad(s.markUncertain('q1', 'e')); await bad(s.releaseUnsent('q1'));
      await s.markFailed('q1', 'x'); // uncertain -> failed
      await bad(s.markSending('q1')); await bad(s.complete('q1')); await bad(s.markUncertain('q1', 'e'));
      await bad(s.markFailed('q1', 'e')); await bad(s.releaseUnsent('q1'));
      await s.requeue('q1'); // failed -> queued
      await s.markSending('q1');
      await s.markUncertain('q1', 'net');
      await s.complete('q1'); // uncertain -> removed
      expect(mem('a1')).toEqual([]);
      expect(await stored('a1', 'q1')).toBeNull();
    });

    it('P2: requeue or discard while a send is in flight rejects, the entry stays sending', async () => {
      const s = await setup();
      await s.markSending('q1');
      await expect(s.requeue('q1')).rejects.toBeInstanceOf(SendQueueStateError);
      await expect(s.discard('q1')).rejects.toBeInstanceOf(SendQueueStateError);
      expect((await stored('a1', 'q1')).state).toBe('sending');
      // A Retry cannot make it queued, so a second markSending cannot win.
      await expect(s.markSending('q1')).rejects.toBeInstanceOf(SendQueueStateError);
    });

    it('discard works from queued, uncertain and failed', async () => {
      const s = await setup();
      await s.enqueue(entry({ id: 'q2' }));
      await s.enqueue(entry({ id: 'q3' }));
      await s.markSending('q2'); await s.markUncertain('q2', 'net');
      await s.markSending('q3'); await s.markFailed('q3', 'x');
      await s.discard('q1'); await s.discard('q2'); await s.discard('q3');
      expect(mem('a1')).toEqual([]);
    });

    it('rejects hydrate when the sending repair write-back fails, memory unchanged', async () => {
      await AsyncStorage.setItem(row('a1', 'q1'), JSON.stringify(entry({ state: 'sending' })));
      vi.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'));
      const s = useSendQueueStore.getState();
      await expect(s.hydrateAccount('a1')).rejects.toThrow('disk full');
      expect(mem('a1')).toEqual([]);
      expect(useSendQueueStore.getState().hydrated.a1).toBeUndefined();
      expect((await stored('a1', 'q1')).state).toBe('sending');
      await s.hydrateAccount('a1');
      expect(mem('a1')[0].state).toBe('uncertain');
    });

    it('refuses an id with a colon', async () => {
      await expect(useSendQueueStore.getState().enqueue(entry({ id: 'a:b' }))).rejects.toThrow(/Invalid queued send id/);
      expect(await AsyncStorage.getAllKeys()).toEqual([]);
    });
  });
});
