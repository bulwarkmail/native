import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: string[] = [];
const state = { entries: {} as Record<string, unknown[]>, active: 'A', serves: true };

vi.mock('../../api/email', () => ({
  createDraft: vi.fn(async () => { calls.push('createDraft'); return 'd1'; }),
}));
vi.mock('../../api/sent-lookup', () => ({
  resolveSendMailboxes: vi.fn(async () => ({ draftsId: 'drafts' })),
}));
vi.mock('../active-client-account', () => ({ clientServesActiveAccount: () => state.serves }));
vi.mock('../send-queue-replay', () => ({ flushSendQueue: vi.fn(async () => { calls.push('flush'); }) }));
vi.mock('../../stores/account-store', () => ({
  useAccountStore: { getState: () => ({ activeAccountId: state.active }) },
}));
vi.mock('../../stores/send-queue-store', () => ({
  useSendQueueStore: {
    getState: () => ({
      entries: state.entries,
      requeue: async () => { calls.push('requeue'); },
      discard: async () => { calls.push('discard'); },
    }),
  },
}));

import { requeueAndFlush, saveEntryAsDraft } from '../outbox-actions';
import { createDraft } from '../../api/email';

const e = (s: string) => ({ id: '1', appAccountId: 'A', jmapAccountId: 'jA', state: s, outgoing: { subject: 'x' } }) as never;

beforeEach(() => {
  calls.length = 0;
  state.active = 'A';
  state.serves = true;
  state.entries = { A: [{ id: '1', appAccountId: 'A', jmapAccountId: 'jA', state: 'uncertain', outgoing: { subject: 'x' } }] };
});

describe('outbox actions', () => {
  it('requeues then flushes', async () => {
    await requeueAndFlush(e('failed'));
    expect(calls).toEqual(['requeue', 'flush']);
  });

  it('refuses retry when the entry account is not active', async () => {
    state.active = 'B';
    await expect(requeueAndFlush(e('failed'))).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('refuses retry when the client serves another account', async () => {
    state.serves = false;
    await expect(requeueAndFlush(e('failed'))).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('saves a draft in the entry account, then discards', async () => {
    await saveEntryAsDraft(e('uncertain'));
    expect(createDraft).toHaveBeenCalledWith({ subject: 'x' }, 'drafts', undefined, 'jA');
    expect(calls).toEqual(['createDraft', 'discard']);
  });

  it('does not save a draft for an entry that is sending now or gone', async () => {
    state.entries = { A: [{ id: '1', appAccountId: 'A', jmapAccountId: 'jA', state: 'sending', outgoing: {} }] };
    await expect(saveEntryAsDraft(e('queued'))).rejects.toThrow();
    state.entries = { A: [] };
    await expect(saveEntryAsDraft(e('queued'))).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
