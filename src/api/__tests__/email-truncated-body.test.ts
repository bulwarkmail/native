import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    getMaxObjectsInGet: vi.fn(() => 500),
    getMaxObjectsInSet: vi.fn(() => 500),
  },
}));

import { jmapClient } from '../jmap-client';
import { getFullEmail, getFullEmails, getThreadEmails } from '../email';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

// A 586 KB HTML report comes back from Stalwart as a 59-character stub (#884).
function report(id: string, truncated: boolean) {
  return {
    id,
    threadId: 't1',
    htmlBody: [{ partId: '1', type: 'text/html' }],
    textBody: [{ partId: '1', type: 'text/html' }],
    attachments: [{ partId: '3', type: 'text/csv', name: 'data.csv' }],
    bodyValues: {
      '1': truncated
        ? { value: '<h1>Quarterly report</h1><p>Summary of the</p>', isTruncated: true }
        : { value: '<h1>Quarterly report</h1><p>Summary of the quarter…</p>' },
      '3': { value: 'a,b', isTruncated: true },
    },
  };
}

const fullBody = { '1': { value: '<h1>Quarterly report</h1><p>Summary of the quarter, in full</p>' } };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('truncated body refetch (#884)', () => {
  it('refetches a truncated displayed part with a larger cap and keeps other values', async () => {
    mockRequest
      .mockResolvedValueOnce({ methodResponses: [['Email/get', { list: [report('e1', true)] }, '0']] })
      .mockResolvedValueOnce({ methodResponses: [['Email/get', { list: [{ id: 'e1', bodyValues: fullBody }] }, '0']] });

    const email = await getFullEmail('e1');

    expect(mockRequest).toHaveBeenCalledTimes(2);
    const [[method, args]] = mockRequest.mock.calls[1][0];
    expect(method).toBe('Email/get');
    expect(args).toMatchObject({
      accountId: 'acc-1',
      ids: ['e1'],
      properties: ['id', 'bodyValues'],
      fetchHTMLBodyValues: true,
      fetchTextBodyValues: true,
    });
    expect(args.maxBodyValueBytes).toBeGreaterThan(512000);
    // Text attachments are not pulled again at the larger cap.
    expect(args.fetchAllBodyValues).toBeUndefined();
    expect(email.bodyValues?.['1']).toEqual(fullBody['1']);
    expect(email.bodyValues?.['3']?.value).toBe('a,b');
  });

  it('does not refetch when only an attachment part is truncated', async () => {
    mockRequest.mockResolvedValueOnce({
      methodResponses: [['Email/get', { list: [report('e1', false)] }, '0']],
    });
    await getFullEmail('e1');
    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('keeps the truncated body when the refetch fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockRequest
      .mockResolvedValueOnce({ methodResponses: [['Email/get', { list: [report('e1', true)] }, '0']] })
      .mockRejectedValueOnce(new Error('offline'));

    const email = await getFullEmail('e1', 'shared-7');

    expect(mockRequest.mock.calls[1][0][0][1].accountId).toBe('shared-7');
    expect(email.bodyValues?.['1']?.isTruncated).toBe(true);
    warn.mockRestore();
  });

  it('refetches a thread in one batched call', async () => {
    mockRequest
      .mockResolvedValueOnce({
        methodResponses: [
          ['Thread/get', { list: [{ id: 't1', emailIds: ['e1', 'e2', 'e3'] }] }, '0'],
          ['Email/get', { list: [report('e1', true), report('e2', false), report('e3', true)] }, '1'],
        ],
      })
      .mockResolvedValueOnce({
        methodResponses: [['Email/get', {
          list: [{ id: 'e1', bodyValues: fullBody }, { id: 'e3', bodyValues: fullBody }],
        }, '0']],
      });

    const emails = await getThreadEmails('t1');

    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockRequest.mock.calls[1][0][0][1].ids).toEqual(['e1', 'e3']);
    expect(emails.map((e) => e.bodyValues?.['1']?.isTruncated ?? false)).toEqual([false, false, false]);
  });

  it('refetches truncated bodies for offline sync batches', async () => {
    mockRequest
      .mockResolvedValueOnce({
        methodResponses: [['Email/get', { list: [report('e1', false), report('e2', true)] }, '0']],
      })
      .mockResolvedValueOnce({
        methodResponses: [['Email/get', { list: [{ id: 'e2', bodyValues: fullBody }] }, '0']],
      });

    const emails = await getFullEmails(['e1', 'e2']);

    expect(mockRequest.mock.calls[1][0][0][1].ids).toEqual(['e2']);
    expect(emails[1].bodyValues?.['1']).toEqual(fullBody['1']);
  });
});
