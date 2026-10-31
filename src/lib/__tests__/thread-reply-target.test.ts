import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

vi.mock('../../api/jmap-client', () => ({
  jmapClient: { accountId: 'acc-1', request: vi.fn(), hasDelayedSend: vi.fn(() => true) },
}));

import { jmapClient } from '../../api/jmap-client';
import { scheduledEmailIdsInThread } from '../../api/thread-scheduled';
import { isReplyableMember, quickReplyTarget } from '../thread-utils';

// Every card of a conversation offered Reply, and the quick reply answered
// the newest member even when that was the user's own draft or a reply
// waiting for its scheduled send (webmail 8b29254a6, #1404).

const msg = (id: string, keywords: Record<string, boolean> = {}) => ({ id, keywords });
const none = new Set<string>();

describe('replying in a conversation (bulwarkmail/webmail#1404)', () => {
  it('does not offer Reply on drafts and scheduled messages', () => {
    expect(isReplyableMember(msg('a'), none)).toBe(true);
    expect(isReplyableMember(msg('d', { $draft: true }), none)).toBe(false);
    expect(isReplyableMember(msg('s'), new Set(['s']))).toBe(false);
  });

  it('points the quick reply at the newest message that is neither', () => {
    const conversation = [msg('1'), msg('2'), msg('3'), msg('draft', { $draft: true })];
    expect(quickReplyTarget(conversation, none)?.id).toBe('3');
    expect(quickReplyTarget(conversation, new Set(['3']))?.id).toBe('2');
    expect(quickReplyTarget([msg('d', { $draft: true })], none)).toBeNull();
  });

  it('is wired into the conversation cards and the quick reply', () => {
    const screen = fs.readFileSync(path.resolve(__dirname, '../../screens/EmailThreadScreen.tsx'), 'utf8');
    expect(screen).toMatch(/replyActions=\{cardReplyActions\(m, !!full, scheduledIds\)\}/);
    expect(screen).toMatch(/const newest = quickReplyTarget\(/);
    expect(screen).toMatch(/scheduledEmailIdsInThread\(threadId, jmapAccountId\)/);
  });
});

describe('scheduledEmailIdsInThread', () => {
  const request = jmapClient.request as ReturnType<typeof vi.fn>;
  beforeEach(() => request.mockReset());

  it('keeps pending submissions whose send time is ahead', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    request.mockResolvedValue({
      methodResponses: [
        ['EmailSubmission/query', { ids: ['s1', 's2', 's3'] }, '0'],
        ['EmailSubmission/get', { list: [
          { emailId: 'e1', sendAt: future, undoStatus: 'pending' },
          { emailId: 'e2', sendAt: past, undoStatus: 'pending' },
          { emailId: 'e3', sendAt: future, undoStatus: 'canceled' },
        ] }, '1'],
      ],
    });
    expect([...await scheduledEmailIdsInThread('t1')]).toEqual(['e1']);
    const [[calls]] = request.mock.calls;
    expect(calls[0][1].filter).toEqual({ threadIds: ['t1'], undoStatus: 'pending' });
  });

  it('answers with nothing when the server refuses or the account cannot schedule', async () => {
    request.mockResolvedValue({ methodResponses: [['error', { type: 'unsupportedFilter' }, '0'], ['error', {}, '1']] });
    expect((await scheduledEmailIdsInThread('t1')).size).toBe(0);
    request.mockImplementationOnce(async () => { throw new Error('offline'); });
    expect((await scheduledEmailIdsInThread('t1')).size).toBe(0);
    (jmapClient.hasDelayedSend as ReturnType<typeof vi.fn>).mockReturnValue(false);
    request.mockClear();
    expect((await scheduledEmailIdsInThread('t1')).size).toBe(0);
    expect(request).not.toHaveBeenCalled();
  });
});
