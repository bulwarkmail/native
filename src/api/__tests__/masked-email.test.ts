import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ stalwart: true, moved: false }));

vi.mock('../jmap-client', () => {
  class AuthenticationError extends Error {}
  return {
    AuthenticationError,
    jmapClient: {
      connectedAccountId: 'personal' as string | null,
      isConnected: true,
      username: 'alice@example.test',
      serverUrl: 'https://mail.example.test',
      request: vi.fn(),
      hasAccountCapability: (urn: string, accountId: string) => state.stalwart && urn === 'urn:stalwart:jmap' && accountId === 'personal',
      getMaxObjectsInGet: () => 500,
    },
  };
});
vi.mock('../../lib/compose-login', () => ({ loginMovedFrom: () => state.moved }));

import { AuthenticationError, jmapClient } from '../jmap-client';
import { maskedEmailManagerForActiveLogin } from '../masked-email';

const client = jmapClient as unknown as { connectedAccountId: string | null; isConnected: boolean };
const mockRequest = jmapClient.request as ReturnType<typeof vi.fn>;
const answer = (name: string, result: unknown) => ({ methodResponses: [[name, result, 'masked']] });

beforeEach(() => {
  state.stalwart = true;
  state.moved = false;
  client.connectedAccountId = 'personal';
  client.isConnected = true;
  mockRequest.mockReset();
});

describe('maskedEmailManagerForActiveLogin', () => {
  it('is null unless the account lists Stalwart\'s extension and a login is served', () => {
    state.stalwart = false;
    expect(maskedEmailManagerForActiveLogin()).toBeNull();
    state.stalwart = true;
    client.connectedAccountId = null;
    expect(maskedEmailManagerForActiveLogin()).toBeNull();
    client.connectedAccountId = 'personal';
    client.isConnected = false;
    expect(maskedEmailManagerForActiveLogin()).toBeNull();
  });

  it('asks Stalwart itself, one call a request, naming its capability', async () => {
    mockRequest
      .mockResolvedValueOnce(answer('x:MaskedEmail/query', { accountId: 'personal', ids: [], total: 0 }))
      .mockResolvedValueOnce(answer('x:MaskedEmail/get', { accountId: 'personal', list: [] }));
    expect(await maskedEmailManagerForActiveLogin()!.list()).toEqual([]);
    expect(mockRequest.mock.calls.map(([calls, using]) => [calls.length, calls[0][0], calls[0][1].accountId, using])).toEqual([
      [1, 'x:MaskedEmail/query', 'personal', ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap']],
      [1, 'x:MaskedEmail/get', 'personal', ['urn:ietf:params:jmap:core', 'urn:stalwart:jmap']],
    ]);
  });

  it('throws a method error by its type, with the server\'s detail', async () => {
    mockRequest.mockResolvedValue(answer('error', { type: 'forbidden', description: 'Missing permission' }));
    await expect(maskedEmailManagerForActiveLogin()!.list()).rejects.toMatchObject({ type: 'forbidden', message: 'Missing permission' });
    mockRequest.mockResolvedValue(answer('error', {}));
    await expect(maskedEmailManagerForActiveLogin()!.list()).rejects.toMatchObject({ type: 'serverFail' });
  });

  it('rejects an answer to another method', async () => {
    mockRequest.mockResolvedValue(answer('x:MaskedEmail/get', { accountId: 'personal', list: [] }));
    await expect(maskedEmailManagerForActiveLogin()!.list()).rejects.toMatchObject({ type: 'invalidResponse' });
    mockRequest.mockResolvedValue({ methodResponses: [] });
    await expect(maskedEmailManagerForActiveLogin()!.list()).rejects.toMatchObject({ type: 'invalidResponse' });
  });

  it('tells an expired sign-in from a request that got no answer', async () => {
    mockRequest.mockRejectedValueOnce(new AuthenticationError('Session expired'));
    await expect(maskedEmailManagerForActiveLogin()!.list()).rejects.toMatchObject({ type: 'notAuthenticated' });
    mockRequest.mockRejectedValueOnce(new Error('Network request failed'));
    await expect(maskedEmailManagerForActiveLogin()!.list()).rejects.toThrow('Network request failed');
  });

  it('stops once another login or account is active', async () => {
    const manager = maskedEmailManagerForActiveLogin()!;
    expect(manager.isCurrent()).toBe(true);
    state.moved = true;
    expect(manager.isCurrent()).toBe(false);
    state.moved = false;
    client.connectedAccountId = 'other';
    expect(manager.isCurrent()).toBe(false);
    await expect(manager.list()).rejects.toMatchObject({ type: 'staleContext' });
    expect(mockRequest).not.toHaveBeenCalled();
  });
});
