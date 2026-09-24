import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    getMaxObjectsInGet: vi.fn(() => 2),
  },
}));

import { jmapClient } from '../jmap-client';
import { EMAIL_LIST_PROPERTIES, getEmailAttachments } from '../email';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;
type Call = [string, Record<string, unknown>, string];

beforeEach(() => {
  vi.clearAllMocks();
  mockRequest.mockImplementation(async ([[, args]]: Call[]) => ({
    methodResponses: [['Email/get', {
      list: (args.ids as string[])
        .filter((id) => id !== 'gone')
        .map((id) => ({ id, attachments: [{ blobId: `b-${id}`, type: 'application/pdf', name: `${id}.pdf` }] })),
    }, '0']],
  }));
});

describe('list attachment chips (webmail #1089)', () => {
  it('keeps attachments out of the list request', () => {
    // Stalwart parses every message's raw blob to answer `attachments`.
    expect(EMAIL_LIST_PROPERTIES).not.toContain('attachments');
    expect(EMAIL_LIST_PROPERTIES).toContain('hasAttachment');
  });

  it('asks only for attachment parts, in server-sized batches', async () => {
    const found = await getEmailAttachments(['a', 'b', 'c'], 'team');

    const calls = mockRequest.mock.calls.map(([[call]]) => call as Call);
    expect(calls.map(([, args]) => args.ids)).toEqual([['a', 'b'], ['c']]);
    expect(calls[0][0]).toBe('Email/get');
    expect(calls[0][1]).toMatchObject({ accountId: 'team', properties: ['id', 'attachments'] });
    expect(calls[0][1].bodyProperties).toEqual(
      expect.arrayContaining(['blobId', 'name', 'type', 'cid', 'disposition']),
    );
    expect(found.get('c')).toEqual([{ blobId: 'b-c', type: 'application/pdf', name: 'c.pdf' }]);
  });

  it("uses the active account by default and leaves out ids the server didn't return", async () => {
    const found = await getEmailAttachments(['a', 'gone']);

    expect(mockRequest.mock.calls[0][0][0][1].accountId).toBe('acc-1');
    expect([...found.keys()]).toEqual(['a']);
  });
});
