// A new reply draft didn't show in its conversation until pull-to-refresh.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../api/jmap-client', () => ({
  jmapClient: { accountId: 'own', serverUrl: 'https://mail.example', username: 'me' },
}));

vi.mock('../../api/email', () => ({
  getFullEmailsWithState: vi.fn(),
  getEmailFlags: vi.fn(),
  getThreadsHeaders: vi.fn(),
  destroyEmails: vi.fn(async () => undefined),
}));

import type { Email } from '../../api/types';
import { destroyEmails, getThreadsHeaders } from '../../api/email';
import { clearEmailDetailCache, loadThread, peekThread, rememberRows } from '../email-detail-cache';
import { discardDraft, draftThreadOf, refreshDraftThread } from '../draft-thread-refresh';
import { useEmailStore } from '../../stores/email-store';

const threadGet = getThreadsHeaders as ReturnType<typeof vi.fn>;

function threadResponse(threadId: string, ids: string[], state = 's1') {
  const list = ids.map((id) => ({ id, threadId, keywords: {}, mailboxIds: { inbox: true } }));
  return { threads: { [threadId]: { emailIds: ids, list } }, notFound: [], state };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearEmailDetailCache();
  useEmailStore.setState({ threadCounts: {} });
});

describe('a saved reply draft in its conversation', () => {
  it('finds the conversation of the message being answered', () => {
    rememberRows([{ id: 'm1', threadId: 't1', receivedAt: '2026-10-01T10:00:00Z' } as Email]);
    expect(draftThreadOf({ replyTo: { originalEmailId: 'm1' } })).toEqual({ threadId: 't1', accountId: undefined });
    expect(draftThreadOf({ replyTo: { originalEmailId: 'unknown' } })).toBeNull();
  });

  it('reads the conversation again although the Email state has not moved', async () => {
    threadGet.mockResolvedValueOnce(threadResponse('t1', ['m1']));
    await loadThread('t1');
    useEmailStore.setState({ threadCounts: { t1: 1 } });

    // Held and current as far as the cache knows: a plain load answers from it.
    await loadThread('t1');
    expect(threadGet).toHaveBeenCalledTimes(1);

    threadGet.mockResolvedValueOnce(threadResponse('t1', ['m1', 'draft1']));
    await refreshDraftThread({ threadId: 't1' });

    expect(threadGet).toHaveBeenCalledTimes(2);
    expect(peekThread('t1')?.ids).toEqual(['m1', 'draft1']);
    expect(useEmailStore.getState().threadCounts.t1).toBe(2);
  });

  it('is asked for by the composer after each save', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../screens/ComposeScreen.tsx'), 'utf8');
    expect(src).toMatch(/setDraftStatus\('saved'\);[\s\S]{0,300}refreshDraftThread\(thread\)/);
  });
});

describe('a discarded reply draft', () => {
  const destroy = destroyEmails as ReturnType<typeof vi.fn>;

  it('leaves the reader and the list count of its conversation', async () => {
    rememberRows([{ id: 'm1', threadId: 't1', receivedAt: '2026-10-01T10:00:00Z' } as Email]);
    threadGet.mockResolvedValueOnce(threadResponse('t1', ['m1', 'draft1']));
    await loadThread('t1');
    useEmailStore.setState({ threadCounts: { t1: 2 } });

    threadGet.mockResolvedValueOnce(threadResponse('t1', ['m1']));
    await discardDraft('draft1', undefined, draftThreadOf({ replyTo: { originalEmailId: 'm1' } }));

    expect(destroy).toHaveBeenCalledWith(['draft1'], undefined);
    expect(peekThread('t1')?.ids).toEqual(['m1']);
    expect(useEmailStore.getState().threadCounts.t1).toBe(1);
  });

  it('stays in it when the server refused the delete', async () => {
    threadGet.mockResolvedValueOnce(threadResponse('t1', ['m1', 'draft1']));
    await loadThread('t1');
    destroy.mockRejectedValueOnce(new Error('forbidden'));

    await expect(discardDraft('draft1', undefined, { threadId: 't1' })).rejects.toThrow('forbidden');

    expect(threadGet).toHaveBeenCalledTimes(1);
    expect(peekThread('t1')?.ids).toEqual(['m1', 'draft1']);
  });

  it('is how the composer discards, from the composer and from "Draft saved"', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../screens/ComposeScreen.tsx'), 'utf8');
    expect(src).not.toMatch(/destroyEmails\(/);
    expect(src.match(/discardDraft\(id, [\w.]+, draftThreadOf\(\{ replyTo, draft \}\)\)/g)).toHaveLength(2);
  });
});
