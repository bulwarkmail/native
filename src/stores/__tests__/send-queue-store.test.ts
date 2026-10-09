import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  useSendQueueStore, SendTooLargeToQueueError, SendQueueStateError, AlreadyQueuedError, parseQueuedSendRow, type QueuedSend,
} from '../send-queue-store';

const row = (a: string, id: string) => `webmail:sendqueue:v1:${a}:${id}`;

// Each entry id carries its own Message-ID (q1 keeps mid-1): the store
// refuses a second entry with the same Message-ID in one account.
function entry(over: Partial<QueuedSend> = {}): QueuedSend {
  const id = over.id ?? 'q1';
  const mid = id === 'q1' ? 'mid-1@x.test' : `mid-${id}@x.test`;
  return {
    id: 'q1', appAccountId: 'a1', jmapAccountId: 'j1', identityId: 'i1',
    outgoing: { from: [{ email: 'a@x.test' }], to: [{ email: 'b@x.test' }], subject: 's', textBody: 'hi', messageId: mid },
    messageId: mid, createdAt: '2026-10-04T00:00:00Z', state: 'queued', ...over,
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

  it('parseQueuedSendRow is the hydrate validation: a valid row parses, a corrupt or misplaced one does not', () => {
    const ok = entry();
    expect(parseQueuedSendRow('a1', row('a1', 'q1'), JSON.stringify(ok))).toEqual(ok);
    expect(parseQueuedSendRow('a1', row('a1', 'q1'), '{not json')).toBeNull();
    expect(parseQueuedSendRow('a1', row('a1', 'q1'), null)).toBeNull();
    expect(parseQueuedSendRow('a1', row('a1', 'q1'), JSON.stringify({ ...ok, state: 'nope' }))).toBeNull();
    expect(parseQueuedSendRow('a1', row('a1', 'other'), JSON.stringify(ok))).toBeNull();
    expect(parseQueuedSendRow('a2', row('a2', 'q1'), JSON.stringify(ok))).toBeNull();
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

  it('unloadAccount drops an account from memory and keeps its rows on disk', async () => {
    const s = useSendQueueStore.getState();
    await s.hydrateAccount('a1');
    await s.enqueue(entry());
    await s.enqueue(entry({ id: 'q2', appAccountId: 'a2' }));
    await s.unloadAccount('a1');
    expect(useSendQueueStore.getState().entries.a1).toBeUndefined();
    expect(useSendQueueStore.getState().hydrated.a1).toBeFalsy();
    expect(mem('a2')).toHaveLength(1);
    expect(await stored('a1', 'q1')).not.toBeNull();
    // Not actionable while unloaded...
    await expect(s.discard('q1')).rejects.toBeInstanceOf(SendQueueStateError);
    // ...and back when the account signs in again.
    await s.hydrateAccount('a1');
    expect(mem('a1').map((e) => e.id)).toEqual(['q1']);
    await s.discard('q1');
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

  it('refuses a second entry with the same Message-ID in the same account', async () => {
    const s = useSendQueueStore.getState();
    await s.hydrateAccount('a1');
    await s.enqueue(entry());
    const again = entry({ id: 'q2', outgoing: { ...entry().outgoing, messageId: '<mid-1@x.test>' } });
    await expect(s.enqueue(again)).rejects.toBeInstanceOf(AlreadyQueuedError);
    expect(mem('a1').map((e) => e.id)).toEqual(['q1']);
    expect(await stored('a1', 'q2')).toBeNull();
    // Another account may hold the same Message-ID (it is that account's send).
    await s.enqueue(entry({ id: 'q3', appAccountId: 'a2', outgoing: entry().outgoing }));
    // Once the first is gone (discarded, sent), the Message-ID may be queued again.
    await s.discard('q1');
    await s.enqueue(entry({ id: 'q4', outgoing: entry().outgoing }));
    expect(mem('a1').map((e) => e.id)).toEqual(['q4']);
  });

  it('refuses a duplicate Message-ID held only by a row on disk (account not loaded)', async () => {
    await AsyncStorage.setItem(row('a1', 'old'), JSON.stringify(entry({ id: 'old', state: 'uncertain', outgoing: entry().outgoing, messageId: 'mid-1@x.test' })));
    await expect(useSendQueueStore.getState().enqueue(entry())).rejects.toBeInstanceOf(AlreadyQueuedError);
    expect(await stored('a1', 'q1')).toBeNull();
    // The id claim is released: a later enqueue with that id works.
    await useSendQueueStore.getState().enqueue(entry({ outgoing: { ...entry().outgoing, messageId: 'other@x.test' } }));
    expect(await stored('a1', 'q1')).not.toBeNull();
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
      // queued (complete from queued is legal: proof found after a Retry; see below)
      await bad(s.markUncertain('q1', 'e')); await bad(s.markFailed('q1', 'e'));
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

    it('complete is allowed from queued (proof found after the user requeued), not from failed', async () => {
      const s = await setup();
      await s.complete('q1');
      expect(mem('a1')).toEqual([]);
      expect(await stored('a1', 'q1')).toBeNull();
      await s.enqueue(entry({ id: 'q2' }));
      await s.markSending('q2'); await s.markFailed('q2', 'x');
      await expect(s.complete('q2')).rejects.toBeInstanceOf(SendQueueStateError);
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

    it('hold marks a queued entry with a reason, persisted, without changing its state', async () => {
      const s = await setup();
      await s.hold('q1', 'no_drafts');
      expect(mem('a1')[0]).toMatchObject({ state: 'queued', heldReason: 'no_drafts' });
      expect((await stored('a1', 'q1')).heldReason).toBe('no_drafts');
    });

    it('hold is allowed only on queued', async () => {
      const s = await setup();
      const bad = (p: Promise<void>) => expect(p).rejects.toBeInstanceOf(SendQueueStateError);
      await s.markSending('q1');
      await bad(s.hold('q1', 'no_sent'));
      await s.markUncertain('q1', 'net');
      await bad(s.hold('q1', 'no_sent'));
      await s.markFailed('q1', 'x');
      await bad(s.hold('q1', 'no_sent'));
      await bad(s.hold('nope', 'no_sent'));
    });

    it('a held entry cannot be marked sending until the user retries it', async () => {
      const s = await setup();
      await s.hold('q1', 'bad_schedule');
      await expect(s.markSending('q1')).rejects.toBeInstanceOf(SendQueueStateError);
      await s.requeue('q1'); // the user's Retry: queued (held) -> queued
      expect(mem('a1')[0].heldReason).toBeUndefined();
      expect((await stored('a1', 'q1')).heldReason).toBeUndefined();
      await s.markSending('q1');
    });

    it('requeue stays refused on a queued entry that is not held', async () => {
      const s = await setup();
      await expect(s.requeue('q1')).rejects.toBeInstanceOf(SendQueueStateError);
    });

    it('discard removes a held entry', async () => {
      const s = await setup();
      await s.hold('q1', 'account_unavailable');
      await s.discard('q1');
      expect(mem('a1')).toEqual([]);
      expect(await stored('a1', 'q1')).toBeNull();
    });

    it('releaseHold clears an account_unavailable hold on a never-attempted queued entry, persisted', async () => {
      const s = await setup();
      await s.hold('q1', 'account_unavailable');
      await s.releaseHold('q1');
      expect(mem('a1')[0]).toMatchObject({ state: 'queued' });
      expect(mem('a1')[0].heldReason).toBeUndefined();
      expect((await stored('a1', 'q1')).heldReason).toBeUndefined();
      await s.markSending('q1');
    });

    it('releaseHold refuses any other hold reason, an unheld entry, and other states', async () => {
      const s = await setup();
      const bad = (p: Promise<void>) => expect(p).rejects.toBeInstanceOf(SendQueueStateError);
      await bad(s.releaseHold('q1'));
      for (const reason of ['bad_schedule', 'no_sent', 'no_drafts'] as const) {
        await s.hold('q1', reason);
        await bad(s.releaseHold('q1'));
        expect(mem('a1')[0].heldReason).toBe(reason);
        expect((await stored('a1', 'q1')).heldReason).toBe(reason);
        await s.requeue('q1');
      }
      await s.markSending('q1');
      await bad(s.releaseHold('q1'));
      await s.markUncertain('q1', 'net');
      await bad(s.releaseHold('q1'));
      await bad(s.releaseHold('nope'));
    });

    it('releaseHold refuses an account_unavailable entry that was ever attempted', async () => {
      await AsyncStorage.setItem(row('a1', 'q1'), JSON.stringify(entry({
        heldReason: 'account_unavailable', attemptStartedAt: '2026-10-04T00:01:00Z',
      })));
      const s = useSendQueueStore.getState();
      await s.hydrateAccount('a1');
      await expect(s.releaseHold('q1')).rejects.toBeInstanceOf(SendQueueStateError);
      expect(mem('a1')[0].heldReason).toBe('account_unavailable');
      expect((await stored('a1', 'q1')).heldReason).toBe('account_unavailable');
      await expect(s.markSending('q1')).rejects.toBeInstanceOf(SendQueueStateError);
    });

    describe('restamp', () => {
      const heldEntry = (over: Partial<QueuedSend> = {}) => entry({
        heldReason: 'account_unavailable', draftId: 'd1',
        replyTo: { emailIds: ['e1'], keyword: '$answered', jmapAccountId: 'j1', untrusted: ['a@b.example'] },
        ...over,
      });
      const seedHeld = async (over: Partial<QueuedSend> = {}) => {
        await AsyncStorage.setItem(row('a1', 'q1'), JSON.stringify(heldEntry(over)));
        const s = useSendQueueStore.getState();
        await s.hydrateAccount('a1');
        return s;
      };
      const entryOf = (id: string) => mem('a1').find((e) => e.id === id);

      it('restamp drops the draft and the replied-to ids, and keeps the trust list', async () => {
        const s = await seedHeld();
        await s.restamp('q1', 'jNew');
        expect(entryOf('q1')).toMatchObject({ jmapAccountId: 'jNew', draftId: undefined, replyTo: { emailIds: [], untrusted: ['a@b.example'] } });
        expect(entryOf('q1')).toMatchObject({ state: 'queued', replyTo: { keyword: '$answered', jmapAccountId: 'jNew' } });
        expect(entryOf('q1')!.heldReason).toBeUndefined();
        const disk = await stored('a1', 'q1');
        expect(disk).toMatchObject({ jmapAccountId: 'jNew', replyTo: { emailIds: [], untrusted: ['a@b.example'], jmapAccountId: 'jNew' } });
        expect(disk.draftId).toBeUndefined();
        expect(disk.heldReason).toBeUndefined();
        await s.markSending('q1');
      });

      it('keeps a replied-to account that was not the old one', async () => {
        const s = await seedHeld({ replyTo: { emailIds: ['e1'], keyword: '$forwarded', jmapAccountId: 'jShared' } });
        await s.restamp('q1', 'jNew');
        expect(entryOf('q1')!.replyTo).toEqual({ emailIds: [], keyword: '$forwarded', jmapAccountId: 'jShared' });
      });

      it('re-stamps an entry that replies to nothing', async () => {
        const s = await seedHeld({ replyTo: undefined, draftId: undefined });
        await s.restamp('q1', 'jNew');
        expect(entryOf('q1')!.jmapAccountId).toBe('jNew');
        expect(entryOf('q1')!.replyTo).toBeUndefined();
      });

      it.each([
        ['ever attempted', { attemptStartedAt: '2026-10-04T00:01:00Z' }],
        ['with attachments', { outgoing: { ...entry().outgoing, attachments: [{ blobId: 'b1', type: 'text/plain', name: 'a.txt' }] } }],
        ['held for another reason', { heldReason: 'no_sent' as const }],
        ['not held', { heldReason: undefined }],
        ['uncertain', { state: 'uncertain' as const, attemptStartedAt: '2026-10-04T00:01:00Z' }],
        ['failed', { state: 'failed' as const }],
      ])('refuses an entry %s, and leaves it as it was', async (_l, patch) => {
        const s = await seedHeld(patch);
        const before = await stored('a1', 'q1');
        await expect(s.restamp('q1', 'jNew')).rejects.toBeInstanceOf(SendQueueStateError);
        expect(await stored('a1', 'q1')).toEqual(before);
        expect(entryOf('q1')).toEqual(before);
      });

      it('refuses the account the entry already names, an empty id, and an unknown entry', async () => {
        const s = await seedHeld();
        await expect(s.restamp('q1', 'j1')).rejects.toBeInstanceOf(SendQueueStateError);
        await expect(s.restamp('q1', '')).rejects.toBeInstanceOf(SendQueueStateError);
        await expect(s.restamp('nope', 'jNew')).rejects.toBeInstanceOf(SendQueueStateError);
        expect(entryOf('q1')!.jmapAccountId).toBe('j1');
      });

      it('refuses an entry that was marked sending before the re-stamp ran', async () => {
        const s = await seedHeld();
        await s.releaseHold('q1');
        await s.markSending('q1');
        await expect(s.restamp('q1', 'jNew')).rejects.toBeInstanceOf(SendQueueStateError);
        expect(entryOf('q1')).toMatchObject({ state: 'sending', jmapAccountId: 'j1' });
      });

      it('leaves memory as it was when the row write fails', async () => {
        const s = await seedHeld();
        vi.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'));
        await expect(s.restamp('q1', 'jNew')).rejects.toThrow('disk full');
        expect(entryOf('q1')).toMatchObject({ jmapAccountId: 'j1', heldReason: 'account_unavailable', draftId: 'd1' });
      });
    });

    it('noteReconcile stamps an uncertain entry only; a new attempt or a requeue clears the stamp', async () => {
      const s = await setup();
      await expect(s.noteReconcile('q1')).rejects.toBeInstanceOf(SendQueueStateError);
      await s.markSending('q1');
      await s.markUncertain('q1', 'net');
      await s.noteReconcile('q1');
      expect(typeof mem('a1')[0].lastReconcileAt).toBe('string');
      expect((await stored('a1', 'q1')).lastReconcileAt).toBe(mem('a1')[0].lastReconcileAt);
      expect(mem('a1')[0].state).toBe('uncertain');
      await s.requeue('q1');
      expect(mem('a1')[0].lastReconcileAt).toBeUndefined();
      await s.markSending('q1');
      await s.markUncertain('q1', 'net');
      expect(mem('a1')[0].lastReconcileAt).toBeUndefined();
    });

    it('refuses an id with a colon', async () => {
      await expect(useSendQueueStore.getState().enqueue(entry({ id: 'a:b' }))).rejects.toThrow(/Invalid queued send id/);
      expect(await AsyncStorage.getAllKeys()).toEqual([]);
    });
  });
});
