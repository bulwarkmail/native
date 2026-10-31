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
}));

import type { Email } from '../../api/types';
import { getThreadsHeaders } from '../../api/email';
import { clearEmailDetailCache, loadThread, peekThread, rememberRows } from '../email-detail-cache';
import { draftThreadOf, refreshDraftThread } from '../draft-thread-refresh';
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
