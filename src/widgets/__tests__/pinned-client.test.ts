import { describe, expect, it, vi } from 'vitest';
import { pinToConnection } from '../pinned-client';

// A client stand-in with the two members the pin uses: the live connection's
// generation and `request`, which receives the pinned `gen`.
function fakeClient(gen: number) {
  const client = {
    connectionGen: gen,
    accountId: 'c',
    request: vi.fn(async (_calls: unknown, _using?: string[], _opts?: { gen?: number }) => ({ methodResponses: [] })),
  };
  return client;
}

describe('pinToConnection', () => {
  it('sends every request of a widget action with the generation it started on', async () => {
    const client = fakeClient(4);
    const pinned = pinToConnection(client as never);
    await pinned.request([['Email/get', {}, 'g']] as never);
    client.connectionGen = 5; // the app switched account mid-action
    await pinned.request([['Email/set', {}, 's']] as never, ['urn:ietf:params:jmap:mail']);
    expect(client.request).toHaveBeenNthCalledWith(1, [['Email/get', {}, 'g']], undefined, { gen: 4 });
    expect(client.request).toHaveBeenNthCalledWith(2, [['Email/set', {}, 's']], ['urn:ietf:params:jmap:mail'], { gen: 4 });
  });

  it('passes every other member through to the live client', () => {
    const client = fakeClient(1);
    const pinned = pinToConnection(client as never);
    expect((pinned as unknown as { accountId: string }).accountId).toBe('c');
    client.accountId = 'd';
    expect((pinned as unknown as { accountId: string }).accountId).toBe('d');
  });
});
