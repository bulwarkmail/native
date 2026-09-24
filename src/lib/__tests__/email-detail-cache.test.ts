import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api/jmap-client', () => ({
  jmapClient: { accountId: 'own', serverUrl: 'https://mail.example', username: 'me' },
}));

vi.mock('../../api/email', () => ({
  getFullEmailsWithState: vi.fn(),
  getEmailFlags: vi.fn(),
  getThreadHeaders: vi.fn(),
}));

import type { Email } from '../../api/types';
import { getEmailFlags, getFullEmailsWithState, getThreadHeaders } from '../../api/email';
import { useOfflineCacheStore } from '../../stores/offline-cache-store';
import { dispatchStateChange } from '../state-change-bus';
import {
  clearEmailDetailCache, loadDetail, loadDetails, loadThread, needsRevalidation, noteEmailState,
  patchDetail, peekDetail, peekRow, peekThread, prefetchMessage, rememberRows, subscribeEmailCache,
} from '../email-detail-cache';

const fullGet = getFullEmailsWithState as ReturnType<typeof vi.fn>;
const flagsGet = getEmailFlags as ReturnType<typeof vi.fn>;
const threadGet = getThreadHeaders as ReturnType<typeof vi.fn>;

function full(id: string, keywords: Record<string, boolean> = {}): Email {
  return {
    id,
    threadId: `t-${id}`,
    mailboxIds: { inbox: true },
    keywords,
    size: 10,
    receivedAt: '2026-09-01T10:00:00Z',
    hasAttachment: false,
    htmlBody: [{ partId: '1', type: 'text/html' }],
    textBody: [],
    bodyValues: { 1: { value: `<p>${id}</p>` } },
  } as unknown as Email;
}

function fullResponse(emails: Email[], state = 's1', notFound: string[] = []) {
  return { list: emails, notFound, state };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(async () => {
  vi.clearAllMocks();
  clearEmailDetailCache();
  await useOfflineCacheStore.getState().setAccount(null);
  await useOfflineCacheStore.getState().setAccount('login-1');
  await useOfflineCacheStore.getState().clearAll();
});

describe('needsRevalidation', () => {
  const copy = { keywords: { $seen: true }, mailboxIds: { inbox: true } };

  it('trusts a copy read at the current Email state', () => {
    expect(needsRevalidation(copy, 's1', 's1')).toBe(false);
  });

  it('checks a copy when the state moved on or is unknown', () => {
    expect(needsRevalidation(copy, 's1', 's2')).toBe(true);
    expect(needsRevalidation(copy, 's1', undefined)).toBe(true);
    expect(needsRevalidation(copy, undefined, 's1')).toBe(true);
  });

  it('checks a copy the list row disagrees with', () => {
    expect(needsRevalidation(copy, 's1', 's1', { keywords: {} })).toBe(true);
    expect(needsRevalidation(copy, 's1', 's1', { mailboxIds: { archive: true } })).toBe(true);
    // False-valued keywords are the same as absent ones.
    expect(needsRevalidation(copy, 's1', 's1', { keywords: { $seen: true, $flagged: false } })).toBe(false);
  });
});

describe('loading a message', () => {
  it('downloads a message it does not hold, once for concurrent loads', async () => {
    fullGet.mockResolvedValue(fullResponse([full('e1')]));

    const [a, b] = await Promise.all([loadDetail('e1'), loadDetail('e1')]);

    expect(fullGet).toHaveBeenCalledTimes(1);
    expect(fullGet).toHaveBeenCalledWith(['e1'], undefined);
    expect(a).toBe(b);
    expect(peekDetail('e1')).toBe(a);
  });

  it('serves a copy read at the current state without asking the server', async () => {
    fullGet.mockResolvedValue(fullResponse([full('e1')], 's1'));
    const first = await loadDetail('e1');

    const again = await loadDetail('e1', undefined, { keywords: {}, mailboxIds: { inbox: true } });

    expect(again).toBe(first);
    expect(fullGet).toHaveBeenCalledTimes(1);
    expect(flagsGet).not.toHaveBeenCalled();
  });

  it('only rechecks keywords and folders once the account state moved on', async () => {
    fullGet.mockResolvedValue(fullResponse([full('e1')], 's1'));
    const first = await loadDetail('e1');
    dispatchStateChange({ '@type': 'StateChange', changed: { own: { Email: 's2' } } } as never);
    flagsGet.mockResolvedValue({ list: [{ id: 'e1', keywords: { $seen: true }, mailboxIds: { inbox: true } }], notFound: [], state: 's2' });

    const checked = await loadDetail('e1');

    expect(fullGet).toHaveBeenCalledTimes(1);
    expect(flagsGet).toHaveBeenCalledWith(['e1'], undefined);
    expect(checked.keywords).toEqual({ $seen: true });
    expect(checked.bodyValues).toBe(first.bodyValues);
    // Now current again: no further request.
    await loadDetail('e1');
    expect(flagsGet).toHaveBeenCalledTimes(1);
  });

  it('keeps the same object when the recheck finds nothing new', async () => {
    fullGet.mockResolvedValue(fullResponse([full('e1', { $seen: true })], 's1'));
    const first = await loadDetail('e1');
    noteEmailState(undefined, 's2');
    flagsGet.mockResolvedValue({ list: [{ id: 'e1', keywords: { $seen: true }, mailboxIds: { inbox: true } }], notFound: [], state: 's2' });

    expect(await loadDetail('e1')).toBe(first);
  });

  it('rechecks when the list row disagrees even at the same state', async () => {
    fullGet.mockResolvedValue(fullResponse([full('e1', { $seen: true })], 's1'));
    await loadDetail('e1');
    // Marked unread from the list before the push for it arrived.
    flagsGet.mockResolvedValue({ list: [{ id: 'e1', keywords: {}, mailboxIds: { inbox: true } }], notFound: [], state: 's2' });

    const checked = await loadDetail('e1', undefined, { keywords: {} });

    expect(flagsGet).toHaveBeenCalledTimes(1);
    expect(checked.keywords).toEqual({});
  });

  it('shows the held copy when the recheck fails', async () => {
    fullGet.mockResolvedValue(fullResponse([full('e1')], 's1'));
    const first = await loadDetail('e1');
    noteEmailState(undefined, 's2');
    flagsGet.mockRejectedValue(new Error('offline'));

    expect(await loadDetail('e1')).toBe(first);
  });

  it('drops a held copy the server says is gone', async () => {
    fullGet.mockResolvedValue(fullResponse([full('e1')], 's1'));
    await loadDetail('e1');
    noteEmailState(undefined, 's2');
    flagsGet.mockResolvedValue({ list: [], notFound: ['e1'], state: 's2' });

    await expect(loadDetail('e1')).rejects.toThrow('not found');
    expect(peekDetail('e1')).toBeUndefined();
  });

  it('rejects with the fetch error when nothing is held', async () => {
    fullGet.mockRejectedValue(new Error('boom'));
    await expect(loadDetail('e1')).rejects.toThrow('boom');
    fullGet.mockResolvedValue(fullResponse([], 's1', ['e2']));
    await expect(loadDetail('e2')).rejects.toThrow('not found');
  });

  it('shows the offline copy first and then only rechecks it', async () => {
    const offline = full('e1');
    await useOfflineCacheStore.getState().put(offline, 100);
    let release!: () => void;
    flagsGet.mockReturnValue(new Promise((resolve) => {
      release = () => resolve({ list: [{ id: 'e1', keywords: { $flagged: true }, mailboxIds: { inbox: true } }], notFound: [], state: 's3' });
    }));

    const pending = loadDetail('e1');
    await flush();
    expect(peekDetail('e1')?.id).toBe('e1');
    release();
    const checked = await pending;

    expect(fullGet).not.toHaveBeenCalled();
    expect(checked.keywords).toEqual({ $flagged: true });
    expect((await useOfflineCacheStore.getState().get('e1'))?.keywords).toEqual({ $flagged: true });
  });

  it('batches what it holds and what it lacks into one request each', async () => {
    fullGet.mockResolvedValueOnce(fullResponse([full('a'), full('b')], 's1'));
    await loadDetails(['a', 'b']);
    noteEmailState(undefined, 's2');
    // `a` is current again after this recheck; `b` too; `c` and `d` are new.
    flagsGet.mockResolvedValue({
      list: [{ id: 'a', keywords: {}, mailboxIds: { inbox: true } }, { id: 'b', keywords: {}, mailboxIds: { inbox: true } }],
      notFound: [],
      state: 's2',
    });
    fullGet.mockResolvedValueOnce(fullResponse([full('c'), full('d')], 's2'));

    const got = await loadDetails(['a', 'b', 'c', 'd', 'c']);

    expect([...got.keys()].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(flagsGet).toHaveBeenCalledTimes(1);
    expect(flagsGet).toHaveBeenCalledWith(['a', 'b'], undefined);
    expect(fullGet).toHaveBeenCalledTimes(2);
    expect(fullGet).toHaveBeenLastCalledWith(['c', 'd'], undefined);
  });

  it('keeps messages of different accounts apart', async () => {
    fullGet.mockImplementation(async (ids: string[], accountId?: string) =>
      fullResponse(ids.map((id) => ({ ...full(id), subject: accountId ?? 'own' })), 's1'));

    await loadDetail('e1');
    await loadDetail('e1', 'group');

    expect(fullGet).toHaveBeenCalledTimes(2);
    expect(peekDetail('e1')?.subject).toBe('own');
    expect(peekDetail('e1', 'group')?.subject).toBe('group');
    // Naming the own account explicitly is the same account.
    expect(peekDetail('e1', 'own')?.subject).toBe('own');
  });

  it('tells subscribers when a copy arrives or changes', async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeEmailCache(listener);
    fullGet.mockResolvedValue(fullResponse([full('e1')], 's1'));
    await loadDetail('e1');
    expect(listener).toHaveBeenCalled();
    listener.mockClear();

    patchDetail('e1', undefined, { keywords: { $flagged: true } });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(peekDetail('e1')?.keywords).toEqual({ $flagged: true });
    unsubscribe();
  });
});

describe('loading a conversation', () => {
  const headers = (ids: string[]) => ids.map((id) => ({ id, threadId: 't1', keywords: {}, mailboxIds: {} }));

  it('fetches member headers once for concurrent loads and keeps them', async () => {
    threadGet.mockResolvedValue({ emailIds: ['m1', 'm2'], list: headers(['m1', 'm2']), state: 's1' });

    const [a, b] = await Promise.all([loadThread('t1'), loadThread('t1')]);

    expect(threadGet).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(peekThread('t1')?.ids).toEqual(['m1', 'm2']);
    // Current state: served from memory.
    await loadThread('t1');
    expect(threadGet).toHaveBeenCalledTimes(1);
  });

  it('refetches a conversation once the state moved on, keeping it if that fails', async () => {
    threadGet.mockResolvedValueOnce({ emailIds: ['m1'], list: headers(['m1']), state: 's1' });
    await loadThread('t1');
    noteEmailState(undefined, 's2');
    threadGet.mockRejectedValueOnce(new Error('offline'));

    const view = await loadThread('t1');

    expect(threadGet).toHaveBeenCalledTimes(2);
    expect(view.ids).toEqual(['m1']);
  });

  it('brings a member copy held from an earlier open up to date with the headers', async () => {
    fullGet.mockResolvedValue(fullResponse([full('m1', { $seen: true })], 's1'));
    const held = await loadDetail('m1');
    threadGet.mockResolvedValue({
      emailIds: ['m1'],
      list: [{ id: 'm1', threadId: 't1', keywords: {}, mailboxIds: { inbox: true } }],
      state: 's2',
    });

    await loadThread('t1');

    expect(peekDetail('m1')?.keywords).toEqual({});
    expect(peekDetail('m1')?.bodyValues).toBe(held.bodyValues);
  });

  it('applies local keyword changes to the conversation headers too', async () => {
    threadGet.mockResolvedValue({ emailIds: ['m1'], list: headers(['m1']), state: 's1' });
    await loadThread('t1');

    patchDetail('m1', undefined, { keywords: { $seen: true } });

    expect(peekThread('t1')?.headers.get('m1')?.keywords).toEqual({ $seen: true });
  });
});

describe('prefetchMessage', () => {
  it('starts the body and the conversation so the viewer joins them', async () => {
    fullGet.mockResolvedValue(fullResponse([full('e1')], 's1'));
    threadGet.mockResolvedValue({ emailIds: ['e1'], list: headers1(), state: 's1' });

    prefetchMessage({ id: 'e1', threadId: 't-e1', keywords: {}, mailboxIds: { inbox: true } });
    await Promise.all([loadDetail('e1'), loadThread('t-e1')]);

    expect(fullGet).toHaveBeenCalledTimes(1);
    expect(threadGet).toHaveBeenCalledTimes(1);
  });

  it('remembers the tapped row so the viewer can paint its header', () => {
    fullGet.mockReturnValue(new Promise(() => undefined));
    threadGet.mockReturnValue(new Promise(() => undefined));
    const row = { ...full('e1'), subject: 'Lunch?', bodyValues: undefined } as Email;

    prefetchMessage(row, 'group');

    expect(peekRow('e1', 'group')?.subject).toBe('Lunch?');
    expect(peekRow('e1')).toBeUndefined();
  });

  it('does not remember a bare id as a row', () => {
    fullGet.mockReturnValue(new Promise(() => undefined));
    rememberRows([{ id: 'e9', threadId: 't9' } as Email]);
    expect(peekRow('e9')).toBeUndefined();
  });

  function headers1() {
    return [{ id: 'e1', threadId: 't-e1', keywords: {}, mailboxIds: {} }];
  }
});
