import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSecureFetch } = vi.hoisted(() => ({
  mockSecureFetch: vi.fn(),
}));

vi.mock('../client-cert', () => ({
  secureFetch: mockSecureFetch,
}));

import { forgetRefreshRotations, refreshOAuthAccessToken, resetRefreshRotations, type OAuthTokens } from '../oauth';

describe('oauth token refresh deduplication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRefreshRotations();
  });

  it('should only send a single HTTP request when refreshOAuthAccessToken is called concurrently with the same refresh token', async () => {
    const tokens: OAuthTokens = {
      accessToken: 'old-access',
      refreshToken: 'same-refresh-token',
      expiresAt: 123456,
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-id-123',
    };

    // Set up a mock response that takes a brief moment to resolve
    mockSecureFetch.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'new-access-token',
          refresh_token: 'rotated-refresh-token',
          expires_in: 3600,
        }),
      } as Response;
    });

    // Fire two refreshes concurrently
    const [res1, res2] = await Promise.all([
      refreshOAuthAccessToken(tokens),
      refreshOAuthAccessToken(tokens),
    ]);

    // Check that secureFetch was called exactly once
    expect(mockSecureFetch).toHaveBeenCalledTimes(1);

    // Verify both calls received the exact same updated token bundle
    expect(res1.accessToken).toBe('new-access-token');
    expect(res1.refreshToken).toBe('rotated-refresh-token');
    expect(res2.accessToken).toBe('new-access-token');
    expect(res2.refreshToken).toBe('rotated-refresh-token');

    // A holder that still has the rotated-away token later gets its
    // successor: presenting it again would revoke the grant on Stalwart 1.0.
    mockSecureFetch.mockClear();
    const res3 = await refreshOAuthAccessToken(tokens);
    expect(mockSecureFetch).not.toHaveBeenCalled();
    expect(res3.accessToken).toBe('new-access-token');
    expect(res3.refreshToken).toBe('rotated-refresh-token');
  });

  it('refreshes again with the successor once its access token runs out, never with the old token', async () => {
    const tokens: OAuthTokens = {
      accessToken: 'a1',
      refreshToken: 'r1',
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'swc1.x',
    };
    let generation = 1;
    mockSecureFetch.mockImplementation(async () => {
      generation += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: `a${generation}`, refresh_token: `r${generation}`, expires_in: 30 }),
      } as Response;
    });

    await refreshOAuthAccessToken(tokens);
    // 30 s left on the successor: not enough to hand out, so it is renewed.
    const res = await refreshOAuthAccessToken(tokens);

    const presented = mockSecureFetch.mock.calls.map(([, init]) => new URLSearchParams(String(init.body)).get('refresh_token'));
    expect(presented).toEqual(['r1', 'r2']);
    expect(res.refreshToken).toBe('r3');
  });

  it('forgets the whole chain of a signed-out account, from any of its tokens', async () => {
    const tokens: OAuthTokens = {
      accessToken: 'a1',
      refreshToken: 'r1',
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'swc1.x',
    };
    let generation = 1;
    mockSecureFetch.mockImplementation(async () => {
      generation += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: `a${generation}`, refresh_token: `r${generation}`, expires_in: 3600 }),
      } as Response;
    });
    // Another account's chain: q1 -> r2.
    const other = await refreshOAuthAccessToken({ ...tokens, accessToken: 'b1', refreshToken: 'q1' });
    // This account's: r1 -> r3 -> r4.
    await refreshOAuthAccessToken(tokens);
    await refreshOAuthAccessToken({ ...tokens, accessToken: 'a3', refreshToken: 'r3', expiresAt: Date.now() });

    // Sign-out reads the stored bundle, which may sit anywhere in the chain.
    forgetRefreshRotations('r3');
    mockSecureFetch.mockClear();
    mockSecureFetch.mockResolvedValue({ ok: false, status: 400 } as Response);

    // A stale copy no longer gets a successor out of memory.
    await expect(refreshOAuthAccessToken(tokens)).rejects.toThrow('400');
    expect(mockSecureFetch).toHaveBeenCalledTimes(1);
    // The other account's chain stays.
    mockSecureFetch.mockClear();
    expect((await refreshOAuthAccessToken({ ...tokens, accessToken: 'b1', refreshToken: 'q1' })).accessToken).toBe(other.accessToken);
    expect(mockSecureFetch).not.toHaveBeenCalled();
  });

  it('keeps refreshing with the same token on a server that does not rotate', async () => {
    const tokens: OAuthTokens = {
      accessToken: 'a1',
      refreshToken: 'stable',
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'bulwark-webmail',
    };
    mockSecureFetch.mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'a2', expires_in: 3600 }),
    }) as Response);

    await refreshOAuthAccessToken(tokens);
    await refreshOAuthAccessToken(tokens);

    expect(mockSecureFetch).toHaveBeenCalledTimes(2);
  });

  it('should propagate errors to all waiters if the HTTP request fails', async () => {
    const tokens: OAuthTokens = {
      accessToken: 'old-access',
      refreshToken: 'failing-refresh-token',
      expiresAt: 123456,
      tokenEndpoint: 'https://auth.example.com/token',
      clientId: 'client-id-123',
    };

    mockSecureFetch.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        ok: false,
        status: 400,
      } as Response;
    });

    // Fire two refreshes concurrently and check that both reject with the same error
    const promise1 = refreshOAuthAccessToken(tokens);
    const promise2 = refreshOAuthAccessToken(tokens);

    await expect(promise1).rejects.toThrow('Token refresh failed: 400');
    await expect(promise2).rejects.toThrow('Token refresh failed: 400');

    expect(mockSecureFetch).toHaveBeenCalledTimes(1);
  });
});
