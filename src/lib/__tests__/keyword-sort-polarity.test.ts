import { describe, it, expect, vi, beforeEach } from 'vitest';

const request = vi.fn();
vi.mock('../../api/jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    serverUrl: 'https://mail.example.com',
    currentSession: { accounts: {} },
    request: (...args: unknown[]) => request(...args),
  },
}));

import {
  buildListSort,
  keywordSortSupported,
  markKeywordSortUnsupported,
  resetKeywordSortState,
  resolveKeywordSortPolarity,
} from '../keyword-sort-polarity';

function probeResponse(ascId: string, descId: string, seen: boolean) {
  return {
    methodResponses: [
      ['Email/query', { ids: [ascId] }, 'asc'],
      ['Email/query', { ids: [descId] }, 'desc'],
      ['Email/get', { list: [{ id: ascId, keywords: seen ? { $seen: true } : {} }] }, 'get'],
    ],
  };
}

beforeEach(() => {
  request.mockReset();
  resetKeywordSortState();
});

describe('keyword sort polarity probe', () => {
  it('detects an inverting server (Stalwart) and caches the verdict per account', async () => {
    request.mockResolvedValue(probeResponse('a', 'b', true));
    expect(await resolveKeywordSortPolarity('acc-1')).toBe('inverted');
    expect(await resolveKeywordSortPolarity('acc-1')).toBe('inverted');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('reads an RFC server and shares one in-flight probe', async () => {
    request.mockResolvedValue(probeResponse('a', 'b', false));
    const [p1, p2] = await Promise.all([resolveKeywordSortPolarity('acc-1'), resolveKeywordSortPolarity('acc-1')]);
    expect(p1).toBe('rfc');
    expect(p2).toBe('rfc');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('falls back to rfc without caching when the mailbox is homogeneous or the probe fails', async () => {
    request.mockResolvedValueOnce(probeResponse('a', 'a', true));
    expect(await resolveKeywordSortPolarity('acc-1')).toBe('rfc');
    request.mockRejectedValueOnce(new Error('boom'));
    resetKeywordSortState();
    expect(await resolveKeywordSortPolarity('acc-1')).toBe('rfc');
  });

  it('remembers unsupportedSort and drops keyword comparators from the list sort', async () => {
    request.mockResolvedValue({ methodResponses: [['error', { type: 'unsupportedSort' }, 'asc']] });
    await resolveKeywordSortPolarity('acc-1');
    expect(keywordSortSupported('acc-1')).toBe(false);
    const sort = await buildListSort('acc-1', [{ criterion: 'unread', direction: 'desc' }]);
    expect(sort).toEqual([{ property: 'receivedAt', isAscending: false }]);
  });
});

describe('buildListSort', () => {
  it('puts $pinned first with the probed polarity and honours the oldest-first toggle', async () => {
    request.mockResolvedValue(probeResponse('a', 'b', true));
    const sort = await buildListSort('acc-1', [{ criterion: 'unread', direction: 'desc' }], { dateAscending: true });
    expect(sort).toEqual([
      { property: 'hasKeyword', keyword: '$pinned', isAscending: true },
      { property: 'hasKeyword', keyword: '$seen', isAscending: false },
      { property: 'receivedAt', isAscending: true },
    ]);
  });

  it('skips the probe and the pinned comparator when nothing keyword-based is wanted', async () => {
    const sort = await buildListSort('acc-1', [], { pinnedFirst: false });
    expect(sort).toEqual([{ property: 'receivedAt', isAscending: false }]);
    expect(request).not.toHaveBeenCalled();
  });
});

// The verdict used to live in memory only, so every start probed again.
describe('stored verdicts', () => {
  // A fresh launch: the module's memory is gone, AsyncStorage is not.
  async function relaunch() {
    vi.resetModules();
    return import('../keyword-sort-polarity');
  }

  it('reuses a verdict from an earlier start without probing', async () => {
    request.mockResolvedValue(probeResponse('a', 'b', true));
    expect(await resolveKeywordSortPolarity('acc-1')).toBe('inverted');
    await new Promise((r) => setTimeout(r, 0));

    const next = await relaunch();
    expect(await next.resolveKeywordSortPolarity('acc-1')).toBe('inverted');
    const sort = await next.buildListSort('acc-1', [{ criterion: 'unread', direction: 'desc' }]);
    expect(sort[0]).toEqual({ property: 'hasKeyword', keyword: '$pinned', isAscending: true });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('keeps verdicts per server and account', async () => {
    request.mockResolvedValue(probeResponse('a', 'b', true));
    await resolveKeywordSortPolarity('acc-1');
    await new Promise((r) => setTimeout(r, 0));

    const next = await relaunch();
    request.mockResolvedValue(probeResponse('a', 'b', false));
    expect(await next.resolveKeywordSortPolarity('acc-2')).toBe('rfc');
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('remembers a server that refuses keyword sorts', async () => {
    markKeywordSortUnsupported('acc-1');
    await new Promise((r) => setTimeout(r, 0));

    const next = await relaunch();
    const sort = await next.buildListSort('acc-1', [{ criterion: 'unread', direction: 'desc' }]);
    expect(sort).toEqual([{ property: 'receivedAt', isAscending: false }]);
    expect(request).not.toHaveBeenCalled();
  });

  it('probes again once the stored verdict is a week old', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      request.mockResolvedValue(probeResponse('a', 'b', true));
      await resolveKeywordSortPolarity('acc-1');
      await Promise.resolve();
      vi.setSystemTime(Date.now() + 7 * 24 * 60 * 60 * 1000);

      const next = await relaunch();
      request.mockResolvedValue(probeResponse('a', 'b', false));
      expect(await next.resolveKeywordSortPolarity('acc-1')).toBe('rfc');
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not store an inconclusive probe', async () => {
    request.mockResolvedValue(probeResponse('a', 'a', true));
    await resolveKeywordSortPolarity('acc-1');
    await new Promise((r) => setTimeout(r, 0));

    const next = await relaunch();
    await next.resolveKeywordSortPolarity('acc-1');
    expect(request).toHaveBeenCalledTimes(2);
  });
});
