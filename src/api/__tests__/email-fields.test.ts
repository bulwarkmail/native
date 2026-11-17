import { describe, it, expect, vi } from 'vitest';
import { ownMailTarget, queryEmailFields } from '../email-fields';

function server(total: number, maxObjectsInGet = 500) {
  const request = vi.fn(async (calls: [string, Record<string, any>, string][]) => {
    const { position, limit } = calls[0][1];
    const ids = Array.from({ length: Math.max(0, Math.min(limit, total - position)) }, (_, i) => `m${position + i}`);
    return {
      methodResponses: [
        ['Email/query', { ids }, '0'],
        ['Email/get', { list: ids.map((id) => ({ id })) }, '1'],
      ],
    };
  });
  return { client: { request, accountId: 'own', getMaxObjectsInGet: () => maxObjectsInGet }, request };
}

describe('reading the fields of the mail a filter finds', () => {
  it('pages through the matches, newest first, until the limit', async () => {
    const { client, request } = server(1200);
    const records = await queryEmailFields(client as never, { from: 'x' }, ['from'], undefined, 1000);
    expect(records).toHaveLength(1000);
    expect(request).toHaveBeenCalledTimes(2);
    const [query, get] = request.mock.calls[0][0];
    expect(query).toEqual(['Email/query', {
      accountId: 'own', filter: { from: 'x' }, sort: [{ property: 'receivedAt', isAscending: false }], position: 0, limit: 500,
    }, '0']);
    expect(get[1]).toEqual({ accountId: 'own', '#ids': { resultOf: '0', name: 'Email/query', path: '/ids' }, properties: ['id', 'from'] });
    expect(request.mock.calls[1][0][0][1]).toMatchObject({ position: 500, limit: 500 });
  });

  it('stops at the last match and asks the account it is given', async () => {
    const { client, request } = server(3, 2);
    const records = await queryEmailFields(client as never, {}, [], 'shared', 100);
    expect(records.map((r) => r.id)).toEqual(['m0', 'm1', 'm2']);
    expect(request.mock.calls[0][0][0][1].accountId).toBe('shared');
  });

  it('says why when the server refuses the search', async () => {
    const request = vi.fn(async () => ({ methodResponses: [['error', { type: 'unsupportedFilter', description: 'no body search' }, '0']] }));
    await expect(queryEmailFields({ request, accountId: 'own', getMaxObjectsInGet: () => 500 } as never, {}, [], undefined, 10))
      .rejects.toThrow('no body search');
  });
});

describe('the mail a rule is previewed and applied on', () => {
  it('can be set up before the session is, and uses the account connected when it runs', async () => {
    const { client, request } = server(3);
    let account: string | null = null;
    Object.defineProperty(client, 'accountId', {
      get: () => {
        if (!account) throw new Error('Not authenticated - call connect() first');
        return account;
      },
    });
    const inbox = { id: 'inbox', role: 'inbox' } as never;
    const target = ownMailTarget(client as never, [inbox]);
    expect(target.mailboxes).toEqual([inbox]);
    expect(() => target.accountId).toThrow('Not authenticated');
    account = 'first';
    await target.client.queryEmailFields({}, ['from'], target.accountId);
    account = 'second';
    await target.client.queryEmailFields({}, ['from'], target.accountId);
    expect(request.mock.calls.map((call) => call[0][0][1].accountId)).toEqual(['first', 'second']);
  });
});
