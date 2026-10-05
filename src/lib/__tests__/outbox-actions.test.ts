import { describe, it, expect, vi, beforeEach } from 'vitest';

const calls: string[] = [];
const state = {
  entries: {} as Record<string, unknown[]>, active: 'A', serves: true, discardFails: false, createFails: false,
  enqueued: [] as unknown[], onBoxes: undefined as undefined | (() => void),
};

vi.mock('../../api/email', () => ({
  createDraft: vi.fn(async () => { calls.push('createDraft'); if (state.createFails) throw new Error('net'); return 'd1'; }),
}));
vi.mock('../../api/sent-lookup', () => ({
  resolveSendMailboxes: vi.fn(async () => { calls.push('boxes'); state.onBoxes?.(); return { draftsId: 'drafts' }; }),
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
      discard: async () => { calls.push('discard'); if (state.discardFails) throw new Error('state'); },
      enqueue: async (e: unknown) => { calls.push('enqueue'); state.enqueued.push(e); },
    }),
  },
}));

import { requeueAndFlush, saveEntryAsDraft } from '../outbox-actions';
import { createDraft } from '../../api/email';

const e = (s: string) => ({ id: '1', appAccountId: 'A', jmapAccountId: 'jA', state: s, outgoing: { subject: 'x' } }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  calls.length = 0;
  state.active = 'A';
  state.serves = true;
  state.discardFails = false;
  state.createFails = false;
  state.enqueued = [];
  state.onBoxes = undefined;
  state.entries = { A: [{ id: '1', appAccountId: 'A', jmapAccountId: 'jA', state: 'uncertain', outgoing: { subject: 'x' } }] };
});

describe('outbox actions', () => {
  it('requeues then flushes', async () => {
    await requeueAndFlush(e('uncertain'), 'uncertain');
    expect(calls).toEqual(['requeue', 'flush']);
  });

  it('retries a held entry: requeue (clears the hold) then flush', async () => {
    state.entries = { A: [{ id: '1', appAccountId: 'A', jmapAccountId: 'jA', state: 'queued', heldReason: 'no_drafts', outgoing: {} }] };
    await requeueAndFlush(e('queued'), 'held');
    expect(calls).toEqual(['requeue', 'flush']);
  });

  it('refuses a held retry when the entry is no longer held', async () => {
    state.entries = { A: [{ id: '1', appAccountId: 'A', jmapAccountId: 'jA', state: 'queued', outgoing: {} }] };
    await expect(requeueAndFlush(e('queued'), 'held')).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('refuses when the live state is not the one the row showed', async () => {
    await expect(requeueAndFlush(e('failed'), 'failed')).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('refuses retry when the entry account is not active', async () => {
    state.active = 'B';
    await expect(requeueAndFlush(e('failed'), 'uncertain')).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('refuses retry when the client serves another account', async () => {
    state.serves = false;
    await expect(requeueAndFlush(e('failed'), 'uncertain')).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it('discards first, then saves a draft in the entry account', async () => {
    await saveEntryAsDraft(e('uncertain'));
    expect(createDraft).toHaveBeenCalledWith({ subject: 'x' }, 'drafts', undefined, 'jA');
    expect(calls).toEqual(['discard', 'boxes', 'createDraft']);
  });

  it('replaces the entry draft like autosave', async () => {
    state.entries = { A: [{ id: '1', appAccountId: 'A', jmapAccountId: 'jA', state: 'queued', draftId: 'old', outgoing: { subject: 'x' } }] };
    await saveEntryAsDraft(e('queued'));
    expect(createDraft).toHaveBeenCalledWith({ subject: 'x' }, 'drafts', 'old', 'jA');
  });

  it('creates nothing when discard rejects (a flush won)', async () => {
    state.discardFails = true;
    await expect(saveEntryAsDraft(e('queued'))).rejects.toThrow();
    expect(calls).toEqual(['discard']);
    expect(state.enqueued).toEqual([]);
  });

  it('puts the entry back under a fresh id when the draft fails', async () => {
    state.createFails = true;
    await expect(saveEntryAsDraft(e('uncertain'))).rejects.toMatchObject({ code: 'draft_failed_restored' });
    expect(calls).toEqual(['discard', 'boxes', 'createDraft', 'enqueue']);
    const back = state.enqueued[0] as { id: string; state: string; outgoing: unknown; messageId?: string };
    expect(back.id).not.toBe('1');
    expect(back.state).toBe('uncertain');
    expect(back.outgoing).toEqual({ subject: 'x' });
    expect(back.messageId).toBeUndefined();
  });

  it('re-checks the account right before creating the draft: a switch means no write, the entry back as it was', async () => {
    state.entries = { A: [{ id: '1', appAccountId: 'A', jmapAccountId: 'jA', state: 'queued', outgoing: { subject: 'x' } }] };
    state.onBoxes = () => { state.active = 'B'; };
    await expect(saveEntryAsDraft(e('queued'))).rejects.toMatchObject({ code: 'wrong_account' });
    expect(calls).toEqual(['discard', 'boxes', 'enqueue']);
    expect(createDraft).not.toHaveBeenCalled();
    const back = state.enqueued[0] as { id: string; state: string };
    expect(back.state).toBe('queued');
  });

  it('a client that stops serving the account before the draft is written also means no write', async () => {
    state.onBoxes = () => { state.serves = false; };
    await expect(saveEntryAsDraft(e('uncertain'))).rejects.toMatchObject({ code: 'wrong_account' });
    expect(createDraft).not.toHaveBeenCalled();
    expect((state.enqueued[0] as { state: string }).state).toBe('uncertain');
  });

  it('does not save a draft for an entry that is sending now or gone', async () => {
    state.entries = { A: [{ id: '1', appAccountId: 'A', jmapAccountId: 'jA', state: 'sending', outgoing: {} }] };
    await expect(saveEntryAsDraft(e('queued'))).rejects.toThrow();
    state.entries = { A: [] };
    await expect(saveEntryAsDraft(e('queued'))).rejects.toThrow();
    expect(calls).toEqual([]);
  });
});
