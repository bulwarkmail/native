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
import { getEmailFlags, getFullEmailsWithState, getThreadHeaders } from '../email';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('viewer fetches', () => {
  it('lists a conversation from headers only, in thread order, without bodies', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [
        ['Thread/get', { list: [{ id: 't1', emailIds: ['a', 'gone', 'b'] }] }, '0'],
        ['Email/get', { state: 's9', list: [{ id: 'b', subject: 'Re: hi' }, { id: 'a', subject: 'hi' }] }, '1'],
      ],
    });

    const res = await getThreadHeaders('t1', 'group-1');

    expect(res.emailIds).toEqual(['a', 'b']);
    expect(res.list.map((e) => e.id)).toEqual(['a', 'b']);
    expect(res.state).toBe('s9');
    const [calls] = mockRequest.mock.calls[0];
    expect(calls[0]).toEqual(['Thread/get', { accountId: 'group-1', ids: ['t1'] }, '0']);
    const args = calls[1][1];
    expect(args.accountId).toBe('group-1');
    expect(args['#ids']).toEqual({ resultOf: '0', name: 'Thread/get', path: '/list/*/emailIds' });
    expect(args.properties).toContain('preview');
    expect(args.properties).toContain('sentAt');
    expect(args.properties).not.toContain('bodyValues');
    expect(args.fetchHTMLBodyValues).toBeUndefined();
  });

  it('checks keywords and folders without downloading bodies', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['Email/get', {
        state: 's2',
        list: [{ id: 'a', keywords: { $seen: true }, mailboxIds: { inbox: true } }],
        notFound: ['b'],
      }, '0']],
    });

    const res = await getEmailFlags(['a', 'b']);

    expect(res).toEqual({
      list: [{ id: 'a', keywords: { $seen: true }, mailboxIds: { inbox: true } }],
      notFound: ['b'],
      state: 's2',
    });
    const [[[, args]]] = mockRequest.mock.calls[0];
    expect(args).toEqual({ accountId: 'acc-1', ids: ['a', 'b'], properties: ['id', 'keywords', 'mailboxIds'] });
  });

  it('returns the Email state and the missing ids with the bodies', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [['Email/get', { state: 's3', list: [{ id: 'a', bodyValues: {} }], notFound: ['b'] }, '0']],
    });

    const res = await getFullEmailsWithState(['a', 'b']);

    expect(res.list.map((e) => e.id)).toEqual(['a']);
    expect(res.notFound).toEqual(['b']);
    expect(res.state).toBe('s3');
    const [[[, args]]] = mockRequest.mock.calls[0];
    expect(args.fetchHTMLBodyValues).toBe(true);
  });
});
