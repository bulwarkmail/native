import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'acc-1',
    request: vi.fn(),
    hasCapability: vi.fn(),
    getMaxObjectsInSet: vi.fn(() => 2),
  },
}));

import { jmapClient } from '../jmap-client';
import { getShareNotifications, destroyShareNotifications } from '../share-notifications';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;
const mockCap = jmapClient.hasCapability as ReturnType<typeof vi.fn>;
const client = jmapClient as unknown as { accountId: string };

beforeEach(() => {
  vi.clearAllMocks();
  client.accountId = 'acc-1';
  mockCap.mockImplementation((urn: string) => urn === 'urn:ietf:params:jmap:principals');
});

describe('getShareNotifications', () => {
  it('queries created ascending with a back-referenced get on the own account', async () => {
    mockRequest.mockResolvedValue({
      methodResponses: [
        ['ShareNotification/query', { ids: ['s1'] }, '0'],
        ['ShareNotification/get', { list: [{ id: 's1', objectType: 'Calendar' }] }, '1'],
      ],
    });
    expect(await getShareNotifications()).toEqual([{ id: 's1', objectType: 'Calendar' }]);
    const [calls, using] = mockRequest.mock.calls[0];
    expect(using).toEqual(['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:principals']);
    expect(calls[0]).toEqual(['ShareNotification/query', {
      accountId: 'acc-1',
      sort: [{ property: 'created', isAscending: true }],
    }, '0']);
    expect(calls[1]).toEqual(['ShareNotification/get', {
      accountId: 'acc-1',
      '#ids': { resultOf: '0', name: 'ShareNotification/query', path: '/ids' },
    }, '1']);
  });

  it('asks for nothing when the server has no principals capability', async () => {
    mockCap.mockReturnValue(false);
    expect(await getShareNotifications()).toEqual([]);
    expect(mockRequest).not.toHaveBeenCalled();
  });

  it('throws when the server answers with an error', async () => {
    mockRequest.mockResolvedValue({ methodResponses: [['error', { description: 'nope' }, '0']] });
    await expect(getShareNotifications()).rejects.toThrow('nope');
  });
});

describe('destroyShareNotifications', () => {
  it('destroys in batches of the server limit on the given account', async () => {
    mockRequest.mockResolvedValue({ methodResponses: [] });
    await destroyShareNotifications(['a', 'b', 'c'], 'acc-1');
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect(mockRequest.mock.calls[0][0]).toEqual([['ShareNotification/set', { accountId: 'acc-1', destroy: ['a', 'b'] }, '0']]);
    expect(mockRequest.mock.calls[1][0]).toEqual([['ShareNotification/set', { accountId: 'acc-1', destroy: ['c'] }, '0']]);
    expect(mockRequest.mock.calls[0][1]).toEqual(['urn:ietf:params:jmap:core', 'urn:ietf:params:jmap:principals']);
  });

  it('sends nothing when the client serves another JMAP account', async () => {
    client.accountId = 'acc-2';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await destroyShareNotifications(['a'], 'acc-1');
    expect(mockRequest).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('re-checks the serving guard before every batch', async () => {
    let serving = true;
    mockRequest.mockImplementation(async () => { serving = false; return { methodResponses: [] }; });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await destroyShareNotifications(['a', 'b', 'c'], 'acc-1', () => serving);
    expect(mockRequest).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('sends nothing without the principals capability or ids', async () => {
    await destroyShareNotifications([], 'acc-1');
    mockCap.mockReturnValue(false);
    await destroyShareNotifications(['a'], 'acc-1');
    expect(mockRequest).not.toHaveBeenCalled();
  });
});
