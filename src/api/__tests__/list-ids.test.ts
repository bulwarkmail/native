import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../jmap-client', () => ({
  jmapClient: {
    accountId: 'primary',
    request: vi.fn(),
    getMaxObjectsInGet: vi.fn(() => 2),
  },
}));

import { jmapClient } from '../jmap-client';
import { fetchListIds } from '../list-ids';

const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

const ok = (list: Array<Record<string, unknown>>) => ({ methodResponses: [['Email/get', { list }, '0']] });

describe('fetchListIds', () => {
  it('asks for both header forms of the given ids in the given account', async () => {
    mockRequest.mockResolvedValueOnce(ok([{ id: 'e1', 'header:List-Id:asText': 'News <news.acme.com>' }]));
    const found = await fetchListIds(['e1'], 'shared-1');
    expect(mockRequest).toHaveBeenCalledWith([
      ['Email/get', {
        accountId: 'shared-1',
        ids: ['e1'],
        properties: ['id', 'header:List-Id:asText', 'header:List-Id'],
      }, '0'],
    ]);
    expect(found.get('e1')).toBe('news.acme.com');
  });

  it('falls back to the raw header when the text form is null (Stalwart)', async () => {
    mockRequest.mockResolvedValueOnce(ok([
      { id: 'e1', 'header:List-Id:asText': null, 'header:List-Id': ' <a.example.org>\r\n ' },
    ]));
    expect((await fetchListIds(['e1'], 'acc')).get('e1')).toBe('a.example.org');
  });

  it('maps a message without the header to null', async () => {
    mockRequest.mockResolvedValueOnce(ok([{ id: 'e1', 'header:List-Id:asText': null, 'header:List-Id': null }]));
    expect((await fetchListIds(['e1'], 'acc')).get('e1')).toBeNull();
  });

  it('splits the ids by the server limit', async () => {
    mockRequest
      .mockResolvedValueOnce(ok([{ id: 'a', 'header:List-Id:asText': '<x.org>' }, { id: 'b', 'header:List-Id:asText': '<x.org>' }]))
      .mockResolvedValueOnce(ok([{ id: 'c', 'header:List-Id:asText': '<y.org>' }]));
    const found = await fetchListIds(['a', 'b', 'c'], 'acc');
    expect(mockRequest).toHaveBeenCalledTimes(2);
    expect([...found.entries()]).toEqual([['a', 'x.org'], ['b', 'x.org'], ['c', 'y.org']]);
  });

  it('throws on a method error so the caller offers no list preset', async () => {
    mockRequest.mockResolvedValueOnce({ methodResponses: [['error', { type: 'serverFail' }, '0']] });
    await expect(fetchListIds(['e1'], 'acc')).rejects.toThrow();
  });
});
